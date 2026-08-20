import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { verifyPassword } from '../auth/password.util';
import { randomUUID } from 'crypto';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { Follow } from '../entities/follow.entity';
import { Favorite } from '../entities/favorite.entity';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { UserSession } from '../entities/user-session.entity';
import { AuthIdentity, AuthProvider } from '../entities/auth-identity.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { Organizer } from '../entities/organizer.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';
import { UpdateNotificationChannelsDto } from './participant/dto/update-notification-channels.dto';
import { EraseMyDataDto } from './dto/erase-my-data.dto';
import { CacheService } from '../common/cache/cache.service';
import { EmailService } from '../email/email.service';
import { dataExportEmail } from '../email/templates';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { AuthService } from '../auth/auth.service';
import { userMeCacheKey } from './user-cache-keys';
import { renderDataExportPdf } from '../common/pdf/data-export.pdf';
export { userMeCacheKey };

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
  // Tells the client whether Settings → Delete My Data should collect a current-password
  // confirmation or trigger social re-authentication instead — a social-only account
  // (Google/Apple/Facebook, never set a password) has no passwordHash to check.
  hasPassword: boolean;
  // Linked social sign-in providers (e.g. ['google']) — lets the client know which
  // provider to re-authenticate with for Delete My Data when hasPassword is false.
  authProviders: string[];
  bio: string | null;
  location: string | null;
  // Self-editable profile fields, returned so Edit Profile can prefill them. gender and
  // dateOfBirth are real columns; the address set is decoded out of the `bio` meta blob
  // (see parseMeta). These have to be readable here because PATCH /participants/:id treats
  // an explicitly-sent '' as "clear this field" — a client that cannot read a field back
  // would prefill it as '' and wipe it on the next save.
  gender: string;
  dateOfBirth: string;
  addressLine: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
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
    @InjectRepository(Favorite)
    private readonly favoriteRepository: Repository<Favorite>,
    @InjectRepository(WaitlistEntry)
    private readonly waitlistEntryRepository: Repository<WaitlistEntry>,
    @InjectRepository(UserSession)
    private readonly sessionsRepository: Repository<UserSession>,
    @InjectRepository(AuthIdentity)
    private readonly authIdentityRepository: Repository<AuthIdentity>,
    @InjectRepository(EmailVerificationOtp)
    private readonly emailVerificationOtpRepository: Repository<EmailVerificationOtp>,
    @InjectRepository(PasswordResetOtp)
    private readonly passwordResetOtpRepository: Repository<PasswordResetOtp>,
    private readonly dataSource: DataSource,
    private readonly cache: CacheService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly authService: AuthService,
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

  /**
   * The publicly visible slice of a user's account.
   *
   * Reachable by anyone (it backs tapping a reel's author), so the projection is an explicit
   * allow-list rather than findMe() minus a few fields: email, phone, roles, coordinates and
   * verification state must never appear here, and an allow-list cannot leak a column added
   * to the entity later.
   *
   * 404s for a soft-deleted account rather than returning a tombstone — a deleted user has
   * no profile to show.
   */
  async findPublicProfile(id: string): Promise<{
    id: string;
    fullName: string | null;
    profilePictureUrl: string | null;
    memberSince: Date;
  }> {
    const user = await this.usersRepository.findOne({
      where: { id },
      select: { id: true, fullName: true, profilePictureUrl: true, createdAt: true } as any,
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    return {
      id: user.id,
      fullName: user.fullName ?? null,
      profilePictureUrl: (user as any).profilePictureUrl ?? null,
      memberSince: user.createdAt,
    };
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
    const authIdentities = await this.authIdentityRepository.find({ where: { userId } });

    const response: CurrentUserResponse = {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? null,
      firstName: firstName || '',
      lastName: lastNameParts.join(' '),
      phoneNumber: user.phoneNumber ?? null,
      profilePictureUrl: user.profilePictureUrl ?? null,
      isEmailVerified: user.isEmailVerified,
      hasPassword: !!user.passwordHash,
      authProviders: authIdentities.map((identity) => identity.provider),
      bio: user.bio ?? null,
      location: user.location ?? null,
      gender: user.gender || '',
      dateOfBirth: user.dateOfBirth || '',
      addressLine: meta['addressLine'] || '',
      city: meta['city'] || '',
      state: meta['state'] || '',
      country: meta['country'] || '',
      pincode: meta['pincode'] || '',
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

  // Self-service hard data erasure (Settings → Delete My Data), distinct from deleteMe()
  // above (a reversible-in-principle deactivation). Implements India's DPDP Act 2023 §12
  // erasure right: personal data with no independent legal retention basis is erased
  // outright; statutorily-retained records (bookings/payments/refunds/payouts, organizer
  // KYC documents, audit logs — see data-retention-policy.md) are left untouched, and this
  // User row is pseudonymized rather than deleted so those records keep a valid owner
  // reference. Requires identity verification first (current password, or re-authentication
  // for a social-only account) — an erasure request must be provably from the account
  // owner, not just from whoever holds a valid access token.
  async eraseMyData(userId: string, dto: EraseMyDataDto): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    if (user.passwordHash) {
      if (!dto.currentPassword) {
        throw new UnauthorizedException('Current password is required to erase your data');
      }
      const matches = await verifyPassword(
        dto.currentPassword,
        user.passwordHash,
        user.passwordHashVersion,
      );
      if (!matches) {
        throw new UnauthorizedException('Current password is incorrect');
      }
    } else {
      if (!dto.reauth) {
        throw new UnauthorizedException('Re-authentication is required to erase your data');
      }
      const profile = await this.authService.verifyProviderToken(dto.reauth.provider, dto.reauth.token);
      const linkedIdentity = await this.authIdentityRepository.findOne({
        where: { userId, provider: dto.reauth.provider as AuthProvider, providerUserId: profile.providerUserId },
      });
      if (!linkedIdentity) {
        throw new UnauthorizedException('Re-authentication failed');
      }
    }

    const originalEmail = user.email;
    const erasedCategories = [
      'favorites',
      'follows',
      'waitlist entries',
      'device tokens',
      'sessions',
      'linked social sign-in identities',
      'pending email/password OTPs',
      'profile PII (name, email, phone, photo, bio, location, date of birth, gender, notification preferences, password)',
      'organizer display PII (name, company name/description/website/logo, UPI ID), where applicable',
    ];
    const retainedCategories = [
      'bookings/enrollments',
      'payments',
      'refunds',
      'payouts',
      'organizer KYC documents (identity/address proof, PAN/Aadhaar — where applicable)',
      'audit logs',
    ];

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Favorite, { userId });
      await manager.delete(Follow, { userId });
      await manager.delete(WaitlistEntry, { userId });
      await manager.delete(DeviceToken, { userId });
      // Revoke before delete, not strictly necessary since the rows are about to be
      // removed, but keeps the audit trail (any external session log) consistent with
      // every other revocation path in this app.
      await manager.update(UserSession, { userId, revokedAt: IsNull() }, { revokedAt: new Date() });
      await manager.delete(UserSession, { userId });
      await manager.delete(AuthIdentity, { userId });
      await manager.delete(EmailVerificationOtp, { email: originalEmail });
      await manager.delete(PasswordResetOtp, { email: originalEmail });

      // KYC documents (identityProofUrl/addressProofUrl/panOrAadhaarUrl) are a statutorily
      // retained record, same as bookings/payments — only the display/contact PII is erased.
      await manager.update(Organizer, { userId }, {
        fullName: null,
        companyName: 'Deleted Organizer',
        companyDescription: null,
        companyWebsite: null,
        companyLogoUrl: null,
        upiId: null,
      } as any);

      // Several of these columns are nullable in the DB but typed as plain (non-nullable)
      // strings on the entity — a pre-existing looseness elsewhere in this codebase too
      // (e.g. events.service.ts's `deletedAt: null as any`) — hence the cast.
      await manager.update(User, userId, {
        fullName: 'Deleted User',
        email: `erased-${randomUUID()}@erased.eventrix.app`,
        phoneNumber: null,
        passwordHash: null,
        profilePictureUrl: null,
        bio: null,
        location: null,
        latitude: null,
        longitude: null,
        dateOfBirth: null,
        gender: null,
        notificationPrefs: null,
        isErased: true,
        deletedAt: new Date(),
      } as any);
    });

    await this.cache.del(userMeCacheKey(userId));

    await this.auditLogService.log({
      actorId: userId,
      actorEmail: originalEmail,
      action: 'DATA_ERASURE_SELF_SERVICE',
      targetType: 'user',
      targetId: userId,
      metadata: { erasedCategories, retainedCategories },
    });

    this.logger.log(`User ${userId} erased their personal data (self-service DPDP request)`);
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

    const email = dataExportEmail();
    // JSON rides along beside the PDF: the PDF is what a person reads, but data portability
    // means handing over something another service can actually ingest.
    const attachments = [
      {
        filename: 'eventrix-data-export.pdf',
        content: await renderDataExportPdf(exportPayload),
        contentType: 'application/pdf',
      },
      {
        filename: 'eventrix-data-export.json',
        content: Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8'),
        contentType: 'application/json',
      },
    ];

    await this.emailService.send(user.email, email.subject, email.html, attachments);
    this.logger.log(`Data export emailed to ${user.email}`);
  }
}