import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { Short, ShortModerationStatus } from '../entities/short.entity';
import { ShortLike } from '../entities/short-like.entity';
import { Event } from '../entities/event.entity';

describe('ShortsService', () => {
  let service: ShortsService;
  let mockShortsRepo: any;
  let mockShortLikesRepo: any;
  let mockEventsRepo: any;

  beforeEach(async () => {
    mockShortsRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve({ id: 'short-1', likeCount: 0, ...data })),
      remove: jest.fn(),
      query: jest.fn(),
    };
    mockShortLikesRepo = {
      insert: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    };
    mockEventsRepo = {
      exists: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShortsService,
        { provide: getRepositoryToken(Short), useValue: mockShortsRepo },
        { provide: getRepositoryToken(ShortLike), useValue: mockShortLikesRepo },
        { provide: getRepositoryToken(Event), useValue: mockEventsRepo },
      ],
    }).compile();

    service = module.get<ShortsService>(ShortsService);
  });

  describe('create', () => {
    it('rejects when eventId does not refer to a real event', async () => {
      mockEventsRepo.exists.mockResolvedValue(false);

      await expect(
        service.create('user-1', { mediaUrl: 'https://x/video.mp4', eventId: 'event-missing' } as any),
      ).rejects.toThrow(NotFoundException);
      expect(mockShortsRepo.save).not.toHaveBeenCalled();
    });

    it('publishes immediately for a valid event', async () => {
      mockEventsRepo.exists.mockResolvedValue(true);

      const result = await service.create('user-1', {
        mediaUrl: 'https://x/video.mp4',
        eventId: 'event-1',
        caption: 'Great night',
      } as any);

      expect(result.moderationStatus).toBe(ShortModerationStatus.PUBLISHED);
      expect(result.uploaderUserId).toBe('user-1');
    });
  });

  describe('removeOwn', () => {
    it('forbids deleting a reel you do not own', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', uploaderUserId: 'owner-1' });

      await expect(service.removeOwn('short-1', 'other-user')).rejects.toThrow(ForbiddenException);
      expect(mockShortsRepo.remove).not.toHaveBeenCalled();
    });

    it('allows the owner to delete their own reel', async () => {
      const short = { id: 'short-1', uploaderUserId: 'owner-1' };
      mockShortsRepo.findOne.mockResolvedValue(short);

      await service.removeOwn('short-1', 'owner-1');

      expect(mockShortsRepo.remove).toHaveBeenCalledWith(short);
    });

    // Regression: admin used to get a bypass here too, which let admin hard-delete
    // anyone's reel with zero audit trail — admin removal must go through the
    // dedicated, @AuditAction-logged PATCH shorts/:id/remove moderation route instead.
    it('forbids deleting someone else\'s reel even as an admin — use the moderation remove() route instead', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', uploaderUserId: 'owner-1' });

      await expect(service.removeOwn('short-1', 'admin-1')).rejects.toThrow(ForbiddenException);
      expect(mockShortsRepo.remove).not.toHaveBeenCalled();
    });
  });

  describe('like', () => {
    it('inserts a like and atomically increments like_count', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', likeCount: 3 });
      mockShortLikesRepo.insert.mockResolvedValue({});
      mockShortsRepo.query.mockResolvedValue([{ like_count: 4 }]);

      const result = await service.like('short-1', 'user-1');

      expect(result).toEqual({ liked: true, likeCount: 4 });
      expect(mockShortLikesRepo.insert).toHaveBeenCalledWith({ userId: 'user-1', shortId: 'short-1' });
    });

    it('is idempotent against a duplicate like (unique constraint race) — no double increment', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', likeCount: 5 });
      mockShortLikesRepo.insert.mockRejectedValue({ code: '23505' });

      const result = await service.like('short-1', 'user-1');

      expect(result).toEqual({ liked: true, likeCount: 5 });
      expect(mockShortsRepo.query).not.toHaveBeenCalled();
    });
  });

  describe('unlike', () => {
    it('deletes the like and atomically decrements like_count', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', likeCount: 4 });
      mockShortLikesRepo.delete.mockResolvedValue({ affected: 1 });
      mockShortsRepo.query.mockResolvedValue([{ like_count: 3 }]);

      const result = await service.unlike('short-1', 'user-1');

      expect(result).toEqual({ liked: false, likeCount: 3 });
    });

    it('never drives like_count below zero on a repeat unlike (no row deleted)', async () => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', likeCount: 0 });
      mockShortLikesRepo.delete.mockResolvedValue({ affected: 0 });

      const result = await service.unlike('short-1', 'user-1');

      expect(result).toEqual({ liked: false, likeCount: 0 });
      expect(mockShortsRepo.query).not.toHaveBeenCalled();
    });
  });

  describe('findMyLikedIds', () => {
    it('returns just the short ids the user has liked', async () => {
      mockShortLikesRepo.find.mockResolvedValue([{ shortId: 's1' }, { shortId: 's2' }]);

      const result = await service.findMyLikedIds('user-1');

      expect(result).toEqual(['s1', 's2']);
    });
  });
});
