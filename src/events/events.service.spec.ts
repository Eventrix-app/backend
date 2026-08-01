import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType, TicketCategory } from '../entities/ticket-type.entity';
import { Favorite } from '../entities/favorite.entity';
import { Follow } from '../entities/follow.entity';
import { EventMedia } from '../entities/event-media.entity';
import { DataSource, Not } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { NotificationService } from '../notifications/notification.service';
import { CacheService } from '../common/cache/cache.service';
import { FeeCalculationService } from '../payments/fee-calculation.service';

describe('EventsService - Fixed Issues', () => {
  let service: EventsService;
  let mockEventRepo: any;
  let mockEnrollmentRepo: any;
  let mockOrganizerRepo: any;
  let mockUserRepo: any;
  let mockCategoryRepo: any;
  let mockTicketTypeRepo: any;
  let mockFavoriteRepo: any;
  let mockFollowRepo: any;
  let mockEventMediaRepo: any;
  let mockDataSource: any;
  let mockJwtService: any;
  let mockAuditLogService: any;
  let mockWaitlistService: any;
  let mockNotificationService: any;
  let mockCacheService: any;
  let mockFeeCalculationService: any;

  beforeEach(async () => {
    mockEventRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      softRemove: jest.fn(),
    };

    mockEnrollmentRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      exist: jest.fn(),
      query: jest.fn(),
    };

    mockOrganizerRepo = {
      findOne: jest.fn(),
    };

    mockUserRepo = {
      findOne: jest.fn(),
    };

    mockCategoryRepo = {
      findOne: jest.fn(),
    };

    mockTicketTypeRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    };

    mockFavoriteRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
    };

    mockFollowRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
    };

    mockEventMediaRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    };

    mockDataSource = {
      transaction: jest.fn(),
    };

    mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
    };

    mockAuditLogService = {
      log: jest.fn(),
    };

    mockWaitlistService = {
      join: jest.fn(),
      findMyEntries: jest.fn(),
      promoteNext: jest.fn(),
      hasWaitingEntries: jest.fn().mockResolvedValue(false),
    };

    mockNotificationService = {
      notifyEventChanged: jest.fn(),
      notifyWaitlistPromoted: jest.fn(),
      notifyRefundStatus: jest.fn(),
      notifyBookingConfirmed: jest.fn(),
      notifyEventCancelled: jest.fn(),
      notifyEventApproved: jest.fn(),
      notifyEventRejected: jest.fn(),
    };

    mockCacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      getVersion: jest.fn().mockResolvedValue(1),
      bumpVersion: jest.fn().mockResolvedValue(undefined),
    };

    mockFeeCalculationService = {
      calculate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: mockEventRepo },
        { provide: getRepositoryToken(Enrollment), useValue: mockEnrollmentRepo },
        { provide: getRepositoryToken(Organizer), useValue: mockOrganizerRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(EventCategory), useValue: mockCategoryRepo },
        { provide: getRepositoryToken(TicketType), useValue: mockTicketTypeRepo },
        { provide: getRepositoryToken(Favorite), useValue: mockFavoriteRepo },
        { provide: getRepositoryToken(Follow), useValue: mockFollowRepo },
        { provide: getRepositoryToken(EventMedia), useValue: mockEventMediaRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: WaitlistService, useValue: mockWaitlistService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: FeeCalculationService, useValue: mockFeeCalculationService },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  describe('Issue 1: Approval Status Validation', () => {
    it('should only accept valid approval status enum values', async () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.APPROVED;
      
      expect(event.approvalStatus).toBe('approved');
      expect(Object.values(EventApprovalStatus)).toContain(event.approvalStatus);
    });
  });

  describe('Issue 2: Overbooking Prevention', () => {
    it('should join the waitlist instead of failing outright when no tickets are available', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 10, quantityTotal: 10 }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent) // initial event fetch (with ticketTypes)
            .mockResolvedValueOnce(null), // enrollment duplicate check
          query: jest.fn().mockResolvedValue([[], 0]), // no rows updated => sold out
        };
        return callback(mockManager);
      });

      const waitlistEntry = { id: 'wl-1', ticketTypeId: 'tt-1', userId: 'user-1' };
      mockWaitlistService.join.mockResolvedValue(waitlistEntry);

      const result = await service.enroll('event-1', 'user-1', 'tt-1');

      expect(mockWaitlistService.join).toHaveBeenCalledWith('event-1', 'tt-1', 'user-1', 1);
      expect(result).toBe(waitlistEntry);
    });

    it('should atomically decrement tickets on successful enrollment', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10 }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent) // initial event fetch (with ticketTypes)
            .mockResolvedValueOnce(null), // enrollment duplicate check
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '100.00' }], 1]),
          create: jest.fn().mockImplementation((entity, data) => data),
          save: jest.fn().mockImplementation((entity, data) => {
            if (entity === Enrollment) {
              expect(data.totalAmount).toBe(100);
              expect(data.ticketTypeId).toBe('tt-1');
            }
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1', 'tt-1');
    });

    it('charges the participant-fee markup when the event passes fees to the buyer', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        feePayer: 'participant',
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10 }],
        canEnroll: () => true,
      };
      mockFeeCalculationService.calculate.mockReturnValue({ buyerPrice: 110 });

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent) // initial event fetch (with ticketTypes)
            .mockResolvedValueOnce(null) // enrollment duplicate check
            .mockResolvedValueOnce({ commissionRate: 8, commissionFlatFee: 2 }), // organizer commission config
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '100.00' }], 1]),
          create: jest.fn().mockImplementation((entity, data) => data),
          save: jest.fn().mockImplementation((entity, data) => {
            if (entity === Enrollment) {
              expect(data.totalAmount).toBe(110);
            }
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1', 'tt-1');

      expect(mockFeeCalculationService.calculate).toHaveBeenCalledWith(
        100,
        { commissionRate: 8, commissionFlatFee: 2 },
        'participant',
      );
    });
  });

  describe('Ticket type access password', () => {
    const mockEvent = {
      id: 'event-1',
      approvalStatus: EventApprovalStatus.APPROVED,
      status: EventStatus.UPCOMING,
      capacity: null,
      ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10, minPerOrder: 1, accessPassword: 'secret123' }],
      canEnroll: () => true,
    };

    it('rejects enrollment in a password-protected ticket type with no password supplied', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true })
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(null),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1', 'tt-1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects enrollment with the wrong password', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true })
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(null),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1', 'tt-1', 1, 'wrong-password')).rejects.toThrow(ForbiddenException);
    });

    it('allows enrollment with the correct password', async () => {
      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true })
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(null),
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
          create: jest.fn().mockImplementation((entity, data) => data),
          save: jest.fn().mockImplementation((entity, data) => Promise.resolve(data)),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1', 'tt-1', 1, 'secret123')).resolves.toBeDefined();
    });
  });

  describe('removeTicketType', () => {
    const mockEvent = { id: 'event-1', organizerId: 'org-1' };

    it('rejects removal when people are currently waitlisted for the tier, even with zero sales', async () => {
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockTicketTypeRepo.findOne.mockResolvedValue({ id: 'tt-1', eventId: 'event-1', quantitySold: 0 });
      mockWaitlistService.hasWaitingEntries.mockResolvedValue(true);

      await expect(service.removeTicketType('event-1', 'tt-1', 'admin-1', ['admin'])).rejects.toThrow(ForbiddenException);
      expect(mockTicketTypeRepo.remove).not.toHaveBeenCalled();
    });

    it('allows removal when there are no sales and nobody is waitlisted', async () => {
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockTicketTypeRepo.findOne.mockResolvedValue({ id: 'tt-1', eventId: 'event-1', quantitySold: 0 });
      mockWaitlistService.hasWaitingEntries.mockResolvedValue(false);

      await service.removeTicketType('event-1', 'tt-1', 'admin-1', ['admin']);

      expect(mockTicketTypeRepo.remove).toHaveBeenCalled();
    });
  });

  describe('Ticket type sales window', () => {
    it('should reject enrollment before salesStartAt', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10, salesStartAt: future }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn().mockImplementation((entity: any) =>
            entity === User ? Promise.resolve({ isEmailVerified: true }) : Promise.resolve(mockEvent)),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1', 'tt-1')).rejects.toThrow(BadRequestException);
    });

    it('should reject enrollment after salesEndAt', async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10, salesEndAt: past }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn().mockImplementation((entity: any) =>
            entity === User ? Promise.resolve({ isEmailVerified: true }) : Promise.resolve(mockEvent)),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1', 'tt-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Issue 4: Organizer Existence Check', () => {
    it('should validate organizer exists when creating event', async () => {
      mockCategoryRepo.findOne.mockResolvedValue({ id: 'cat-1' });
      mockOrganizerRepo.findOne.mockResolvedValue(null);

      const createDto = {
        organizerId: 'invalid-org',
        categoryId: 'cat-1',
        title: 'Test Event',
        venueName: 'Test Venue',
        venueAddress: 'Test Address',
        eventDate: '2025-12-31',
        startTime: '10:00:00',
      };

      await expect(service.create(createDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('Issue 5: Price Validation', () => {
    it('should reject negative prices at entity level', () => {
      const event = new Event();
      event.pricePerTicket = -100;
      
      expect(() => event.validateAndCalculate()).toThrow('Price per ticket cannot be negative');
    });
  });

  describe('Issue 6: URL Validation', () => {
    it('should validate image URLs', () => {
      const event = new Event();
      event.imageUrl = 'not-a-valid-url';
      
      expect(() => event.validateAndCalculate()).toThrow('Invalid image URL format');
    });

    it('should accept valid URLs', () => {
      const event = new Event();
      event.imageUrl = 'https://example.com/image.jpg';
      
      expect(() => event.validateAndCalculate()).not.toThrow();
    });
  });

  describe('Issue 7: Audit Trail', () => {
    it('should record who approved the event and when', async () => {
      const mockEvent = {
        id: 'event-1',
        title: 'Test Event',
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
        organizer: { userId: 'organizer-user-1' },
      };

      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEventRepo.save.mockImplementation((event) => {
        expect(event.approvedBy).toBe('admin-1');
        expect(event.approvedAt).toBeInstanceOf(Date);
        expect(event.approvalStatus).toBe(EventApprovalStatus.APPROVED);
        return Promise.resolve(event);
      });

      await service.approve('event-1', 'admin-1');
      expect(mockNotificationService.notifyEventApproved).toHaveBeenCalledWith('organizer-user-1', 'event-1', 'Test Event');
    });

    it('should record who rejected the event and when', async () => {
      const mockEvent = {
        id: 'event-1',
        title: 'Test Event',
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
        organizer: { userId: 'organizer-user-1' },
      };

      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEventRepo.save.mockImplementation((event) => {
        expect(event.rejectedBy).toBe('admin-1');
        expect(event.rejectedAt).toBeInstanceOf(Date);
        expect(event.rejectionReason).toBe('Inappropriate content');
        return Promise.resolve(event);
      });

      await service.reject('event-1', 'Inappropriate content', 'admin-1');
      expect(mockNotificationService.notifyEventRejected).toHaveBeenCalledWith(
        'organizer-user-1',
        'event-1',
        'Test Event',
        'Inappropriate content',
      );
    });
  });

  describe('Issue 8: Enrollment Status Enforcement', () => {
    it('should prevent enrollment in non-approved events', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
        status: EventStatus.UPCOMING,
        canEnroll: () => false,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn().mockImplementation((entity: any) =>
            entity === User ? Promise.resolve({ isEmailVerified: true }) : Promise.resolve(mockEvent)),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Issue 9: Pagination', () => {
    it('should return paginated results with metadata', async () => {
      mockEventRepo.findAndCount.mockResolvedValue([
        [{ id: 'event-1' }, { id: 'event-2' }],
        25,
      ]);

      const result = await service.findAllFiltered({ page: 2, limit: 10 });

      expect(result.events).toHaveLength(2);
      expect(result.total).toBe(25);
      expect(result.page).toBe(2);
      expect(result.totalPages).toBe(3);
    });
  });

  describe('Issue 10: Event Deletion Guard & Approval-Status Gating (loophole fixes)', () => {
    it('blocks deleting an event that still has active (confirmed/pending) enrollments', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1' };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEnrollmentRepo.count.mockResolvedValue(2);

      await expect(service.remove('event-1', 'user-1', ['admin'])).rejects.toThrow(ConflictException);
      expect(mockEventRepo.softRemove).not.toHaveBeenCalled();
    });

    it('allows deleting an event once no active enrollments remain', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', title: 'Test Event' };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEnrollmentRepo.count.mockResolvedValue(0);
      mockEventRepo.softRemove.mockResolvedValue(undefined);

      await service.remove('event-1', 'user-1', ['admin']);

      expect(mockEventRepo.softRemove).toHaveBeenCalledWith(mockEvent);
    });
  });

  describe('cancelEvent', () => {
    const futureEventFields = {
      eventDate: '2099-01-01',
      startTime: '10:00:00',
      eventEndDate: null,
      endTime: null,
    };

    it('rejects a non-owner, non-admin organizer', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', status: EventStatus.UPCOMING, ...futureEventFields };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-2', userId: 'other-user' });

      await expect(service.cancelEvent('event-1', 'other-user', [])).rejects.toThrow(ForbiddenException);
      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });

    it('rejects cancelling an already-cancelled event', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', status: EventStatus.CANCELLED, ...futureEventFields };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);

      await expect(service.cancelEvent('event-1', 'admin-1', ['admin'])).rejects.toThrow(BadRequestException);
      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });

    it('rejects cancelling an event that has already ended', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        status: EventStatus.UPCOMING,
        eventDate: '2000-01-01',
        startTime: '10:00:00',
        eventEndDate: null,
        endTime: null,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);

      await expect(service.cancelEvent('event-1', 'admin-1', ['admin'])).rejects.toThrow(BadRequestException);
      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });

    it('cancels an upcoming event and notifies every active attendee, deduplicated by user', async () => {
      const mockEvent = { id: 'event-1', title: 'Big Show', organizerId: 'org-1', status: EventStatus.UPCOMING, ...futureEventFields };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEventRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockEnrollmentRepo.find.mockResolvedValue([
        { userId: 'user-1', status: 'confirmed' },
        { userId: 'user-2', status: 'pending' },
        { userId: 'user-1', status: 'confirmed' }, // duplicate ticket, same user
      ]);

      const result = await service.cancelEvent('event-1', 'admin-1', ['admin'], 'Venue unavailable');

      expect(result.status).toBe(EventStatus.CANCELLED);
      expect(mockEventRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: EventStatus.CANCELLED }));
      // Fire-and-forget notification — flush pending microtasks before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockNotificationService.notifyEventCancelled).toHaveBeenCalledWith(
        expect.arrayContaining(['user-1', 'user-2']),
        'event-1',
        'Big Show',
        'Venue unavailable',
      );
      expect((mockNotificationService.notifyEventCancelled as jest.Mock).mock.calls[0][0]).toHaveLength(2);
    });

    it('rejects creating a new ticket type on a rejected event', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.REJECTED };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });

      await expect(
        service.createTicketType('event-1', { category: TicketCategory.GENERAL, price: 10, quantityTotal: 10 } as any, 'user-1', []),
      ).rejects.toThrow(BadRequestException);
      expect(mockTicketTypeRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a ticket type whose sales window start is not before its end', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        eventDate: '2099-01-05',
        startTime: '10:00',
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });

      await expect(
        service.createTicketType(
          'event-1',
          {
            category: TicketCategory.GENERAL,
            price: 10,
            quantityTotal: 10,
            salesStartAt: '2099-01-01T12:00:00.000Z',
            salesEndAt: '2099-01-01T10:00:00.000Z',
          } as any,
          'user-1',
          [],
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockTicketTypeRepo.save).not.toHaveBeenCalled();
    });

    it('hides ticket types from a public viewer when the event is not approved', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.PENDING_APPROVAL, isApproved: () => false };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);

      const result = await service.findTicketTypes('event-1');

      expect(result).toEqual([]);
      expect(mockTicketTypeRepo.find).not.toHaveBeenCalled();
    });

    it('still shows ticket types to the owning organizer even when not yet approved', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.PENDING_APPROVAL, isApproved: () => false };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.find.mockResolvedValue([{ id: 'tt-1', isHidden: false }]);

      const result = await service.findTicketTypes('event-1', 'user-1', []);

      expect(result).toHaveLength(1);
    });

    it('findOneForViewer hides a pending/rejected event from an anonymous or unrelated viewer', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.REJECTED, isApproved: () => false };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);

      await expect(service.findOneForViewer('event-1')).rejects.toThrow(NotFoundException);

      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-2', userId: 'other-user' });
      await expect(service.findOneForViewer('event-1', 'other-user', [])).rejects.toThrow(NotFoundException);
    });

    it('findOneForViewer still returns a pending event to its owning organizer', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.PENDING_APPROVAL, isApproved: () => false };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });

      const result = await service.findOneForViewer('event-1', 'user-1', []);

      // Not toBe: findOneForViewer now returns a fresh object with totalCapacity/
      // availableTickets/isCompleted recomputed (withComputedFields), not the raw entity
      // instance — same content, new reference. isCompleted is false here since this mock
      // has no eventDate/startTime, so getEventEndDateTime resolves to an invalid (NaN) time.
      expect(result).toEqual({ ...mockEvent, isCompleted: false });
    });

    it('findOneForViewer hides a cancelled event from an anonymous or non-enrolled viewer', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.CANCELLED,
        isApproved: () => true,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue(null);
      mockEnrollmentRepo.exist.mockResolvedValue(false);

      await expect(service.findOneForViewer('event-1')).rejects.toThrow(NotFoundException);
      await expect(service.findOneForViewer('event-1', 'other-user', [])).rejects.toThrow(NotFoundException);
    });

    it('findOneForViewer still shows a cancelled event to someone with any enrollment for it', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.CANCELLED,
        isApproved: () => true,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue(null);
      mockEnrollmentRepo.exist.mockResolvedValue(true);

      const result = await service.findOneForViewer('event-1', 'attendee-1', []);
      expect(result).toEqual({ ...mockEvent, isCompleted: false });
      expect(mockEnrollmentRepo.exist).toHaveBeenCalledWith({ where: { eventId: 'event-1', userId: 'attendee-1' } });
    });

    it('findOneForViewer still shows a cancelled event to its owning organizer without checking enrollment', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.CANCELLED,
        isApproved: () => true,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });

      const result = await service.findOneForViewer('event-1', 'user-1', []);
      expect(result).toEqual({ ...mockEvent, isCompleted: false });
      expect(mockEnrollmentRepo.exist).not.toHaveBeenCalled();
    });
  });

  // Regression tests: update()'s switchingToPaid guard closes the free-to-paid loophole
  // for the legacy flat pricePerTicket field, but nested ticket-type CRUD is the other
  // place an event's real pricing can change post-creation, and it wasn't wired to the
  // same guard — a free, auto-approved event could get a paid tier added/repriced later
  // with zero admin review and event.isPaid never flipping to true.
  describe('Issue 12: free-to-paid loophole via nested ticket-type CRUD', () => {
    it('createTicketType: pricing a new tier above zero on a free, already-approved event flips isPaid and sends it back for review', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: false,
        approvalStatus: EventApprovalStatus.APPROVED,
        approvalMethod: 'auto',
        approvedAt: new Date('2026-01-01'),
        approvedBy: 'admin-1',
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockEventRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockTicketTypeRepo.create.mockImplementation((data: any) => data);
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.createTicketType('event-1', { category: TicketCategory.VIP, price: 500 } as any, 'user-1', []);

      expect(mockEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isPaid: true,
          approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
          approvalMethod: undefined,
          approvedAt: undefined,
          approvedBy: undefined,
        }),
      );
    });

    it('createTicketType: a zero-price (free) tier does not touch isPaid or approvalStatus', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: false,
        approvalStatus: EventApprovalStatus.APPROVED,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.create.mockImplementation((data: any) => data);
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.createTicketType('event-1', { category: TicketCategory.GENERAL, price: 0 } as any, 'user-1', []);

      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });

    it('updateTicketType: raising an existing tier from free to paid on an approved event reopens review', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: false,
        approvalStatus: EventApprovalStatus.APPROVED,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockEventRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockTicketTypeRepo.findOne.mockResolvedValue({ id: 'tt-1', eventId: 'event-1', price: 0, quantitySold: 0 });
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.updateTicketType('event-1', 'tt-1', { price: 250 } as any, 'user-1', []);

      expect(mockEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isPaid: true, approvalStatus: EventApprovalStatus.PENDING_APPROVAL }),
      );
    });

    it('updateTicketType: an already-paid event is not re-sent for review when a tier price simply changes', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: true,
        approvalStatus: EventApprovalStatus.APPROVED,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.findOne.mockResolvedValue({ id: 'tt-1', eventId: 'event-1', price: 200, quantitySold: 0 });
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.updateTicketType('event-1', 'tt-1', { price: 350 } as any, 'user-1', []);

      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });
  });

  // Regression coverage for the switch from a free-text tier name to a fixed category
  // vocabulary (EARLY_BIRD / GENERAL / VIP): CreateTicketTypeDto no longer has a `name`
  // field at all, so the stored name has to come from somewhere, and it has to come from
  // the server — not the client — or the whole point of the enum (a controlled, comparable
  // set of ticket types across every event) is defeated by a client that just sends
  // `category: 'VIP', name: 'anything I want'` alongside it.
  describe('ticket type category -> name derivation', () => {
    it('createTicketType stores the category label as name, not anything client-supplied', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: true,
        approvalStatus: EventApprovalStatus.APPROVED,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.create.mockImplementation((data: any) => data);
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.createTicketType(
        'event-1',
        { category: TicketCategory.VIP, price: 499, name: 'Ignore Me' } as any,
        'user-1',
        [],
      );

      expect(result.category).toBe(TicketCategory.VIP);
      expect(result.name).toBe('VIP Pass');
    });

    it('createTicketType persists the benefits list as given', async () => {
      const mockEvent = {
        id: 'event-1',
        organizerId: 'org-1',
        isPaid: true,
        approvalStatus: EventApprovalStatus.APPROVED,
      };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.create.mockImplementation((data: any) => data);
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.createTicketType(
        'event-1',
        { category: TicketCategory.EARLY_BIRD, price: 199, benefits: ['Marathon entry', 'Finisher medal'] } as any,
        'user-1',
        [],
      );

      expect(result.benefits).toEqual(['Marathon entry', 'Finisher medal']);
    });

    it('updateTicketType recomputes name when the category changes', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', isPaid: true, approvalStatus: EventApprovalStatus.APPROVED };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.findOne.mockResolvedValue({
        id: 'tt-1',
        eventId: 'event-1',
        category: TicketCategory.GENERAL,
        name: 'General Pass',
        price: 200,
        quantitySold: 0,
      });
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.updateTicketType(
        'event-1',
        'tt-1',
        { category: TicketCategory.VIP } as any,
        'user-1',
        [],
      );

      expect(result.category).toBe(TicketCategory.VIP);
      expect(result.name).toBe('VIP Pass');
    });

    it('updateTicketType leaves name and category untouched when neither is part of the update', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', isPaid: true, approvalStatus: EventApprovalStatus.APPROVED };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockTicketTypeRepo.findOne.mockResolvedValue({
        id: 'tt-1',
        eventId: 'event-1',
        category: TicketCategory.EARLY_BIRD,
        name: 'Early Bird Pass',
        price: 200,
        quantitySold: 0,
      });
      mockTicketTypeRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.updateTicketType('event-1', 'tt-1', { price: 250 } as any, 'user-1', []);

      expect(result.category).toBe(TicketCategory.EARLY_BIRD);
      expect(result.name).toBe('Early Bird Pass');
    });
  });

  // Regression tests for the logs.md finding: a refund was fully processed for an
  // enrollment whose paymentStatus was still "pending" (the payment webhook hadn't
  // fired yet), and a later webhook then resurrected the refunded booking. paymentStatus
  // must be set correctly at enroll time and enforced at check-in.
  describe('Issue 11: paymentStatus enforcement', () => {
    it('marks a free ticket enrollment as paid immediately (no gateway/webhook will ever confirm it) and emails a booking confirmation', async () => {
      const mockEvent = {
        id: 'event-1',
        title: 'Free Meetup',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10 }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(null),
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
          create: jest.fn().mockImplementation((entity: any, data: any) => data),
          save: jest.fn().mockImplementation((entity: any, data: any) => {
            if (entity === Enrollment) {
              expect(data.paymentStatus).toBe('paid');
              return Promise.resolve({ id: 'enr-1', quantity: 1, ...data });
            }
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1', 'tt-1');

      expect(mockNotificationService.notifyBookingConfirmed).toHaveBeenCalledWith(
        'user-1',
        'event-1',
        'enr-1',
        'Free Meetup',
        expect.stringMatching(/^BK-/),
        1,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('leaves a paid ticket enrollment pending until the payment webhook confirms it', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10 }],
        canEnroll: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(null),
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '99.99' }], 1]),
          create: jest.fn().mockImplementation((entity: any, data: any) => data),
          save: jest.fn().mockImplementation((entity: any, data: any) => {
            if (entity === Enrollment) {
              expect(data.paymentStatus).toBe('pending');
            }
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1', 'tt-1');
    });

    it('allows re-enrolling in the same event after a previous booking was cancelled', async () => {
      // Regression test: enroll() previously checked for *any* existing enrollment
      // (Enrollment.findOne({ eventId, userId })) regardless of status, so a cancelled
      // booking left a row that made every future enroll() attempt for that event 409
      // forever, matching the DB's old unconditional @Unique(['userId','eventId']).
      const mockEvent = {
        id: 'event-1',
        title: 'Free Meetup',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        capacity: null,
        ticketTypes: [{ id: 'tt-1', quantitySold: 0, quantityTotal: 10 }],
        canEnroll: () => true,
      };
      let existingEnrollmentQuery: any;

      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce({ isEmailVerified: true }) // user email-verification check
            .mockResolvedValueOnce(mockEvent)
            .mockImplementationOnce((entity: any, opts: any) => {
              existingEnrollmentQuery = opts;
              // A real DB-level partial-unique-index query would return null here for a
              // user whose only prior row is cancelled — asserting that behavior.
              return Promise.resolve(null);
            }),
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
          create: jest.fn().mockImplementation((entity: any, data: any) => data),
          save: jest.fn().mockImplementation((entity: any, data: any) => Promise.resolve({ id: 'enr-2', quantity: 1, ...data })),
        };
        return callback(mockManager);
      });

      const result = await service.enroll('event-1', 'user-1', 'tt-1');

      expect(existingEnrollmentQuery.where.status).toEqual(Not('cancelled'));
      expect((result as any).soldOut).toBeFalsy();
    });

    it('rejects check-in when the booking has not been paid for', async () => {
      mockJwtService.verify.mockReturnValue({ enrollmentId: 'enr-1', eventId: 'event-1' });
      mockEnrollmentRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        eventId: 'event-1',
        paymentStatus: 'pending',
        checkedInAt: null,
        event: { organizerId: 'org-1' },
      });

      await expect(service.checkIn('token', 'admin-1', ['admin'])).rejects.toThrow(BadRequestException);
      expect(mockEnrollmentRepo.save).not.toHaveBeenCalled();
    });

    it('allows check-in once the booking is paid', async () => {
      mockJwtService.verify.mockReturnValue({ enrollmentId: 'enr-1', eventId: 'event-1' });
      const enrollment = {
        id: 'enr-1',
        eventId: 'event-1',
        paymentStatus: 'paid',
        checkedInAt: null,
        event: { organizerId: 'org-1' },
      };
      mockEnrollmentRepo.findOne.mockResolvedValue(enrollment);
      mockEnrollmentRepo.query.mockResolvedValue([{ used_date: new Date() }]);

      const result = await service.checkIn('token', 'admin-1', ['admin']);

      expect(result.checkedInAt).toBeInstanceOf(Date);
    });

    it('rejects a second concurrent check-in of the same ticket', async () => {
      // Regression test: checkIn() previously did a read-then-write (check
      // enrollment.checkedInAt, then save()), which raced when the same ticket was
      // scanned twice concurrently — both calls could read checkedInAt as null before
      // either write landed. The atomic UPDATE ... WHERE used_date IS NULL claim
      // returns zero rows for the losing call, which must surface as a 409, not a
      // silent double check-in.
      mockJwtService.verify.mockReturnValue({ enrollmentId: 'enr-1', eventId: 'event-1' });
      const enrollment = {
        id: 'enr-1',
        eventId: 'event-1',
        paymentStatus: 'paid',
        checkedInAt: null,
        event: { organizerId: 'org-1' },
      };
      mockEnrollmentRepo.findOne.mockResolvedValue(enrollment);
      mockEnrollmentRepo.query.mockResolvedValue([]);

      await expect(service.checkIn('token', 'admin-1', ['admin'])).rejects.toThrow(ConflictException);
    });

    it('treats a replay of the same scan as success, not a conflict', async () => {
      // The offline queue replays a scan whose response was lost, or which reached the
      // server just as connectivity died. The claim loses (used_date is already set), but
      // the stored key proves it was *this* scan that set it — nobody was admitted twice,
      // so surfacing a 409 here would make the client discard a legitimately synced entry
      // and would show the organizer a duplicate warning for their own retry.
      mockJwtService.verify.mockReturnValue({ enrollmentId: 'enr-1', eventId: 'event-1' });
      const claimedAt = new Date();
      mockEnrollmentRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        eventId: 'event-1',
        paymentStatus: 'paid',
        checkedInAt: null,
        event: { organizerId: 'org-1' },
      });
      mockEnrollmentRepo.query
        .mockResolvedValueOnce([]) // claim lost — already checked in
        .mockResolvedValueOnce([
          { used_date: claimedAt, check_in_key: 'scan-abc', checked_in_by: 'admin-1' },
        ]);

      const result = await service.checkIn('token', 'admin-1', ['admin'], 'scan-abc');

      expect(result.checkedInAt).toBe(claimedAt);
    });

    it('reports a different scan of an already-used ticket as a duplicate', async () => {
      // The two-offline-gates case: device B scanned a ticket device A had already claimed.
      // This one must stay a 409 — but carrying enough detail (when, and by whom) for the
      // client to record it as a real double-entry rather than silently dropping it the way
      // it has to when a bare "already checked in" is all it gets.
      mockJwtService.verify.mockReturnValue({ enrollmentId: 'enr-1', eventId: 'event-1' });
      const firstScanAt = new Date();
      mockEnrollmentRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        eventId: 'event-1',
        paymentStatus: 'paid',
        checkedInAt: null,
        event: { organizerId: 'org-1' },
      });
      mockEnrollmentRepo.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { used_date: firstScanAt, check_in_key: 'scan-from-gate-1', checked_in_by: 'organizer-1' },
        ]);

      await expect(
        service.checkIn('token', 'admin-1', ['admin'], 'scan-from-gate-2'),
      ).rejects.toMatchObject({
        response: {
          duplicateScan: true,
          checkedInAt: firstScanAt,
          checkedInBy: 'organizer-1',
        },
      });
    });
  });

  describe('findMyEnrollments', () => {
    it('returns only the requesting user\'s enrollments, most recent first', async () => {
      const enrollments = [{ id: 'e2', userId: 'user-1' }, { id: 'e1', userId: 'user-1' }];
      mockEnrollmentRepo.find.mockResolvedValue(enrollments);

      const result = await service.findMyEnrollments('user-1');

      expect(mockEnrollmentRepo.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        relations: ['event', 'ticketType'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toBe(enrollments);
    });
  });

  describe('findEnrollments / searchEnrollments — enrollment.user PII scoping', () => {
    it('findEnrollments scopes the joined user relation to safe fields', async () => {
      mockEventRepo.findOne.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' });
      const enrollments = [{ id: 'enr-1' }];
      mockEnrollmentRepo.find.mockResolvedValue(enrollments);

      const result = await service.findEnrollments('event-1', 'admin-1', ['admin']);

      expect(mockEnrollmentRepo.find).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
        relations: ['user'],
        select: { user: { id: true, email: true, fullName: true } },
      });
      expect(result).toBe(enrollments);
    });

    it('searchEnrollments scopes the joined user relation to safe fields', async () => {
      mockEventRepo.findOne.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' });
      mockEnrollmentRepo.find.mockResolvedValue([]);

      await service.searchEnrollments('event-1', 'Jane', 'admin-1', ['admin']);

      const call = mockEnrollmentRepo.find.mock.calls[0][0];
      expect(call.relations).toEqual(['user']);
      expect(call.select).toEqual({ user: { id: true, email: true, fullName: true } });
    });
  });

  describe('createForUser - organizer verification gate (#7)', () => {
    const baseDto = {
      categoryId: 'cat-1',
      title: 'Test Event',
      venueName: 'Test Venue',
      venueAddress: 'Test Address',
      eventDate: '2099-12-31',
      startTime: '10:00:00',
    };

    beforeEach(() => {
      mockCategoryRepo.findOne.mockResolvedValue({ id: 'cat-1' });
      mockUserRepo.findOne.mockResolvedValue({ id: 'user-1', roles: ['user'] });
    });

    it('rejects a user with no organizer profile at all', async () => {
      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockImplementation((entity: any) => (entity === User
              ? Promise.resolve({ id: 'user-1', roles: ['user'] })
              : Promise.resolve(null))), // no Organizer row yet
        };
        return callback(mockManager);
      });

      await expect(service.createForUser({ ...baseDto } as any, 'user-1', ['user'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a user whose organizer profile exists but is not document_verified', async () => {
      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockImplementation((entity: any) => (entity === User
              ? Promise.resolve({ id: 'user-1', roles: ['user'] })
              : Promise.resolve({ id: 'org-1', userId: 'user-1', verificationLevel: 'email_verified' }))),
        };
        return callback(mockManager);
      });

      await expect(service.createForUser({ ...baseDto } as any, 'user-1', ['user'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows a document_verified organizer to create an event', async () => {
      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockImplementation((entity: any) => (entity === User
              ? Promise.resolve({ id: 'user-1', roles: ['user', 'organizer'], isEmailVerified: true })
              : Promise.resolve({ id: 'org-1', userId: 'user-1', verificationLevel: 'document_verified', autoApproveEvents: false }))),
          create: jest.fn((_entity: any, data: any) => data),
          save: jest.fn((_entity: any, data: any) => Promise.resolve({ ...data, id: 'event-1' })),
        };
        return callback(mockManager);
      });

      const result = await service.createForUser({ ...baseDto } as any, 'user-1', ['user']);
      expect(result.id).toBe('event-1');
    });

    it('lets an admin creating on behalf of an explicit organizerId bypass the gate', async () => {
      mockDataSource.transaction.mockImplementation(async (callback: any) => {
        const mockManager = {
          findOne: jest.fn()
            .mockImplementation((entity: any) => (entity === User
              ? Promise.resolve({ id: 'admin-1', roles: ['admin'], isEmailVerified: true })
              : Promise.resolve(null))), // admin has no organizer profile of their own
          create: jest.fn((_entity: any, data: any) => data),
          save: jest.fn((_entity: any, data: any) => Promise.resolve({ ...data, id: 'event-2' })),
        };
        return callback(mockManager);
      });
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-target', user: { deletedAt: null } });

      const result = await service.createForUser(
        { ...baseDto, organizerId: 'org-target' } as any,
        'admin-1',
        ['admin'],
      );
      expect(result.id).toBe('event-2');
    });
  });

  describe('Helper Methods', () => {
    it('canEnroll should return true only for approved upcoming events with tickets', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.APPROVED;
      event.status = EventStatus.UPCOMING;

      expect(event.canEnroll()).toBe(true);
    });

    it('canEnroll should return false for non-approved events', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
      event.status = EventStatus.UPCOMING;

      expect(event.canEnroll()).toBe(false);
    });

    it('isApproved should return true only for approved status', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.APPROVED;

      expect(event.isApproved()).toBe(true);
    });
  });
});
