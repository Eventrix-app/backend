import { Injectable, NotFoundException, ForbiddenException, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
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
    @InjectRepository(Enrollment)
    private readonly enrollmentRepository: Repository<Enrollment>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoriesRepository: Repository<EventCategory>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
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

  async createForUser(createEventDto: CreateEventDto, userId: string, userRoles: string[]): Promise<Event> {
    await this.validateCategory(createEventDto.categoryId);

    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      let organizer = await manager.findOne(Organizer, { where: { userId } });

      if (!organizer) {
        organizer = manager.create(Organizer, {
          userId,
          companyName: user.fullName || user.email,
        });
        organizer = await manager.save(Organizer, organizer);
        this.logger.log(`Auto-created organizer profile for user ${userId}`);
      }

      if (!user.roles.includes('organizer')) {
        user.roles = [...user.roles, 'organizer'];
        await manager.save(User, user);
        this.logger.log(`Added 'organizer' role to user ${userId}`);
      }

      if (userRoles.includes('admin') && createEventDto.organizerId) {
        await this.validateOrganizer(createEventDto.organizerId);
      } else {
        createEventDto.organizerId = organizer.id;
      }

      const isFree = !createEventDto.pricePerTicket || Number(createEventDto.pricePerTicket) === 0;
      const approvalStatus = isFree ? EventApprovalStatus.APPROVED : EventApprovalStatus.PENDING_APPROVAL;
      const approvalMethod = isFree ? 'auto' : null;
      const approvedAt = isFree ? new Date() : undefined;

      const event = manager.create(Event, {
        ...createEventDto,
        createdByUserId: userId,
        isPaid: !isFree,
        approvalStatus,
        approvalMethod: approvalMethod ?? undefined,
        approvedAt,
        status: EventStatus.UPCOMING,
      });

      const savedEvent = await manager.save(Event, event);
      this.logger.log(`Created event: ${savedEvent.title} (id=${savedEvent.id}) by user ${userId}, approvalStatus=${approvalStatus}`);
      return savedEvent;
    });
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

  async update(id: string, updateEventDto: UpdateEventDto, userId: string, userRoles: string[]): Promise<Event> {
    const event = await this.findOne(id);
    
    // Validate category if being updated
    if (updateEventDto.categoryId) {
      await this.validateCategory(updateEventDto.categoryId);
    }

    // Validate organizer if being updated
    if (updateEventDto.organizerId) {
      await this.validateOrganizer(updateEventDto.organizerId);
    }
    
    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({
        where: { userId },
      });
      
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only update your own events');
      }
    }

    // Section 4c: close free-to-paid loophole
    const wasApproved = event.approvalStatus === EventApprovalStatus.APPROVED;
    const switchingToPaid =
      updateEventDto.pricePerTicket !== undefined &&
      Number(updateEventDto.pricePerTicket) > 0 &&
      !event.isPaid;
    if (wasApproved && switchingToPaid) {
      updateEventDto.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
      (updateEventDto as any).approvalMethod = null;
    }
    if (updateEventDto.pricePerTicket !== undefined) {
      (updateEventDto as any).isPaid = Number(updateEventDto.pricePerTicket) > 0;
    }

    Object.assign(event, updateEventDto);
    event.updatedBy = userId;
    
    const updatedEvent = await this.eventsRepository.save(event);
    this.logger.log(`Updated event: ${updatedEvent.title} (id=${updatedEvent.id})`);
    return updatedEvent;
  }

  async remove(id: string, userId: string, userRoles: string[]): Promise<void> {
    const event = await this.findOne(id);
    
    if (!userRoles.includes('admin')) {
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

  async findMyEvents(userId: string): Promise<Event[]> {
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) return [];
    return await this.eventsRepository.find({
      where: { organizerId: organizer.id, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
    });
  }

  async findByOrganizerId(organizerId: string): Promise<Event[]> {
    return await this.eventsRepository.find({
      where: { organizerId, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
    });
  }

  // Participant enrollment with atomic ticket decrement
  async enroll(eventId: string, userId: string): Promise<Enrollment> {
    return await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { id: eventId, deletedAt: null as any },
        lock: { mode: 'pessimistic_write' },
      });

      if (!event) {
        throw new NotFoundException(`Event with id ${eventId} not found`);
      }

      if (!event.canEnroll()) {
        throw new BadRequestException('Event is not accepting enrollments');
      }

      if (!event.hasTicketsAvailable()) {
        throw new ConflictException('No tickets available for this event');
      }

      const existing = await manager.findOne(Enrollment, {
        where: { eventId, userId },
      });
      if (existing) {
        throw new ConflictException('User already enrolled in this event');
      }

      if (event.availableTickets) {
        event.availableTickets -= 1;
        await manager.save(Event, event);
      }

      const bookingReference = `BK-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

      // Section 5b: generate signed ticket_code for free (immediately confirmed) events
      let ticketCode: string | undefined;
      if (!event.isPaid) {
        ticketCode = this.jwtService.sign(
          { sub: 'ticket', eventId },
          { expiresIn: '365d' },
        );
      }

      const enrollment = manager.create(Enrollment, {
        userId,
        eventId,
        quantity: 1,
        totalAmount: event.pricePerTicket ?? 0,
        status: 'confirmed',
        bookingDate: new Date(),
        bookingReference,
        ticketCode,
      });

      const saved = await manager.save(Enrollment, enrollment);
      this.logger.log(`User ${userId} enrolled in event ${eventId}`);
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
        isPaid: true,
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

  // Section 3e: enrollment visibility — ownership-based
  async findEnrollments(eventId: string, userId: string, userRoles: string[]): Promise<Enrollment[]> {
    const event = await this.findOne(eventId);
    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({ where: { userId } });
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only view enrollments for your own events');
      }
    }
    return this.enrollmentRepository.find({
      where: { eventId },
      relations: ['user'],
    });
  }

  // Section 5c: check-in endpoint — ownership-based, signed token verification
  async checkIn(ticketCode: string, userId: string, userRoles: string[]): Promise<Enrollment> {
    let payload: { sub: string; eventId: string; enrollmentId?: string };
    try {
      payload = this.jwtService.verify(ticketCode);
    } catch {
      throw new BadRequestException('Invalid or expired ticket code');
    }

    const enrollment = await this.enrollmentRepository.findOne({
      where: { ticketCode },
      relations: ['event'],
    });
    if (!enrollment) {
      throw new NotFoundException('Ticket not found');
    }

    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({ where: { userId } });
      if (!organizer || organizer.id !== enrollment.event.organizerId) {
        throw new ForbiddenException('You can only check in tickets for your own events');
      }
    }

    if (enrollment.checkedInAt) {
      throw new ConflictException('Ticket already checked in');
    }

    enrollment.checkedInAt = new Date();
    return this.enrollmentRepository.save(enrollment);
  }

  // Section 4e: fetch a single enrollment — only the owning user or admin may access
  async findEnrollmentById(enrollmentId: string, userId: string, userRoles: string[]): Promise<Enrollment> {
    const enrollment = await this.enrollmentRepository.findOne({
      where: { id: enrollmentId },
      relations: ['event'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (!userRoles.includes('admin') && enrollment.userId !== userId) {
      throw new ForbiddenException('You can only view your own tickets');
    }
    return enrollment;
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
