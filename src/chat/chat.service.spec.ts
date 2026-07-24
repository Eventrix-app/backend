import { ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  let service: ChatService;
  let mockChatMessagesRepo: jest.Mocked<any>;
  let mockEventsRepo: jest.Mocked<any>;
  let mockEnrollmentsRepo: jest.Mocked<any>;
  let mockEventsService: jest.Mocked<any>;
  let mockBlocksService: jest.Mocked<any>;

  beforeEach(() => {
    mockChatMessagesRepo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'msg-1', ...data })),
      findOne: jest.fn().mockResolvedValue({ id: 'msg-1', eventId: 'event-1', userId: 'user-1', message: 'hi' }),
    };
    mockEventsRepo = { findOne: jest.fn().mockResolvedValue({ organizer: { userId: 'organizer-user' } }) };
    // Confirmed-enrollee by default — individual access-control tests override this.
    mockEnrollmentsRepo = { exist: jest.fn().mockResolvedValue(true) };
    mockEventsService = { findOneForViewer: jest.fn().mockResolvedValue({}) };
    mockBlocksService = { getBlockedUserIds: jest.fn().mockResolvedValue([]) };

    service = new ChatService(
      mockChatMessagesRepo,
      mockEventsRepo,
      mockEnrollmentsRepo,
      mockEventsService,
      mockBlocksService,
    );
  });

  describe('access control — chat is scoped to organizer/admin/confirmed attendees', () => {
    it('allows a confirmed attendee to read history', async () => {
      await expect(service.getHistory('event-1', 'user-1', ['user'])).resolves.toEqual([]);
      expect(mockEnrollmentsRepo.exist).toHaveBeenCalledWith({
        where: { eventId: 'event-1', userId: 'user-1', status: 'confirmed' },
      });
    });

    it('allows the event organizer to read history without an enrollment', async () => {
      mockEventsRepo.findOne.mockResolvedValue({ organizer: { userId: 'user-1' } });
      mockEnrollmentsRepo.exist.mockResolvedValue(false);
      await expect(service.getHistory('event-1', 'user-1', ['organizer'])).resolves.toEqual([]);
    });

    it('allows an admin to read history without an enrollment', async () => {
      mockEnrollmentsRepo.exist.mockResolvedValue(false);
      await expect(service.getHistory('event-1', 'admin-1', ['admin'])).resolves.toEqual([]);
      // Admins short-circuit before the owner lookup even runs.
      expect(mockEventsRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects a non-attendee, non-owner, non-admin user', async () => {
      mockEnrollmentsRepo.exist.mockResolvedValue(false);
      await expect(service.getHistory('event-1', 'stranger-1', ['user'])).rejects.toThrow(ForbiddenException);
    });

    it('rejects an anonymous/unauthenticated caller', async () => {
      await expect(service.getHistory('event-1', undefined, [])).rejects.toThrow(ForbiddenException);
      expect(mockBlocksService.getBlockedUserIds).not.toHaveBeenCalled();
    });

    it('applies the same gate to sending a message', async () => {
      mockEnrollmentsRepo.exist.mockResolvedValue(false);
      await expect(service.createMessage('event-1', 'stranger-1', ['user'], 'hi')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockChatMessagesRepo.save).not.toHaveBeenCalled();
    });

    it('lets a confirmed attendee send a message', async () => {
      await expect(service.createMessage('event-1', 'user-1', ['user'], 'hi')).resolves.toBeDefined();
      expect(mockChatMessagesRepo.save).toHaveBeenCalled();
    });
  });

  describe('block filtering', () => {
    it('queries plain by eventId when the caller has no blocks', async () => {
      await service.getHistory('event-1', 'user-1', ['user']);
      expect(mockChatMessagesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1' } }),
      );
    });

    it('excludes blocked users\' messages at the query level when the caller has blocks', async () => {
      mockBlocksService.getBlockedUserIds.mockResolvedValue(['blocked-1', 'blocked-2']);
      await service.getHistory('event-1', 'user-1', ['user']);

      const callArgs = mockChatMessagesRepo.find.mock.calls[0][0];
      expect(callArgs.where.eventId).toBe('event-1');
      // The Not(In([...])) FindOperator doesn't compare by simple equality — assert on its
      // shape instead of the exact operator instance.
      expect(callArgs.where.userId).toBeDefined();
      expect(callArgs.where.userId.type).toBe('not');
    });
  });
});
