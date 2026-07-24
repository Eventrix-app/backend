import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let mockReviewsRepo: jest.Mocked<any>;
  let mockEnrollmentsRepo: jest.Mocked<any>;

  beforeEach(() => {
    mockReviewsRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'rev-1', ...data })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockEnrollmentsRepo = { exist: jest.fn().mockResolvedValue(true) };
    service = new ReviewsService(mockReviewsRepo, mockEnrollmentsRepo);
  });

  describe('create', () => {
    it('rejects a user with no confirmed enrollment', async () => {
      mockEnrollmentsRepo.exist.mockResolvedValue(false);
      await expect(service.create('event-1', { rating: 5 }, 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects a second review from the same user', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce({ id: 'rev-existing' });
      await expect(service.create('event-1', { rating: 5 }, 'user-1')).rejects.toThrow(ConflictException);
    });

    it('creates a review for a confirmed attendee', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'rev-1', rating: 5 });
      const result = await service.create('event-1', { rating: 5 }, 'user-1');
      expect(result).toEqual({ id: 'rev-1', rating: 5 });
      expect(mockReviewsRepo.save).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the review does not belong to the given event', async () => {
      mockReviewsRepo.findOne.mockResolvedValue(null);
      await expect(service.update('event-1', 'rev-1', { rating: 4 }, 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('rejects editing someone else\'s review', async () => {
      mockReviewsRepo.findOne.mockResolvedValue({ id: 'rev-1', eventId: 'event-1', userId: 'other-user', rating: 5 });
      await expect(service.update('event-1', 'rev-1', { rating: 1 }, 'user-1')).rejects.toThrow(ForbiddenException);
      expect(mockReviewsRepo.save).not.toHaveBeenCalled();
    });

    it('lets the author edit their own review', async () => {
      mockReviewsRepo.findOne
        .mockResolvedValueOnce({ id: 'rev-1', eventId: 'event-1', userId: 'user-1', rating: 5 })
        .mockResolvedValueOnce({ id: 'rev-1', rating: 3 });
      const result = await service.update('event-1', 'rev-1', { rating: 3 }, 'user-1');
      expect(result).toEqual({ id: 'rev-1', rating: 3 });
      expect(mockReviewsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ rating: 3 }));
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when the review does not exist for that event', async () => {
      mockReviewsRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('event-1', 'rev-1', 'user-1', ['user'])).rejects.toThrow(NotFoundException);
    });

    it('rejects a non-author, non-admin (including the event organizer) deleting a review', async () => {
      mockReviewsRepo.findOne.mockResolvedValue({ id: 'rev-1', eventId: 'event-1', userId: 'other-user' });
      await expect(service.remove('event-1', 'rev-1', 'organizer-user', ['organizer'])).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockReviewsRepo.delete).not.toHaveBeenCalled();
    });

    it('lets the author delete their own review', async () => {
      mockReviewsRepo.findOne.mockResolvedValue({ id: 'rev-1', eventId: 'event-1', userId: 'user-1' });
      await service.remove('event-1', 'rev-1', 'user-1', ['user']);
      expect(mockReviewsRepo.delete).toHaveBeenCalledWith({ id: 'rev-1', eventId: 'event-1' });
    });

    it('lets an admin delete any review', async () => {
      mockReviewsRepo.findOne.mockResolvedValue({ id: 'rev-1', eventId: 'event-1', userId: 'other-user' });
      await service.remove('event-1', 'rev-1', 'admin-1', ['admin']);
      expect(mockReviewsRepo.delete).toHaveBeenCalledWith({ id: 'rev-1', eventId: 'event-1' });
    });
  });
});
