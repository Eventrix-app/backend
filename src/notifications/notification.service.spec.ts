import { NotificationService } from './notification.service';
import { NotificationJobStatus } from '../entities/notification-job.entity';

describe('NotificationService — event approval/rejection', () => {
  let service: NotificationService;
  let mockJobsRepo: jest.Mocked<any>;
  let mockUsersRepo: jest.Mocked<any>;
  let mockDeviceTokenRepo: jest.Mocked<any>;
  let mockEmailService: jest.Mocked<any>;
  let mockPushService: jest.Mocked<any>;

  beforeEach(() => {
    mockJobsRepo = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'job-1', ...data })),
    };
    mockUsersRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'organizer-user-1', email: 'org@example.com', emailEnabled: true }),
    };
    mockDeviceTokenRepo = { find: jest.fn().mockResolvedValue([]) };
    mockEmailService = { send: jest.fn().mockResolvedValue(undefined) };
    mockPushService = { send: jest.fn().mockResolvedValue(undefined) };

    service = new NotificationService(mockJobsRepo, mockUsersRepo, mockDeviceTokenRepo, mockEmailService, mockPushService);
  });

  it('enqueues an EVENT_APPROVED job and emails the organizer with a deep link', async () => {
    await service.notifyEventApproved('organizer-user-1', 'event-1', 'Summer Fest');

    expect(mockJobsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'organizer-user-1', type: 'event_approved', status: NotificationJobStatus.PENDING }),
    );
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'org@example.com',
      expect.stringContaining('Summer Fest'),
      expect.stringContaining('eventrix://event/event-1'),
      undefined,
    );
  });

  it('enqueues an EVENT_REJECTED job and emails the organizer with the rejection reason', async () => {
    await service.notifyEventRejected('organizer-user-1', 'event-1', 'Summer Fest', 'Missing venue details');

    expect(mockJobsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'organizer-user-1', type: 'event_rejected' }),
    );
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'org@example.com',
      expect.any(String),
      expect.stringContaining('Missing venue details'),
      undefined,
    );
  });

  it('pushes to every registered device with the type in the payload for deep-link routing', async () => {
    mockDeviceTokenRepo.find.mockResolvedValue([{ token: 'ExponentPushToken[a]' }, { token: 'ExponentPushToken[b]' }]);
    mockUsersRepo.findOne.mockResolvedValue({ id: 'organizer-user-1', pushEnabled: true });

    await service.notifyEventApproved('organizer-user-1', 'event-1', 'Summer Fest');

    expect(mockPushService.send).toHaveBeenCalledTimes(2);
    expect(mockPushService.send).toHaveBeenCalledWith(
      'ExponentPushToken[a]',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ type: 'event_approved', eventId: 'event-1' }),
    );
  });
});
