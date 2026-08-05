import { WaitlistService } from './waitlist.service';
import { WaitlistStatus } from '../entities/waitlist-entry.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Event, FeePayer } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';

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
  let mockEventsRepo: any;
  let mockOrganizersRepo: any;
  let mockFeeCalculationService: any;
  let mockLedgerService: any;

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
    mockEventsRepo = {};
    mockOrganizersRepo = {};
    mockFeeCalculationService = { calculate: jest.fn() };
    // A promoted FREE booking owes the same flat platform fee a direct enroll() does, and
    // neither reaches handleWebhook — WaitlistService books it straight to the ledger.
    mockLedgerService = { recordFreeBookingLedger: jest.fn().mockResolvedValue([]) };
    service = new WaitlistService(
      mockWaitlistRepo,
      mockEventsRepo,
      mockOrganizersRepo,
      mockDataSource,
      mockJwtService,
      mockNotificationService,
      mockCacheService,
      mockFeeCalculationService,
      mockLedgerService,
    );
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

  // A free booking must owe the platform's flat free-event fee whether it came from
  // enroll() or from a waitlist promotion. Neither path reaches handleWebhook, so if this
  // call is dropped the fee is simply never recorded for promoted bookings — the same
  // booking escaping the fee purely by how it was created.
  it('books the free-event platform fee on a promoted free booking', async () => {
    mockFeeCalculationService.calculate.mockReturnValue({
      platformCommissionAmount: 12.5,
      gstAmount: 2.25,
      buyerPrice: 0,
    });
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(entry),
        query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
        create: jest.fn().mockImplementation((entity: any, data: any) => data),
        save: jest.fn().mockImplementation((entity: any, data: any) => Promise.resolve({ id: 'enr-promoted', ...data })),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    expect(mockLedgerService.recordFreeBookingLedger).toHaveBeenCalledWith(
      expect.anything(),
      'enr-promoted',
      expect.objectContaining({ platformCommissionAmount: 12.5 }),
      'enr-promoted',
      expect.any(String),
    );
  });

  it('does not book a free-event fee on a promoted PAID booking', async () => {
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockResolvedValue(entry),
        query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '49.99' }], 1]),
        create: jest.fn().mockImplementation((entity: any, data: any) => data),
        save: jest.fn().mockImplementation((entity: any, data: any) => Promise.resolve({ id: 'enr-paid', ...data })),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    expect(mockLedgerService.recordFreeBookingLedger).not.toHaveBeenCalled();
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

  it('does not promote an entry for an event that has already ended', async () => {
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockImplementation((ent: any) => {
          if (ent === Event) {
            return Promise.resolve({
              eventDate: '2000-01-01',
              eventEndDate: '2000-01-01',
              startTime: '10:00:00',
              endTime: '12:00:00',
            });
          }
          return Promise.resolve(entry);
        }),
        query: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    expect(entry.status).toBe(WaitlistStatus.WAITING);
  });

  it('does not promote an entry that would push the event past its aggregate capacity cap', async () => {
    const eventFixture = {
      organizerId: 'org-1',
      capacity: 100,
      ticketTypes: [{ quantitySold: 100 }],
    };
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockImplementation((entity: any) => {
          if (entity === Event) return Promise.resolve(eventFixture);
          return Promise.resolve(entry);
        }),
        query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '49.99' }], 1]),
        create: jest.fn(),
        save: jest.fn(),
      };
      return callback(manager);
    });

    await service.promoteNext('tt-1');

    // The tier still has its own headroom (its own quantity_total isn't tracked in this
    // fixture), but the event's aggregate cap is already fully sold — promotion must not
    // proceed, so the entry is left WAITING rather than flipped to PROMOTED.
    expect(entry.status).toBe(WaitlistStatus.WAITING);
  });

  it('charges the participant-fee markup on a promoted enrollment when the event passes fees to the buyer', async () => {
    let capturedEnrollment: any;
    mockFeeCalculationService.calculate.mockReturnValue({ buyerPrice: 55.5 });
    mockDataSource.transaction.mockImplementation(async (callback: any) => {
      const manager = {
        findOne: jest.fn().mockImplementation((entity: any) => {
          if (entity === Event) return Promise.resolve({ organizerId: 'org-1', feePayer: FeePayer.PARTICIPANT });
          if (entity === Organizer) return Promise.resolve({ commissionRate: 10, commissionFlatFee: 3 });
          return Promise.resolve(entry);
        }),
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

    expect(capturedEnrollment.totalAmount).toBe(55.5);
  });
});
