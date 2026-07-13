import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType } from '../entities/ticket-type.entity';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { NotificationService } from '../notifications/notification.service';

describe('EventsService - Fixed Issues', () => {
  let service: EventsService;
  let mockEventRepo: any;
  let mockEnrollmentRepo: any;
  let mockOrganizerRepo: any;
  let mockUserRepo: any;
  let mockCategoryRepo: any;
  let mockTicketTypeRepo: any;
  let mockDataSource: any;
  let mockJwtService: any;
  let mockAuditLogService: any;
  let mockWaitlistService: any;
  let mockNotificationService: any;

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
    };

    mockNotificationService = {
      notifyEventChanged: jest.fn(),
      notifyWaitlistPromoted: jest.fn(),
      notifyRefundStatus: jest.fn(),
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
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: WaitlistService, useValue: mockWaitlistService },
        { provide: NotificationService, useValue: mockNotificationService },
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
  });

  describe('Issue 3: Date/Time Handling', () => {
    it('should auto-calculate duration from start and end times', () => {
      const event = new Event();
      event.startTime = '14:00:00';
      event.endTime = '16:30:00';
      
      event.validateAndCalculate();
      
      expect(event.durationMinutes).toBe(150); // 2.5 hours
    });

    it('should handle overnight events correctly', () => {
      const event = new Event();
      event.startTime = '22:00:00';
      event.endTime = '02:00:00';
      
      event.validateAndCalculate();
      
      expect(event.durationMinutes).toBe(240); // 4 hours
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
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
      };

      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEventRepo.save.mockImplementation((event) => {
        expect(event.approvedBy).toBe('admin-1');
        expect(event.approvedAt).toBeInstanceOf(Date);
        expect(event.approvalStatus).toBe(EventApprovalStatus.APPROVED);
        return Promise.resolve(event);
      });

      await service.approve('event-1', 'admin-1');
    });

    it('should record who rejected the event and when', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
      };

      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockEventRepo.save.mockImplementation((event) => {
        expect(event.rejectedBy).toBe('admin-1');
        expect(event.rejectedAt).toBeInstanceOf(Date);
        expect(event.rejectionReason).toBe('Inappropriate content');
        return Promise.resolve(event);
      });

      await service.reject('event-1', 'Inappropriate content', 'admin-1');
    });
  });

  describe('Issue 8: Enrollment Status Enforcement', () => {
    it('should prevent enrollment in non-approved events', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
        status: EventStatus.UPCOMING,
        availableTickets: 10,
        canEnroll: () => false,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn().mockResolvedValue(mockEvent),
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

      const result = await service.findAllFiltered(undefined, undefined, 2, 10);

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

    it('rejects creating a new ticket type on a rejected event', async () => {
      const mockEvent = { id: 'event-1', organizerId: 'org-1', approvalStatus: EventApprovalStatus.REJECTED };
      mockEventRepo.findOne.mockResolvedValue(mockEvent);
      mockOrganizerRepo.findOne.mockResolvedValue({ id: 'org-1', userId: 'user-1' });

      await expect(
        service.createTicketType('event-1', { name: 'GA', price: 10, quantityTotal: 10 } as any, 'user-1', []),
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

      expect(result).toBe(mockEvent);
    });
  });

  // Regression tests for the logs.md finding: a refund was fully processed for an
  // enrollment whose paymentStatus was still "pending" (the payment webhook hadn't
  // fired yet), and a later webhook then resurrected the refunded booking. paymentStatus
  // must be set correctly at enroll time and enforced at check-in.
  describe('Issue 11: paymentStatus enforcement', () => {
    it('marks a free ticket enrollment as paid immediately (no gateway/webhook will ever confirm it)', async () => {
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
          findOne: jest.fn().mockResolvedValueOnce(mockEvent).mockResolvedValueOnce(null),
          query: jest.fn().mockResolvedValue([[{ id: 'tt-1', price: '0.00' }], 1]),
          create: jest.fn().mockImplementation((entity: any, data: any) => data),
          save: jest.fn().mockImplementation((entity: any, data: any) => {
            if (entity === Enrollment) {
              expect(data.paymentStatus).toBe('paid');
            }
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1', 'tt-1');
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
          findOne: jest.fn().mockResolvedValueOnce(mockEvent).mockResolvedValueOnce(null),
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
      mockEnrollmentRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.checkIn('token', 'admin-1', ['admin']);

      expect(result.checkedInAt).toBeInstanceOf(Date);
    });
  });

  describe('Helper Methods', () => {
    it('canEnroll should return true only for approved upcoming events with tickets', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.APPROVED;
      event.status = EventStatus.UPCOMING;
      event.availableTickets = 10;

      expect(event.canEnroll()).toBe(true);
    });

    it('canEnroll should return false for non-approved events', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
      event.status = EventStatus.UPCOMING;
      event.availableTickets = 10;

      expect(event.canEnroll()).toBe(false);
    });

    it('hasTicketsAvailable should return false when tickets are 0', () => {
      const event = new Event();
      event.availableTickets = 0;

      expect(event.hasTicketsAvailable()).toBe(false);
    });

    it('isApproved should return true only for approved status', () => {
      const event = new Event();
      event.approvalStatus = EventApprovalStatus.APPROVED;

      expect(event.isApproved()).toBe(true);
    });
  });
});
