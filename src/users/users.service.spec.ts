import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { validate } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { UsersService } from './users.service';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { Follow } from '../entities/follow.entity';
import { Favorite } from '../entities/favorite.entity';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { UserSession } from '../entities/user-session.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { Organizer } from '../entities/organizer.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { EmailService } from '../email/email.service';
import { CacheService } from '../common/cache/cache.service';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { AuthService } from '../auth/auth.service';

const CAT_A = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Music' } as EventCategory;
const CAT_B = { id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', name: 'Sports' } as EventCategory;
const CAT_C = { id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', name: 'Art' } as EventCategory;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid',
    email: 'test@example.com',
    fullName: 'Test User',
    phoneNumber: null,
    profilePictureUrl: null,
    bio: null,
    location: null,
    latitude: null,
    longitude: null,
    notificationPrefs: null,
    roles: ['user'],
    interests: [],
    hasCompletedOnboarding: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: undefined,
    ...overrides,
  } as unknown as User;
}

describe('UsersService', () => {
  let service: UsersService;
  let mockUserRepo: jest.Mocked<any>;
  let mockCategoryRepo: jest.Mocked<any>;
  let mockFollowRepo: jest.Mocked<any>;
  let mockOrganizerRepo: jest.Mocked<any>;
  let mockDeviceTokenRepo: jest.Mocked<any>;
  let mockFavoriteRepo: jest.Mocked<any>;
  let mockWaitlistEntryRepo: jest.Mocked<any>;
  let mockSessionsRepo: jest.Mocked<any>;
  let mockAuthIdentityRepo: jest.Mocked<any>;
  let mockEmailVerificationOtpRepo: jest.Mocked<any>;
  let mockPasswordResetOtpRepo: jest.Mocked<any>;
  let mockDataSource: jest.Mocked<any>;
  let mockCacheService: jest.Mocked<any>;
  let mockEmailService: jest.Mocked<any>;
  let mockAuditLogService: jest.Mocked<any>;
  let mockAuthService: jest.Mocked<any>;
  let mockManager: jest.Mocked<any>;

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      softRemove: jest.fn(),
    };
    mockCategoryRepo = {
      findBy: jest.fn(),
    };
    mockFollowRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
    };
    mockOrganizerRepo = {
      find: jest.fn().mockResolvedValue([]),
      softRemove: jest.fn(),
    };
    mockDeviceTokenRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    mockFavoriteRepo = {};
    mockWaitlistEntryRepo = {};
    mockSessionsRepo = {};
    mockAuthIdentityRepo = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    mockEmailVerificationOtpRepo = {};
    mockPasswordResetOtpRepo = {};
    mockManager = {
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockManager)),
    };
    mockEmailService = {
      send: jest.fn().mockResolvedValue(undefined),
    };
    mockCacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      getVersion: jest.fn().mockResolvedValue(1),
      bumpVersion: jest.fn().mockResolvedValue(undefined),
    };
    mockAuditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    mockAuthService = {
      verifyProviderToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(EventCategory), useValue: mockCategoryRepo },
        { provide: getRepositoryToken(Follow), useValue: mockFollowRepo },
        { provide: getRepositoryToken(Favorite), useValue: mockFavoriteRepo },
        { provide: getRepositoryToken(WaitlistEntry), useValue: mockWaitlistEntryRepo },
        { provide: getRepositoryToken(UserSession), useValue: mockSessionsRepo },
        { provide: getRepositoryToken(AuthIdentity), useValue: mockAuthIdentityRepo },
        { provide: getRepositoryToken(EmailVerificationOtp), useValue: mockEmailVerificationOtpRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: mockPasswordResetOtpRepo },
        { provide: getRepositoryToken(Organizer), useValue: mockOrganizerRepo },
        { provide: getRepositoryToken(DeviceToken), useValue: mockDeviceTokenRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: CacheService, useValue: mockCacheService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // ─── Test 2: GET /users/me returns all populated fields after full onboarding ──

  describe('findMe — Test 2: E2E sync verification', () => {
    it('returns interests array populated after updateInterests', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser({ interests: [CAT_A, CAT_B, CAT_C] }));

      const result = await service.findMe('user-uuid');

      expect(result.interests).toHaveLength(3);
      expect(result.interests.map((c) => c.id)).toEqual(
        expect.arrayContaining([CAT_A.id, CAT_B.id, CAT_C.id]),
      );
    });

    it('returns lat/lng populated after updateLocation', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser({ latitude: 12.9716, longitude: 77.5946 }));

      const result = await service.findMe('user-uuid');

      expect(result.latitude).toBe(12.9716);
      expect(result.longitude).toBe(77.5946);
    });

    it('returns notification_prefs populated after updateNotificationPrefs', async () => {
      const prefs = {
        eventReminders: true,
        nearbyEvents: false,
        reelsAndCommunity: true,
        specialOffers: false,
      };
      mockUserRepo.findOne.mockResolvedValue(makeUser({ notificationPrefs: prefs as any }));

      const result = await service.findMe('user-uuid');

      expect(result.notificationPrefs).toEqual(prefs);
    });

    it('returns all three fields populated simultaneously (full onboarding path)', async () => {
      const prefs = { eventReminders: true, nearbyEvents: true, reelsAndCommunity: false, specialOffers: true };
      mockUserRepo.findOne.mockResolvedValue(
        makeUser({ interests: [CAT_A, CAT_B, CAT_C], latitude: 28.6, longitude: 77.2, notificationPrefs: prefs as any }),
      );

      const result = await service.findMe('user-uuid');

      expect(result.interests).toHaveLength(3);
      expect(result.latitude).toBe(28.6);
      expect(result.longitude).toBe(77.2);
      expect(result.notificationPrefs).toEqual(prefs);
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(service.findMe('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('surfaces hasCompletedOnboarding so clients can decide whether to re-run onboarding', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser({ hasCompletedOnboarding: true }));

      const result = await service.findMe('user-uuid');

      expect(result.hasCompletedOnboarding).toBe(true);
    });
  });

  // ─── Test 5 (backend): PUT /users/me/interests with 2 UUIDs → 400 ────────────

  describe('UpdateInterestsDto validation — Test 5: 3-minimum enforcement', () => {
    it('fails validation when fewer than 3 categoryIds are provided', async () => {
      const dto = new UpdateInterestsDto();
      dto.categoryIds = [CAT_A.id, CAT_B.id];

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      const constraints = errors.flatMap((e) => Object.keys(e.constraints ?? {}));
      expect(constraints).toContain('arrayMinSize');
    });

    it('fails validation with 0 categoryIds', async () => {
      const dto = new UpdateInterestsDto();
      dto.categoryIds = [];

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
    });

    it('passes validation with exactly 3 valid UUIDs', async () => {
      const dto = new UpdateInterestsDto();
      dto.categoryIds = [CAT_A.id, CAT_B.id, CAT_C.id];

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
    });

    it('fails validation when non-UUID strings are provided', async () => {
      const dto = new UpdateInterestsDto();
      dto.categoryIds = ['not-a-uuid', 'also-not', 'nope'];

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
    });

    // Regression test for testing-bugs.txt #1: [A, B, B] has length 3 (passes
    // arrayMinSize) but only 2 distinct categories — previously saved silently with
    // no error instead of being rejected.
    it('fails validation when categoryIds contains a duplicate, even if length >= 3', async () => {
      const dto = new UpdateInterestsDto();
      dto.categoryIds = [CAT_A.id, CAT_B.id, CAT_B.id];

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      const constraints = errors.flatMap((e) => Object.keys(e.constraints ?? {}));
      expect(constraints).toContain('arrayUnique');
    });
  });

  // ─── updateInterests service method ──────────────────────────────────────────

  describe('updateInterests', () => {
    it('persists exactly the categories matching the provided IDs', async () => {
      const user = makeUser();
      mockUserRepo.findOne.mockResolvedValue(user);
      mockCategoryRepo.findBy.mockResolvedValue([CAT_A, CAT_B, CAT_C]);
      mockUserRepo.save.mockResolvedValue({ ...user, interests: [CAT_A, CAT_B, CAT_C] });

      await service.updateInterests('user-uuid', { categoryIds: [CAT_A.id, CAT_B.id, CAT_C.id] });

      expect(mockUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ interests: [CAT_A, CAT_B, CAT_C] }),
      );
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateInterests('missing', { categoryIds: [CAT_A.id, CAT_B.id, CAT_C.id] }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updateLocation service method ───────────────────────────────────────────

  describe('updateLocation', () => {
    it('writes lat/lng to the database', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 1 });

      await service.updateLocation('user-uuid', { latitude: 12.9716, longitude: 77.5946 });

      expect(mockUserRepo.update).toHaveBeenCalledWith(
        'user-uuid',
        expect.objectContaining({ latitude: 12.9716, longitude: 77.5946 }),
      );
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.updateLocation('missing', { latitude: 0, longitude: 0 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updateNotificationPrefs service method ───────────────────────────────────

  describe('updateNotificationPrefs', () => {
    it('writes all four pref flags to the database', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 1 });
      const prefs = { eventReminders: true, nearbyEvents: false, reelsAndCommunity: true, specialOffers: false };

      await service.updateNotificationPrefs('user-uuid', prefs as any);

      expect(mockUserRepo.update).toHaveBeenCalledWith(
        'user-uuid',
        expect.objectContaining({ notificationPrefs: prefs }),
      );
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.updateNotificationPrefs('missing', {} as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── completeOnboarding service method ────────────────────────────────────────

  describe('completeOnboarding', () => {
    it('flips hasCompletedOnboarding to true', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 1 });

      await service.completeOnboarding('user-uuid');

      expect(mockUserRepo.update).toHaveBeenCalledWith(
        'user-uuid',
        expect.objectContaining({ hasCompletedOnboarding: true }),
      );
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.completeOnboarding('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updatePushToken / clearPushToken (multi-device) ──────────────────────

  describe('updatePushToken', () => {
    it('upserts a device_tokens row keyed on the unique token column', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser());

      await service.updatePushToken('user-uuid', 'ExponentPushToken[abc]');

      expect(mockDeviceTokenRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-uuid', token: 'ExponentPushToken[abc]' }),
        ['token'],
      );
    });

    it('throws NotFoundException when the user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(service.updatePushToken('missing', 'tok')).rejects.toThrow(NotFoundException);
      expect(mockDeviceTokenRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('clearPushToken', () => {
    it('deletes only the row matching this user AND this specific token', async () => {
      await service.clearPushToken('user-uuid', 'ExponentPushToken[abc]');

      expect(mockDeviceTokenRepo.delete).toHaveBeenCalledWith({
        userId: 'user-uuid',
        token: 'ExponentPushToken[abc]',
      });
    });
  });

  // ─── deleteMe service method ───────────────────────────────────────────────

  describe('deleteMe', () => {
    it('soft-removes the user and deletes all of their registered device tokens', async () => {
      const user = makeUser();
      mockUserRepo.findOne.mockResolvedValue(user);
      mockOrganizerRepo.find.mockResolvedValue([]);

      await service.deleteMe('user-uuid');

      expect(mockUserRepo.softRemove).toHaveBeenCalledWith(user);
      expect(mockDeviceTokenRepo.delete).toHaveBeenCalledWith({ userId: 'user-uuid' });
    });

    it('also soft-removes any Organizer profile(s) owned by the user', async () => {
      const user = makeUser();
      const organizerRow = { id: 'org-1', userId: 'user-uuid' };
      mockUserRepo.findOne.mockResolvedValue(user);
      mockOrganizerRepo.find.mockResolvedValue([organizerRow]);

      await service.deleteMe('user-uuid');

      expect(mockOrganizerRepo.softRemove).toHaveBeenCalledWith([organizerRow]);
    });

    it('does not touch the Organizer repo when the user has no organizer profile', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser());
      mockOrganizerRepo.find.mockResolvedValue([]);

      await service.deleteMe('user-uuid');

      expect(mockOrganizerRepo.softRemove).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(service.deleteMe('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── exportMyData service method ───────────────────────────────────────────

  describe('exportMyData', () => {
    // The data rides in attachments now, not the body — a raw JSON dump in an email is
    // unreadable to anyone who does not already read JSON.
    it('emails a readable PDF and a machine-readable JSON to the user\'s own address', async () => {
      const user = makeUser({ email: 'export-me@example.com', interests: [CAT_A] });
      mockUserRepo.findOne.mockResolvedValue(user);
      mockOrganizerRepo.find.mockResolvedValue([]);
      mockFollowRepo.find.mockResolvedValue([]);

      await service.exportMyData('user-uuid');

      expect(mockEmailService.send).toHaveBeenCalledTimes(1);
      const [to, , html, attachments] = mockEmailService.send.mock.calls[0];
      expect(to).toBe('export-me@example.com');
      // The body must not carry the payload itself any more.
      expect(html).not.toContain(CAT_A.id);

      const pdf = attachments.find((a: any) => a.contentType === 'application/pdf');
      expect(pdf.filename).toBe('eventrix-data-export.pdf');
      expect(pdf.content.subarray(0, 5).toString()).toBe('%PDF-');

      const json = attachments.find((a: any) => a.contentType === 'application/json');
      const parsed = JSON.parse(json.content.toString('utf8'));
      expect(parsed.account.email).toBe('export-me@example.com');
      expect(parsed.interests).toEqual([{ id: CAT_A.id, name: CAT_A.name }]);
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(service.exportMyData('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── eraseMyData service method (DPDP self-service hard-delete) ────────────

  describe('eraseMyData', () => {
    it('erases directly-personal data and pseudonymizes the user row after a correct current password', async () => {
      const passwordHash = await bcrypt.hash('correct-horse', 10);
      const user = makeUser({ passwordHash, email: 'real@example.com' } as any);
      mockUserRepo.findOne.mockResolvedValue(user);

      await service.eraseMyData('user-uuid', { currentPassword: 'correct-horse' });

      expect(mockManager.delete).toHaveBeenCalledWith(Favorite, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(Follow, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(WaitlistEntry, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(DeviceToken, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(UserSession, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(AuthIdentity, { userId: 'user-uuid' });
      expect(mockManager.delete).toHaveBeenCalledWith(EmailVerificationOtp, { email: 'real@example.com' });
      expect(mockManager.delete).toHaveBeenCalledWith(PasswordResetOtp, { email: 'real@example.com' });

      const updateCall = mockManager.update.mock.calls.find((c: any[]) => c[0] === User);
      expect(updateCall[2]).toMatchObject({
        fullName: 'Deleted User',
        phoneNumber: null,
        passwordHash: null,
        bio: null,
        isErased: true,
      });
      expect(updateCall[2].email).toMatch(/^erased-.+@erased\.eventrix\.app$/);

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'user-uuid', action: 'DATA_ERASURE_SELF_SERVICE' }),
      );
    });

    it('rejects with no currentPassword for a password account', async () => {
      const passwordHash = await bcrypt.hash('correct-horse', 10);
      mockUserRepo.findOne.mockResolvedValue(makeUser({ passwordHash } as any));

      await expect(service.eraseMyData('user-uuid', {})).rejects.toThrow(UnauthorizedException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects an incorrect currentPassword', async () => {
      const passwordHash = await bcrypt.hash('correct-horse', 10);
      mockUserRepo.findOne.mockResolvedValue(makeUser({ passwordHash } as any));

      await expect(service.eraseMyData('user-uuid', { currentPassword: 'wrong' })).rejects.toThrow(UnauthorizedException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('for a social-only account, requires reauth and verifies it against a linked identity', async () => {
      mockUserRepo.findOne.mockResolvedValue(makeUser({ passwordHash: null } as any));

      await expect(service.eraseMyData('user-uuid', {})).rejects.toThrow(UnauthorizedException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();

      mockAuthService.verifyProviderToken.mockResolvedValue({ providerUserId: 'google-123' });
      mockAuthIdentityRepo.findOne.mockResolvedValue(null);
      await expect(
        service.eraseMyData('user-uuid', { reauth: { provider: 'google', token: 'tok' } }),
      ).rejects.toThrow(UnauthorizedException);

      mockAuthIdentityRepo.findOne.mockResolvedValue({ userId: 'user-uuid', provider: 'google', providerUserId: 'google-123' });
      await service.eraseMyData('user-uuid', { reauth: { provider: 'google', token: 'tok' } });
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      await expect(service.eraseMyData('missing', {})).rejects.toThrow(NotFoundException);
    });
  });
});
