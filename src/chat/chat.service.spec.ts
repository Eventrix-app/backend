import { ChatService } from './chat.service';

describe('ChatService — block filtering', () => {
  let service: ChatService;
  let mockChatMessagesRepo: jest.Mocked<any>;
  let mockEventsService: jest.Mocked<any>;
  let mockBlocksService: jest.Mocked<any>;

  beforeEach(() => {
    mockChatMessagesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockEventsService = { findOneForViewer: jest.fn().mockResolvedValue({}) };
    mockBlocksService = { getBlockedUserIds: jest.fn().mockResolvedValue([]) };

    service = new ChatService(mockChatMessagesRepo, mockEventsService, mockBlocksService);
  });

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

  it('never looks up blocks for an anonymous/unauthenticated viewer', async () => {
    await service.getHistory('event-1', undefined, []);
    expect(mockBlocksService.getBlockedUserIds).not.toHaveBeenCalled();
  });
});
