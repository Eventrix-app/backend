import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';
import { UpdateNotificationChannelsDto } from './participant/dto/update-notification-channels.dto';
import { CacheService } from '../common/cache/cache.service';

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
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoryRepository: Repository<EventCategory>,
    private readonly cache: CacheService,
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

    const response: CurrentUserResponse = {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? null,
      firstName: firstName || '',
      lastName: lastNameParts.join(' '),
      phoneNumber: user.phoneNumber ?? null,
      profilePictureUrl: user.profilePictureUrl ?? null,
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
  // site) — the latest device simply overwrites whatever token was stored before, since
  // this app only supports one active device per account for push purposes.
  async updatePushToken(userId: string, pushToken: string): Promise<void> {
    const result = await this.usersRepository.update(userId, { pushToken });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.cache.del(userMeCacheKey(userId));
  }

  // Called on logout so a signed-out device stops receiving this account's pushes —
  // without this, the token (registered per-account, not per-device) would keep
  // delivering notifications to a device the user is no longer signed into.
  async clearPushToken(userId: string): Promise<void> {
    const result = await this.usersRepository.update(userId, { pushToken: null });

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
}