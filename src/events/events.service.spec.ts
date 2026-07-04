import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('EventsService - Fixed Issues', () => {
  let service: EventsService;
  let mockEventRepo: any;
  let mockOrganizerRepo: any;
  let mockUserRepo: any;
  let mockCategoryRepo: any;
  let mockDataSource: any;

  beforeEach(async () => {
    mockEventRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      softRemove: jest.fn(),
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

    mockDataSource = {
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: mockEventRepo },
        { provide: getRepositoryToken(Organizer), useValue: mockOrganizerRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(EventCategory), useValue: mockCategoryRepo },
        { provide: DataSource, useValue: mockDataSource },
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
    it('should prevent enrollment when no tickets available', async () => {
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        availableTickets: 0,
        canEnroll: () => false,
        hasTicketsAvailable: () => false,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn().mockResolvedValue(mockEvent),
        };
        return callback(mockManager);
      });

      await expect(service.enroll('event-1', 'user-1')).rejects.toThrow(ConflictException);
    });

    it('should atomically decrement tickets on successful enrollment', async () => {
      const mockUser = { id: 'user-1', email: 'test@test.com' };
      const mockEvent = {
        id: 'event-1',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        availableTickets: 10,
        participants: [],
        canEnroll: () => true,
        hasTicketsAvailable: () => true,
      };

      mockDataSource.transaction.mockImplementation(async (callback) => {
        const mockManager = {
          findOne: jest.fn()
            .mockResolvedValueOnce(mockEvent)
            .mockResolvedValueOnce(mockUser),
          save: jest.fn().mockImplementation((entity, data) => {
            expect(data.availableTickets).toBe(9);
            return Promise.resolve(data);
          }),
        };
        return callback(mockManager);
      });

      await service.enroll('event-1', 'user-1');
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
