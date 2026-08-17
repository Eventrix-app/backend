import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShortsService } from './shorts.service';
import { Short, ShortModerationStatus } from '../entities/short.entity';
import { ShortLike } from '../entities/short-like.entity';
import { ShortComment } from '../entities/short-comment.entity';
import { ShortView } from '../entities/short-view.entity';
import { Event } from '../entities/event.entity';
import { NotificationService } from '../notifications/notification.service';

describe('ShortsService', () => {
  let service: ShortsService;
  let mockShortsRepo: any;
  let mockShortLikesRepo: any;
  let mockEventsRepo: any;
  let mockNotificationService: any;
  let mockShortCommentsRepo: any;
  let mockShortViewsRepo: any;

  beforeEach(async () => {
    mockShortsRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve({ id: 'short-1', likeCount: 0, ...data })),
      remove: jest.fn(),
      query: jest.fn(),
      findAndCount: jest.fn(),
    };
    mockShortLikesRepo = {
      insert: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    };
    mockEventsRepo = {
      exists: jest.fn(),
    };
    mockNotificationService = {
      notifyShortLiked: jest.fn().mockResolvedValue(undefined),
      notifyShortCommented: jest.fn().mockResolvedValue(undefined),
    };
    mockShortViewsRepo = { insert: jest.fn() };
    mockShortCommentsRepo = {
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => Promise.resolve({ id: 'comment-1', ...d })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      softDelete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShortsService,
        { provide: getRepositoryToken(Short), useValue: mockShortsRepo },
        { provide: getRepositoryToken(ShortLike), useValue: mockShortLikesRepo },
        { provide: getRepositoryToken(ShortComment), useValue: mockShortCommentsRepo },
        { provide: getRepositoryToken(ShortView), useValue: mockShortViewsRepo },
        { provide: getRepositoryToken(Event), useValue: mockEventsRepo },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<ShortsService>(ShortsService);
  });

  // GET /shorts/feed is @Public(), so what this method selects is world-readable. These
  // guard the two properties that make that safe.
  describe('like notifications', () => {
    beforeEach(() => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', uploaderUserId: 'owner-1', likeCount: 3 });
      mockShortLikesRepo.insert.mockResolvedValue(undefined);
      mockShortsRepo.query.mockResolvedValue([[{ like_count: 4 }], 1]);
    });

    it('notifies the uploader when someone else likes their reel', async () => {
      await service.like('short-1', 'liker-1', 'Aarish');

      expect(mockNotificationService.notifyShortLiked).toHaveBeenCalledWith('owner-1', 'short-1', 'Aarish');
    });

    it('does not notify you about liking your own reel', async () => {
      await service.like('short-1', 'owner-1', 'Owner');

      expect(mockNotificationService.notifyShortLiked).not.toHaveBeenCalled();
    });

    // A double tap or a retried request hits the unique constraint. The like is already
    // recorded, so re-notifying would send a second "someone liked your reel" for one like.
    it('does not re-notify when the like already exists', async () => {
      mockShortLikesRepo.insert.mockRejectedValue({ code: '23505' });

      const result = await service.like('short-1', 'liker-1', 'Aarish');

      expect(result).toEqual({ liked: true, likeCount: 3 });
      expect(mockNotificationService.notifyShortLiked).not.toHaveBeenCalled();
    });
  });

  // One account, one view. The counter previously moved on every play, so relaunching the
  // app and rewatching inflated it without limit.
  describe('recordView', () => {
    beforeEach(() => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', viewCount: 7 });
      mockShortViewsRepo.insert.mockResolvedValue(undefined);
      mockShortsRepo.query.mockResolvedValue([[{ view_count: 8 }], 1]);
    });

    it('counts a first-time viewer', async () => {
      const result = await service.recordView('short-1', 'viewer-1');

      expect(mockShortViewsRepo.insert).toHaveBeenCalledWith({ userId: 'viewer-1', shortId: 'short-1' });
      expect(result).toEqual({ viewCount: 8 });
      const [sql] = mockShortsRepo.query.mock.calls[0];
      expect(sql).toContain('view_count = view_count + 1');
    });

    // The unique constraint is what decides this, not a client-side guard - which is the
    // whole point, since a client guard dies with the app process.
    it('does not count the same account twice, however many times it rewatches', async () => {
      mockShortViewsRepo.insert.mockRejectedValue({ code: '23505' });

      const result = await service.recordView('short-1', 'viewer-1');

      expect(result).toEqual({ viewCount: 7 });
      expect(mockShortsRepo.query).not.toHaveBeenCalled();
    });

    it('still returns the current total on a repeat view rather than failing', async () => {
      mockShortViewsRepo.insert.mockRejectedValue({ code: '23505' });

      await expect(service.recordView('short-1', 'viewer-1')).resolves.toEqual({ viewCount: 7 });
    });

    it('counts two different accounts separately', async () => {
      await service.recordView('short-1', 'viewer-1');
      mockShortsRepo.query.mockResolvedValue([[{ view_count: 9 }], 1]);
      const second = await service.recordView('short-1', 'viewer-2');

      expect(second).toEqual({ viewCount: 9 });
      expect(mockShortViewsRepo.insert).toHaveBeenCalledTimes(2);
    });

    it('rejects an unknown reel', async () => {
      mockShortsRepo.findOne.mockResolvedValue(null);

      await expect(service.recordView('missing', 'viewer-1')).rejects.toThrow(NotFoundException);
    });

    // A non-duplicate database failure must surface, not be swallowed as "already viewed".
    it('rethrows an insert failure that is not a duplicate', async () => {
      mockShortViewsRepo.insert.mockRejectedValue({ code: '23503' });

      await expect(service.recordView('short-1', 'viewer-1')).rejects.toBeDefined();
    });
  });

  describe('comments', () => {
    beforeEach(() => {
      mockShortsRepo.findOne.mockResolvedValue({ id: 'short-1', uploaderUserId: 'owner-1' });
      mockShortsRepo.query.mockResolvedValue([]);
      mockShortCommentsRepo.findOne.mockResolvedValue({ id: 'comment-1', body: 'Nice' });
    });

    it('notifies the reel owner, with the text so the push is useful on its own', async () => {
      await service.addComment('short-1', 'commenter-1', { body: 'Nice one' }, 'Aarish');

      expect(mockNotificationService.notifyShortCommented).toHaveBeenCalledWith(
        'owner-1', 'short-1', 'Aarish', 'Nice one',
      );
    });

    it('does not notify you about commenting on your own reel', async () => {
      await service.addComment('short-1', 'owner-1', { body: 'Mine' }, 'Owner');

      expect(mockNotificationService.notifyShortCommented).not.toHaveBeenCalled();
    });

    it('increments the denormalised counter atomically', async () => {
      await service.addComment('short-1', 'commenter-1', { body: 'Hi' }, 'A');

      const [sql] = mockShortsRepo.query.mock.calls[0];
      expect(sql).toContain('comment_count = comment_count + 1');
    });

    it('lists oldest first, so replies stay below what they answer', async () => {
      mockShortCommentsRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findComments('short-1', {});

      const [options] = mockShortCommentsRepo.findAndCount.mock.calls[0];
      expect(options.order).toEqual({ createdAt: 'ASC' });
    });

    it("never exposes a commenter's contact details", async () => {
      mockShortCommentsRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findComments('short-1', {});

      const [options] = mockShortCommentsRepo.findAndCount.mock.calls[0];
      expect(Object.keys(options.select.user).sort()).toEqual(['fullName', 'id', 'profilePictureUrl']);
    });

    it('lets the comment author delete it', async () => {
      mockShortCommentsRepo.findOne.mockResolvedValue({ id: 'c1', shortId: 'short-1', userId: 'author-1' });

      await service.removeComment('c1', 'author-1');

      expect(mockShortCommentsRepo.softDelete).toHaveBeenCalledWith({ id: 'c1' });
    });

    // A creator has to be able to clear abuse off their own reel without waiting on admins.
    it("lets the reel owner delete someone else's comment", async () => {
      mockShortCommentsRepo.findOne.mockResolvedValue({ id: 'c1', shortId: 'short-1', userId: 'author-1' });

      await service.removeComment('c1', 'owner-1');

      expect(mockShortCommentsRepo.softDelete).toHaveBeenCalled();
    });

    it('refuses deletion by an unrelated user', async () => {
      mockShortCommentsRepo.findOne.mockResolvedValue({ id: 'c1', shortId: 'short-1', userId: 'author-1' });

      await expect(service.removeComment('c1', 'stranger-1')).rejects.toThrow(ForbiddenException);
      expect(mockShortCommentsRepo.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes rather than hard-deletes, so moderation can still read it', async () => {
      mockShortCommentsRepo.findOne.mockResolvedValue({ id: 'c1', shortId: 'short-1', userId: 'author-1' });

      await service.removeComment('c1', 'author-1');

      expect(mockShortCommentsRepo.softDelete).toHaveBeenCalled();
      const [sql] = mockShortsRepo.query.mock.calls[0];
      expect(sql).toContain('GREATEST(comment_count - 1, 0)');
    });
  });

  describe('findFeed', () => {
    beforeEach(() => {
      mockShortsRepo.findAndCount.mockResolvedValue([[], 0]);
    });

    it('only ever returns published reels', async () => {
      await service.findFeed({});

      const [options] = mockShortsRepo.findAndCount.mock.calls[0];
      expect(options.where).toEqual({ moderationStatus: ShortModerationStatus.PUBLISHED });
    });

    it('never projects uploader contact details or roles into the public feed', async () => {
      await service.findFeed({});

      const [options] = mockShortsRepo.findAndCount.mock.calls[0];
      expect(Object.keys(options.select.uploader).sort()).toEqual(['fullName', 'id', 'profilePictureUrl']);
      // Explicit, because these leaking is the specific failure this test exists to catch.
      expect(options.select.uploader.email).toBeUndefined();
      expect(options.select.uploader.phone).toBeUndefined();
      expect(options.select.uploader.roles).toBeUndefined();
    });

    it('caps the page size so one request cannot drain the table', async () => {
      await service.findFeed({ limit: 5000 });

      const [options] = mockShortsRepo.findAndCount.mock.calls[0];
      expect(options.take).toBe(50);
    });

    it('clamps a nonsensical page number to the first page', async () => {
      await service.findFeed({ page: -3 });

      const [options] = mockShortsRepo.findAndCount.mock.calls[0];
      expect(options.skip).toBe(0);
    });
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
      mockShortsRepo.query.mockResolvedValue([[{ like_count: 4 }], 1]);

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
      mockShortsRepo.query.mockResolvedValue([[{ like_count: 3 }], 1]);

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
