import { WaitlistService } from './waitlist.service';
import { WaitlistStatus } from '../entities/waitlist-entry.entity';
import { Enrollment } from '../entities/enrollment.entity';

// Regression test mirroring EventsService.enroll(): a waitlist-promoted enrollment for a
// free ticket has no gateway/webhook to confirm payment later, so it must be marked
// settled immediately, same as the primary enrollment path.
describe('WaitlistService — promoteNext paymentStatus', () => {
  let service: WaitlistService;
  let mockWaitlistRepo: any;
  let mockDataSource: any;
  let mockJwtService: any;
  let mockNotificationService: any;
  let mockCacheService: any;

  let entry: any;

  beforeEach(() => {
    // tryPromote() mutates the passed entry in place (status -> PROMOTED), so each test
    // needs its own fresh object rather than sharing one across the suite.
    entry = { id: 'wl-1', ticketTypeId: 'tt-1', eventId: 'event-1', userId: 'user-1', quantity: 1, status: WaitlistStatus.WAITING };
    mockWaitlistRepo = { find: jest.fn().mockResolvedValue([entry]) };
    mockDataSource = { transaction: jest.fn() };
    mockJwtService = { sign: jest.fn(() => 'ticket-code') };
    mockNotificationService = { notifyWaitlistPromoted: jest.fn() };
    mockCacheService = { del: jest.fn(), bumpVersion: jest.fn() };
    service = new WaitlistService(mockWaitlistRepo, mockDataSource, mockJwtService, mockNotificationService, mockCacheService);
  });

  it('marks a promoted free-ticket enrollment as paid', async () => {
    let capturedEnrollment: any;
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(entry),
        query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
        create: jest.fn().mockImplementation((entity: any, data: any) => data),
        save: jest.fn().mockImplementation((entity: any, data: any) => {
          if (entity === Enrollment) capturedEnrollment = data;
          return Promise.resolve(data);
        }),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    expect(capturedEnrollment.paymentStatus).toBe('paid');
  });

  it('leaves a promoted paid-ticket enrollment pending until the webhook confirms it', async () => {
    let capturedEnrollment: any;
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(entry),
        query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '49.99' }], 1]),
        create: jest.fn().mockImplementation((entity: any, data: any) => data),
        save: jest.fn().mockImplementation((entity: any, data: any) => {
          if (entity === Enrollment) capturedEnrollment = data;
          return Promise.resolve(data);
        }),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    expect(capturedEnrollment.paymentStatus).toBe('pending');
  });
});
