import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { Follow } from '../entities/follow.entity';
import { Organizer } from '../entities/organizer.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';
import { UpdateNotificationChannelsDto } from './participant/dto/update-notification-channels.dto';
import { CacheService } from '../common/cache/cache.service';
import { EmailService } from '../email/email.service';
import { dataExportEmail } from '../email/templates';

// Exported so ParticipantService (a separate service writing to the same `users` row via
// PATCH /participants/:id) can invalidate the same cache entry this module populates.
export const userMeCacheKey = (userId: string): string => `users:me:${userId}`;
const USER_ME_CACHE_TTL_SECONDS = 60;

export type CurrentUserResponse = {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  profilePictureUrl: string | null;
  isEmailVerified: boolean;
  bio: string | null;
  location: string | null;
  city: string;
  latitude: number | null;
  longitude: number | null;
  notificationPrefs: UpdateNotificationPrefsDto | null;
  pushEnabled: boolean;
  emailEnabled: boolean;
  roles: string[];
  interests: EventCategory[];
  hasCompletedOnboarding: boolean;
  // Count of organizers this user follows (the reverse of Organizer.followerCount). Shown
  // alongside Events/Saved/Bookings on the self-profile stat row.
  followingCount: number;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoryRepository: Repository<EventCategory>,
    @InjectRepository(Follow)
    private readonly followsRepository: Repository<Follow>,
    @InjectRepository(Organizer)
    private readonly organizerRepository: Repository<Organizer>,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    private readonly cache: CacheService,
    private readonly emailService: EmailService,
  ) {}

  // Participant-specific fields (city, etc.) are JSON-encoded in the `bio` column (see
  // ParticipantService.buildMeta) rather than dedicated columns. GET /participants/:id
  // decodes this but is admin-only (class-level @Roles('admin') on ParticipantController,
  // no method-level override on findOne) — a plain 'user' has no self-accessible way to
  // read these back otherwise, even though PATCH /participants/:id *is* self-accessible.
  // Decoding the same meta here keeps GET/PATCH self-service symmetric for a non-admin.
  private parseMeta(bio: string | null): Record<string, string> {
    try {
      return bio ? JSON.parse(bio) : {};
    } catch {
      return {};
    }
  }

  async findMe(userId: string): Promise<CurrentUserResponse> {
    const cacheKey = userMeCacheKey(userId);
    const cached = await this.cache.get<CurrentUserResponse>(cacheKey);
    if (cached) return cached;

    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['interests'],
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const meta = this.parseMeta(user.bio ?? null);
    const [firstName, ...lastNameParts] = (user.fullName || '').split(' ');
    const followingCount = await this.followsRepository.count({ where: { userId } });

    const response: CurrentUserResponse = {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? null,
      firstName: firstName || '',
      lastName: lastNameParts.join(' '),
      phoneNumber: user.phoneNumber ?? null,
      profilePictureUrl: user.profilePictureUrl ?? null,
      isEmailVerified: user.isEmailVerified,
      bio: user.bio ?? null,
      location: user.location ?? null,
      city: meta['city'] || '',
      latitude: user.latitude ?? null,
      longitude: user.longitude ?? null,
      notificationPrefs: user.notificationPrefs ?? null,
      pushEnabled: user.pushEnabled,
      emailEnabled: user.emailEnabled,
      roles: user.roles ?? [],
      interests: user.interests ?? [],
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      followingCount,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    await this.cache.set(cacheKey, response, USER_ME_CACHE_TTL_SECONDS);
    return response;
  }

  async updateInterests(userId: string, dto: UpdateInterestsDto): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['interests'],
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const categories = dto.categoryIds.length > 0
      ? await this.categoryRepository.findBy(dto.categoryIds.map((id) => ({ id })))
      : [];

    user.interests = categories;
    await this.usersRepository.save(user);
    await this.cache.del(userMeCacheKey(userId));
  }

  async updateLocation(userId: string, dto: UpdateLocationDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      latitude: dto.latitude,
      longitude: dto.longitude,
    });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.cache.del(userMeCacheKey(userId));
  }

  async updateNotificationPrefs(userId: string, dto: UpdateNotificationPrefsDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      notificationPrefs: dto,
    });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.cache.del(userMeCacheKey(userId));
  }

  // Re-registered on every app start/login (see the frontend's push-registration call
  // site) — one row per physical device/app-install (device_tokens), not one slot per
  // account, so a second device logging in no longer silently steals push notifications
  // from the first. A push token still uniquely identifies one physical device, so it must
  // never stay attached to more than one *account* at once — upserting on the unique
  // `token` column reassigns ownership atomically (evicts whoever else currently holds it
  // and attaches it to this user) in the same statement, covering a previous user's
  // session that merely expired or was force-closed rather than explicitly logged out.
  async updatePushToken(userId: string, pushToken: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.deviceTokenRepository.upsert(
      { userId, token: pushToken, lastUsedAt: new Date() },
      ['token'],
    );
  }

  // Called on logout so *this* signed-out device stops receiving this account's pushes,
  // without touching any of the account's other logged-in devices — scoped to the
  // specific token the caller is holding, not "every token this account has".
  async clearPushToken(userId: string, pushToken: string): Promise<void> {
    await this.deviceTokenRepository.delete({ userId, token: pushToken });
  }

  // Called from the last screen of the post-login onboarding chain (NotificationPreferences)
  // once interests/location/notification-prefs have all synced — the one-way flag that lets
  // future logins skip straight to Main instead of replaying the chain.
  async completeOnboarding(userId: string): Promise<void> {
    const result = await this.usersRepository.update(userId, { hasCompletedOnboarding: true });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.cache.del(userMeCacheKey(userId));
  }

  // Master per-transport switches behind SettingsScreen's "Push Notifications"/"Email
  // Notifications" toggles — checked by NotificationService before every send.
  async updateNotificationChannels(userId: string, dto: UpdateNotificationChannelsDto): Promise<void> {
    const update: Partial<Pick<User, 'pushEnabled' | 'emailEnabled'>> = {};
    if (dto.pushEnabled !== undefined) update.pushEnabled = dto.pushEnabled;
    if (dto.emailEnabled !== undefined) update.emailEnabled = dto.emailEnabled;

    const result = await this.usersRepository.update(userId, update);

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.cache.del(userMeCacheKey(userId));
  }

  // Self-service account deletion (Settings → Delete Account). Soft-deletes the user row
  // (same DeleteDateColumn mechanism AdminService's ban/remove tooling already relies on) —
  // JwtAuthGuard's live `withDeleted` lookup then rejects this account's still-valid token
  // on its very next request instead of waiting out the token's remaining TTL. Also
  // soft-deletes any Organizer profile(s) owned by this user: without that, an admin's
  // organizer list/detail queries (which join `user`) would keep surfacing a "ghost"
  // organizer whose account no longer exists.
  async deleteMe(userId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const organizers = await this.organizerRepository.find({ where: { userId } });
    if (organizers.length > 0) {
      await this.organizerRepository.softRemove(organizers);
    }

    // Explicit, not left to the FK's ON DELETE CASCADE — that only fires on a real row
    // DELETE, and softRemove() below is just an UPDATE setting deleted_at, so it would
    // never actually trigger for a soft-deleted user.
    await this.deviceTokenRepository.delete({ userId });

    await this.usersRepository.softRemove(user);
    await this.cache.del(userMeCacheKey(userId));
    this.logger.log(`Account self-deleted: ${user.email}`);
  }

  // Self-service "download my data" (Settings → Data & Privacy). Scoped to the account/
  // profile data this service directly owns (User columns, interests, organizer profile(s),
  // follows) rather than reaching across every module in the app (bookings, payments,
  // reviews, chat) — those live behind their own services/authorization, and a shallow
  // cross-module join here risks quietly leaking another user's data through a bad query.
  // The export itself says as much, with a pointer to support for anything broader.
  async exportMyData(userId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId }, relations: ['interests'] });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const organizerProfiles = await this.organizerRepository.find({ where: { userId } });
    const follows = await this.followsRepository.find({ where: { userId } });

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        bio: user.bio,
        location: user.location,
        latitude: user.latitude,
        longitude: user.longitude,
        profilePictureUrl: user.profilePictureUrl,
        roles: user.roles,
        isEmailVerified: user.isEmailVerified,
        hasCompletedOnboarding: user.hasCompletedOnboarding,
        notificationPrefs: user.notificationPrefs,
        pushEnabled: user.pushEnabled,
        emailEnabled: user.emailEnabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      interests: user.interests?.map((c) => ({ id: c.id, name: c.name })) ?? [],
      organizerProfiles: organizerProfiles.map((o) => ({
        id: o.id,
        companyName: o.companyName,
        companyDescription: o.companyDescription,
        companyWebsite: o.companyWebsite,
        verificationLevel: o.verificationLevel,
        commissionRate: o.commissionRate,
        commissionFlatFee: o.commissionFlatFee,
        createdAt: o.createdAt,
      })),
      followedOrganizerIds: follows.map((f) => f.organizerId),
      note: 'This export covers your account profile, interests, organizer profile (if any), and follows. For booking, payment, or refund records tied to your account, contact support.',
    };

    const jsonPretty = JSON.stringify(exportPayload, null, 2);
    const email = dataExportEmail(jsonPretty);
    await this.emailService.send(user.email, email.subject, email.html);
    this.logger.log(`Data export emailed to ${user.email}`);
  }
}