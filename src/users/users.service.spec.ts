import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { validate } from 'class-validator';
import { UsersService } from './users.service';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { CacheService } from '../common/cache/cache.service';

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
  let mockCacheService: jest.Mocked<any>;

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    mockCategoryRepo = {
      findBy: jest.fn(),
    };
    mockCacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      getVersion: jest.fn().mockResolvedValue(1),
      bumpVersion: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(EventCategory), useValue: mockCategoryRepo },
        { provide: CacheService, useValue: mockCacheService },
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
});
