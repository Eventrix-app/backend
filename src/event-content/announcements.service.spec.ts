import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;
  let mockAnnouncementsRepo: jest.Mocked<any>;
  let mockEventsRepo: jest.Mocked<any>;
  let mockEnrollmentsRepo: jest.Mocked<any>;
  let mockChatRealtimeService: jest.Mocked<any>;
  let mockNotificationService: jest.Mocked<any>;

  beforeEach(() => {
    mockAnnouncementsRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'ann-1', ...data })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockEventsRepo = { findOne: jest.fn().mockResolvedValue({ organizer: { userId: 'organizer-user' } }) };
    mockEnrollmentsRepo = { find: jest.fn().mockResolvedValue([]) };
    mockChatRealtimeService = { broadcastAnnouncement: jest.fn() };
    mockNotificationService = { notifyAnnouncement: jest.fn() };

    service = new AnnouncementsService(
      mockAnnouncementsRepo,
      mockEventsRepo,
      mockEnrollmentsRepo,
      mockChatRealtimeService,
      mockNotificationService,
    );
  });

  describe('update', () => {
    it('rejects a non-owner, non-admin caller', async () => {
      await expect(
        service.update('event-1', 'ann-1', { title: 'Edited' }, 'random-user', ['user']),
      ).rejects.toThrow(ForbiddenException);
      expect(mockAnnouncementsRepo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the announcement does not belong to the event', async () => {
      mockAnnouncementsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('event-1', 'ann-1', { title: 'Edited' }, 'organizer-user', ['organizer']),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets the owning organizer edit the announcement without re-broadcasting or re-notifying', async () => {
      mockAnnouncementsRepo.findOne
        .mockResolvedValueOnce({ id: 'ann-1', eventId: 'event-1', title: 'Old', body: 'Old body' })
        .mockResolvedValueOnce({ id: 'ann-1', title: 'Edited' });

      const result = await service.update('event-1', 'ann-1', { title: 'Edited' }, 'organizer-user', ['organizer']);

      expect(result).toEqual({ id: 'ann-1', title: 'Edited' });
      expect(mockAnnouncementsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edited' }));
      expect(mockChatRealtimeService.broadcastAnnouncement).not.toHaveBeenCalled();
      expect(mockNotificationService.notifyAnnouncement).not.toHaveBeenCalled();
    });

    it('lets an admin edit any event\'s announcement', async () => {
      mockAnnouncementsRepo.findOne
        .mockResolvedValueOnce({ id: 'ann-1', eventId: 'event-1', title: 'Old' })
        .mockResolvedValueOnce({ id: 'ann-1', title: 'Edited' });
      await expect(
        service.update('event-1', 'ann-1', { title: 'Edited' }, 'admin-1', ['admin']),
      ).resolves.toEqual({ id: 'ann-1', title: 'Edited' });
    });
  });

  describe('remove', () => {
    it('rejects a non-owner, non-admin caller', async () => {
      await expect(service.remove('event-1', 'ann-1', 'random-user', ['user'])).rejects.toThrow(ForbiddenException);
      expect(mockAnnouncementsRepo.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when nothing was deleted', async () => {
      mockAnnouncementsRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.remove('event-1', 'ann-1', 'organizer-user', ['organizer'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lets the owning organizer delete the announcement', async () => {
      await service.remove('event-1', 'ann-1', 'organizer-user', ['organizer']);
      expect(mockAnnouncementsRepo.delete).toHaveBeenCalledWith({ id: 'ann-1', eventId: 'event-1' });
    });
  });
});
