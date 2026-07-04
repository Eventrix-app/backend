import { Injectable, NotFoundException, ForbiddenException, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoriesRepository: Repository<EventCategory>,
    private readonly dataSource: DataSource,
  ) {}

  async create(createEventDto: CreateEventDto): Promise<Event> {
    // Validate category exists
    await this.validateCategory(createEventDto.categoryId);
    
    // Validate organizer exists if specified
    if (createEventDto.organizerId) {
      await this.validateOrganizer(createEventDto.organizerId);
    }

    const event = this.eventsRepository.create(createEventDto);
    event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
    event.status = EventStatus.UPCOMING;
    
    const savedEvent = await this.eventsRepository.save(event);
    this.logger.log(`Created event: ${savedEvent.title} (id=${savedEvent.id})`);
    return savedEvent;
  }

  async createForUser(createEventDto: CreateEventDto, userId: string, userRole: string): Promise<Event> {
    // Validate category exists
    await this.validateCategory(createEventDto.categoryId);

    // If user is an organizer, they can only create events for themselves
    if (userRole === 'organizer') {
      const organizer = await this.organizersRepository.findOne({
        where: { userId },
      });
      if (!organizer) {
        throw new NotFoundException('Organizer profile not found for this user');
      }
      createEventDto.organizerId = organizer.id;
    } else if (userRole === 'admin' && createEventDto.organizerId) {
      // Admin can specify organizerId, validate it exists
      await this.validateOrganizer(createEventDto.organizerId);
    }

    const event = this.eventsRepository.create(createEventDto);
    event.createdByUserId = userId;
    event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
    event.status = EventStatus.UPCOMING;
    
    const savedEvent = await this.eventsRepository.save(event);
    this.logger.log(`Created event: ${savedEvent.title} (id=${savedEvent.id}) by user ${userId} (${userRole})`);
    return savedEvent;
  }

  async findAll(page: number = 1, limit: number = 20): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    
    const [events, total] = await this.eventsRepository.findAndCount({
      relations: ['organizer', 'organizer.user', 'category'],
      where: { deletedAt: null as any },
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });

    return {
      events,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Filtered list for public endpoint with pagination
  async findAllFiltered(
    categoryId?: string,
    isOnline?: boolean,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const where: any = { 
      deletedAt: null as any,
      approvalStatus: EventApprovalStatus.APPROVED,
    };
    
    if (categoryId) where.categoryId = categoryId;
    if (isOnline !== undefined) where.isOnline = isOnline;
    
    const [events, total] = await this.eventsRepository.findAndCount({
      where,
      relations: ['organizer', 'organizer.user', 'category'],
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });

    return {
      events,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<Event> {
    const event = await this.eventsRepository.findOne({
      where: { id, deletedAt: null as any },
      relations: ['organizer', 'organizer.user', 'category'],
    });
    if (!event) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }
    return event;
  }

  async update(id: string, updateEventDto: UpdateEventDto, userId: string, userRole: string): Promise<Event> {
    const event = await this.findOne(id);
    
    // Validate category if being updated
    if (updateEventDto.categoryId) {
      await this.validateCategory(updateEventDto.categoryId);
    }

    // Validate organizer if being updated
    if (updateEventDto.organizerId) {
      await this.validateOrganizer(updateEventDto.organizerId);
    }
    
    // Check ownership
    if (userRole !== 'admin') {
      const organizer = await this.organizersRepository.findOne({
        where: { userId },
      });
      
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only update your own events');
      }
    }

    Object.assign(event, updateEventDto);
    event.updatedBy = userId;
    
    const updatedEvent = await this.eventsRepository.save(event);
    this.logger.log(`Updated event: ${updatedEvent.title} (id=${updatedEvent.id})`);
    return updatedEvent;
  }

  async remove(id: string, userId: string, userRole: string): Promise<void> {
    const event = await this.findOne(id);
    
    // Check ownership - only organizers can delete their own events, admins can delete any
    if (userRole !== 'admin') {
      const organizer = await this.organizersRepository.findOne({
        where: { userId },
      });
      
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only delete your own events');
      }
    }

    await this.eventsRepository.softRemove(event);
    this.logger.log(`Soft-deleted event: ${event.title} (id=${event.id})`);
  }

  async findByOrganizerId(organizerId: string): Promise<Event[]> {
    return await this.eventsRepository.find({
      where: { organizerId, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
    });
  }

  // Participant enrollment with atomic ticket decrement
  async enroll(eventId: string, userId: string): Promise<Event> {
    return await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { id: eventId, deletedAt: null as any },
        relations: ['participants'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!event) {
        throw new NotFoundException(`Event with id ${eventId} not found`);
      }

      // Validate event can accept enrollments
      if (!event.canEnroll()) {
        throw new BadRequestException('Event is not accepting enrollments');
      }

      if (!event.hasTicketsAvailable()) {
        throw new ConflictException('No tickets available for this event');
      }

      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) {
        throw new NotFoundException(`User with id ${userId} not found`);
      }

      // Check if already enrolled
      if (event.participants?.some((p) => p.id === user.id)) {
        throw new ConflictException('User already enrolled in this event');
      }

      // Atomically decrement available tickets
      if (event.availableTickets) {
        event.availableTickets -= 1;
      }

      if (!event.participants) event.participants = [];
      event.participants.push(user);

      const saved = await manager.save(Event, event);
      this.logger.log(`User ${user.id} enrolled in event ${event.id}. Remaining tickets: ${saved.availableTickets}`);
      return saved;
    });
  }

  // Admin approval workflow with audit trail
  async approve(id: string, adminUserId: string): Promise<Event> {
    const event = await this.findOne(id);
    
    if (event.approvalStatus === EventApprovalStatus.APPROVED) {
      throw new BadRequestException('Event is already approved');
    }

    event.approvalStatus = EventApprovalStatus.APPROVED;
    event.rejectionReason = null as any;
    event.approvedBy = adminUserId;
    event.approvedAt = new Date();
    event.rejectedBy = undefined;
    event.rejectedAt = undefined;
    
    const saved = await this.eventsRepository.save(event);
    this.logger.log(`Event ${event.id} approved by admin ${adminUserId}`);
    
    // TODO: Send notification to organizer
    // await this.notificationService.notifyEventApproved(event);
    
    return saved;
  }

  async reject(id: string, rejectionReason: string, adminUserId: string): Promise<Event> {
    const event = await this.findOne(id);
    
    if (!rejectionReason || rejectionReason.trim().length === 0) {
      throw new BadRequestException('Rejection reason is required');
    }

    if (event.approvalStatus === EventApprovalStatus.REJECTED) {
      throw new BadRequestException('Event is already rejected');
    }

    event.approvalStatus = EventApprovalStatus.REJECTED;
    event.rejectionReason = rejectionReason;
    event.rejectedBy = adminUserId;
    event.rejectedAt = new Date();
    event.approvedBy = undefined;
    event.approvedAt = undefined;
    
    const saved = await this.eventsRepository.save(event);
    this.logger.log(`Event ${event.id} rejected by admin ${adminUserId}`);
    
    // TODO: Send notification to organizer
    // await this.notificationService.notifyEventRejected(event, rejectionReason);
    
    return saved;
  }

  async findPending(page: number = 1, limit: number = 20): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    
    const [events, total] = await this.eventsRepository.findAndCount({
      where: { 
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
        deletedAt: null as any,
      },
      relations: ['organizer', 'organizer.user', 'category'],
      order: { createdAt: 'ASC' },
      skip,
      take: limit,
    });

    return {
      events,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Helper validation methods
  private async validateCategory(categoryId: string): Promise<void> {
    const category = await this.categoriesRepository.findOne({ where: { id: categoryId } });
    if (!category) {
      throw new NotFoundException(`Category with id ${categoryId} not found`);
    }
  }

  private async validateOrganizer(organizerId: string): Promise<void> {
    const organizer = await this.organizersRepository.findOne({ where: { id: organizerId } });
    if (!organizer) {
      throw new NotFoundException(`Organizer with id ${organizerId} not found`);
    }
  }
}
