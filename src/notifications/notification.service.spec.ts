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

  // Attached as a PDF rather than a loose QR image so it saves to the device as one file
  // carrying the event, ticket count and reference — a bare .png carries none of that.
  it('attaches a ticket PDF to a booking confirmation', async () => {
    await service.notifyBookingConfirmed(
      'organizer-user-1',
      'event-1',
      'enr-1',
      'Summer Fest',
      'EVX-12345',
      2,
      'TICKET-ABC-123',
      '2026-09-01',
      '18:30',
      'Phoenix Arena',
    );

    const attachments = mockEmailService.send.mock.calls[0][3];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('eventrix-ticket.pdf');
    expect(attachments[0].contentType).toBe('application/pdf');
    expect(attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-');
    // cid would make some clients treat it as inline and hide it from the attachment list.
    expect(attachments[0].cid).toBeUndefined();
    // Generous because pdfkit loads its font metrics on the first render; measured at ~890ms
    // cold and ~250ms after, and ts-jest adds the module compile on top.
  }, 30000);

  it('sends no ticket attachment when the booking has no ticket code', async () => {
    await service.notifyBookingConfirmed('organizer-user-1', 'event-1', 'enr-1', 'Summer Fest', 'EVX-12345', 1);

    expect(mockEmailService.send.mock.calls[0][3]).toBeUndefined();
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

describe('NotificationService — admin queue fan-out', () => {
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
      // find() resolves the admin recipients; findOne() is the per-job lookup inside enqueue().
      find: jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]),
      findOne: jest.fn().mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', emailEnabled: true }),
    };
    mockDeviceTokenRepo = { find: jest.fn().mockResolvedValue([]) };
    mockEmailService = { send: jest.fn().mockResolvedValue(undefined) };
    mockPushService = { send: jest.fn().mockResolvedValue(undefined) };

    service = new NotificationService(mockJobsRepo, mockUsersRepo, mockDeviceTokenRepo, mockEmailService, mockPushService);
  });

  it('enqueues one job per admin when an event lands in the approval queue', async () => {
    await service.notifyAdminsEventPendingApproval('event-1', 'Summer Fest', 'Acme Events');

    expect(mockJobsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', type: 'event_pending_approval' }),
    );
    expect(mockJobsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-2', type: 'event_pending_approval' }),
    );
  });

  it('renders a refund request with the requester, event and amount', async () => {
    await service.notifyAdminsRefundRequested('refund-1', 'enr-1', 1500, 'Priya S', 'Summer Fest');

    const [, subject, html] = mockEmailService.send.mock.calls[0];
    expect(subject).toContain('refund');
    expect(html).toContain('Priya S');
    expect(html).toContain('Summer Fest');
    expect(html).toContain('1500.00');
  });

  it('never emails a block — dashboard + push only', async () => {
    await service.notifyAdminsUserBlocked('user-1', 'Ravi', 'user-2', 'Sam');

    expect(mockJobsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_blocked' }));
    expect(mockEmailService.send).not.toHaveBeenCalled();
  });

  it('escapes user-entered names in the in-app report notification', async () => {
    await service.notifyAdminsUserReported('report-1', 'user', 'user-9', '<img src=x onerror=alert(1)>', 'Spam');

    const records = await (async () => {
      mockJobsRepo.find = jest.fn().mockResolvedValue([
        {
          id: 'job-1',
          type: 'user_reported',
          payload: { reporterName: '<img src=x onerror=alert(1)>', targetType: 'user', reason: 'Spam' },
          createdAt: new Date(),
          readAt: null,
        },
      ]);
      return service.findMyNotifications('admin-1');
    })();

    expect(records[0].body).toContain('&lt;img');
    expect(records[0].body).not.toContain('<img');
  });

  it('logs and returns quietly when there are no admin accounts', async () => {
    mockUsersRepo.find.mockResolvedValue([]);

    await expect(service.notifyAdminsEventPendingApproval('event-1', 'Summer Fest', 'Acme')).resolves.toBeUndefined();
    expect(mockJobsRepo.save).not.toHaveBeenCalled();
  });
});
