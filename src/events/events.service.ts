import { Injectable, NotFoundException, ForbiddenException, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType } from '../entities/ticket-type.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { WaitlistService, WaitlistEntryWithPosition } from '../waitlist/waitlist.service';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { NotificationService } from '../notifications/notification.service';
import { getEventEndDateTime } from './utils/event-dates.util';

// Loading the 'organizer.user' relation pulls the full User entity by default, including
// passwordHash and other PII — there's no @Exclude()/serializer scoping it out anywhere in
// this app. Every read path that eager-loads it for event responses must scope the columns
// explicitly, or that hash ends up in a public GET /events response.
const SAFE_ORGANIZER_SELECT = {
  organizer: {
    id: true,
    userId: true,
    companyName: true,
    companyLogoUrl: true,
    verified: true,
    verificationLevel: true,
    user: { id: true, fullName: true },
  },
} as const;

// Same leak, different relation path: Enrollment.user is a plain ManyToOne to the full
// User entity, so listing/searching an event's enrollments must scope it too.
const SAFE_ENROLLMENT_USER_SELECT = {
  user: { id: true, email: true, fullName: true },
} as const;

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
    @InjectRepository(TicketType)
    private readonly ticketTypesRepository: Repository<TicketType>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly waitlistService: WaitlistService,
    private readonly notificationService: NotificationService,
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
    this.assertValidEventDateRange(createEventDto.eventDate, createEventDto.eventEndDate);

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

      const { ticketTypes, ...eventFields } = createEventDto;

      // isPaid is derived from ticket-type prices when tiers are supplied; falls back to the
      // legacy flat price only for callers that haven't migrated to ticketTypes yet.
      const isFree = ticketTypes?.length
        ? ticketTypes.every((t) => !t.price || Number(t.price) === 0)
        : !createEventDto.pricePerTicket || Number(createEventDto.pricePerTicket) === 0;

      // Auto-approval branch: organizers at document_verified level with a clean track
      // record (organizer.autoApproveEvents, set by admin) skip the admin queue even for
      // paid events. The event is still recorded as auto-approved for audit purposes.
      const autoApprovedByOrganizer = !isFree && organizer.autoApproveEvents;
      const isAutoApproved = isFree || autoApprovedByOrganizer;

      const approvalStatus = isAutoApproved ? EventApprovalStatus.APPROVED : EventApprovalStatus.PENDING_APPROVAL;
      const approvalMethod = isFree ? 'auto' : autoApprovedByOrganizer ? 'auto_organizer' : null;
      const approvedAt = isAutoApproved ? new Date() : undefined;

      const event = manager.create(Event, {
        ...eventFields,
        createdByUserId: userId,
        isPaid: !isFree,
        approvalStatus,
        approvalMethod: approvalMethod ?? undefined,
        approvedAt,
        status: EventStatus.UPCOMING,
      });

      const savedEvent = await manager.save(Event, event);

      if (autoApprovedByOrganizer) {
        this.logger.log(
          `Event ${savedEvent.id} auto-approved via organizer ${organizer.id} auto_approve_events flag`,
        );
      }

      if (ticketTypes?.length) {
        const ticketTypeEntities = ticketTypes.map((t) =>
          manager.create(TicketType, {
            eventId: savedEvent.id,
            name: t.name,
            price: t.price,
            currency: t.currency ?? savedEvent.currency,
            quantityTotal: t.quantityTotal,
            salesStartAt: t.salesStartAt ? new Date(t.salesStartAt) : undefined,
            salesEndAt: t.salesEndAt ? new Date(t.salesEndAt) : undefined,
            minPerOrder: t.minPerOrder ?? 1,
            maxPerOrder: t.maxPerOrder,
            isHidden: t.isHidden ?? false,
            accessPassword: t.accessPassword,
          }),
        );
        await manager.save(TicketType, ticketTypeEntities);
      }

      this.logger.log(`Created event: ${savedEvent.title} (id=${savedEvent.id}) by user ${userId}, approvalStatus=${approvalStatus}`);
      return { savedEvent, autoApprovedByOrganizer };
    }).then(async ({ savedEvent, autoApprovedByOrganizer }) => {
      // Audit write happens after commit so a rolled-back transaction never leaves a
      // dangling log entry for an event that doesn't exist.
      if (autoApprovedByOrganizer) {
        await this.auditLogService.log({
          actorId: userId,
          action: 'event.auto_approved',
          targetType: 'event',
          targetId: savedEvent.id,
          metadata: { reason: 'organizer.auto_approve_events', organizerId: savedEvent.organizerId },
        });
      }
      return savedEvent;
    });
  }

  async findAll(page: number = 1, limit: number = 20): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    
    const [events, total] = await this.eventsRepository.findAndCount({
      relations: ['organizer', 'organizer.user', 'category'],
      select: SAFE_ORGANIZER_SELECT,
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
      select: SAFE_ORGANIZER_SELECT,
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
      select: SAFE_ORGANIZER_SELECT,
    });
    if (!event) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }
    return event;
  }

  // Public-facing single-event lookup (the GET /:id route). Non-owners/non-admins may
  // only see approved events — a pending or rejected event's full details (venue,
  // organizer contact info, rejection reason) stay invisible to everyone except the
  // owning organizer or an admin. 404 rather than 403 so existence isn't leaked either.
  // Internal callers that already do their own authorization (update/remove/ticket-type
  // CRUD/etc.) should keep calling findOne() directly — this wrapper is only for that
  // one public route.
  async findOneForViewer(id: string, userId?: string, userRoles: string[] = []): Promise<Event> {
    const event = await this.findOne(id);
    const isOwnerOrAdmin = userId ? await this.isOwnerOrAdmin(event, userId, userRoles) : false;
    if (!isOwnerOrAdmin && !event.isApproved()) {
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

    if (updateEventDto.eventDate !== undefined || updateEventDto.eventEndDate !== undefined) {
      this.assertValidEventDateRange(
        updateEventDto.eventDate ?? event.eventDate,
        updateEventDto.eventEndDate !== undefined ? updateEventDto.eventEndDate : event.eventEndDate,
      );
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
      (updateEventDto as any).approvedAt = null;
      (updateEventDto as any).approvedBy = null;
    }
    if (updateEventDto.pricePerTicket !== undefined) {
      (updateEventDto as any).isPaid = Number(updateEventDto.pricePerTicket) > 0;
    }

    // Snapshot date/time/venue fields before applying the update so a real change can
    // be detected and reported to enrollees below.
    const watchedFields = ['eventDate', 'startTime', 'endTime', 'venueName', 'venueAddress'] as const;
    const before = Object.fromEntries(watchedFields.map((f) => [f, event[f]]));

    Object.assign(event, updateEventDto);
    event.updatedBy = userId;

    const updatedEvent = await this.eventsRepository.save(event);
    this.logger.log(`Updated event: ${updatedEvent.title} (id=${updatedEvent.id})`);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of watchedFields) {
      if (before[field] !== updatedEvent[field]) {
        changes[field] = { from: before[field], to: updatedEvent[field] };
      }
    }
    if (Object.keys(changes).length > 0) {
      await this.notifyActiveEnrollees(updatedEvent.id, changes);
    }

    return updatedEvent;
  }

  // Fires a notification job to every active (pending/confirmed) enrollment when an
  // event's date/time/venue changes.
  private async notifyActiveEnrollees(eventId: string, changes: Record<string, { from: unknown; to: unknown }>): Promise<void> {
    const activeEnrollments = await this.enrollmentRepository.find({
      where: [{ eventId, status: 'confirmed' }, { eventId, status: 'pending' }],
    });
    if (!activeEnrollments.length) return;

    const userIds = [...new Set(activeEnrollments.map((e) => e.userId))];
    await this.notificationService.notifyEventChanged(eventId, userIds, changes);
    this.logger.log(`Notified ${userIds.length} enrollee(s) of changes to event ${eventId}: ${Object.keys(changes).join(', ')}`);
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

    // An event with unresolved bookings can't just vanish — that either strands a
    // paying participant with no recourse or lets an organizer dodge a refund. Same
    // "resolve buyer commitments first" rule as the ticket-type edit-lock below.
    const activeEnrollments = await this.enrollmentRepository.count({
      where: [
        { eventId: id, status: 'confirmed' },
        { eventId: id, status: 'pending' },
      ],
    });
    if (activeEnrollments > 0) {
      throw new ConflictException(
        `Cannot delete this event: ${activeEnrollments} active booking(s) still exist. Cancel or refund them first.`,
      );
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
      select: SAFE_ORGANIZER_SELECT,
    });
  }

  async findMyWaitlistEntries(userId: string): Promise<WaitlistEntryWithPosition[]> {
    return this.waitlistService.findMyEntries(userId);
  }

  // Participant's own booking history (BookingsScreen) — most recent first.
  async findMyEnrollments(userId: string): Promise<Enrollment[]> {
    return this.enrollmentRepository.find({
      where: { userId },
      relations: ['event', 'ticketType'],
      order: { createdAt: 'DESC' },
    });
  }

  async findByOrganizerId(organizerId: string): Promise<Event[]> {
    return await this.eventsRepository.find({
      where: { organizerId, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
      select: SAFE_ORGANIZER_SELECT,
    });
  }

  // Ticket-type nested CRUD (organizer-only, own event; admins may act on any event).
  // New tiers may be added at any time. Editing/removing a tier is blocked once it has
  // sales (quantitySold > 0) — that's the "lock" referenced in the phase-1 spec; it
  // protects buyers, not the organizer's pre-approval workflow.
  async createTicketType(
    eventId: string,
    dto: CreateTicketTypeDto,
    userId: string,
    userRoles: string[],
  ): Promise<TicketType> {
    const event = await this.findOne(eventId);
    await this.assertOwnsEvent(event, userId, userRoles);
    this.assertNotRejected(event);
    this.assertSalesEndWithinEvent(event, dto.salesEndAt);

    const ticketType = this.ticketTypesRepository.create({
      eventId,
      name: dto.name,
      price: dto.price,
      currency: dto.currency ?? event.currency,
      quantityTotal: dto.quantityTotal,
      salesStartAt: dto.salesStartAt ? new Date(dto.salesStartAt) : undefined,
      salesEndAt: dto.salesEndAt ? new Date(dto.salesEndAt) : undefined,
      minPerOrder: dto.minPerOrder ?? 1,
      maxPerOrder: dto.maxPerOrder,
      isHidden: dto.isHidden ?? false,
      accessPassword: dto.accessPassword,
    });

    const saved = await this.ticketTypesRepository.save(ticketType);
    this.logger.log(`Created ticket type ${saved.id} (${saved.name}) on event ${eventId}`);
    return saved;
  }

  async findTicketTypes(eventId: string, userId?: string, userRoles: string[] = []): Promise<TicketType[]> {
    const event = await this.findOne(eventId);
    const isOwnerOrAdmin = userId ? await this.isOwnerOrAdmin(event, userId, userRoles) : false;

    // Pricing/inventory for a not-yet-approved (or rejected) event is only the
    // organizer's/admin's business until it's actually approved for sale.
    if (!isOwnerOrAdmin && !event.isApproved()) {
      return [];
    }

    const ticketTypes = await this.ticketTypesRepository.find({
      where: { eventId },
      order: { createdAt: 'ASC' },
    });

    return isOwnerOrAdmin ? ticketTypes : ticketTypes.filter((t) => !t.isHidden);
  }

  async updateTicketType(
    eventId: string,
    ticketTypeId: string,
    dto: UpdateTicketTypeDto,
    userId: string,
    userRoles: string[],
  ): Promise<TicketType> {
    const event = await this.findOne(eventId);
    await this.assertOwnsEvent(event, userId, userRoles);
    this.assertNotRejected(event);

    const ticketType = await this.findTicketTypeOrFail(eventId, ticketTypeId);
    if (ticketType.quantitySold > 0) {
      throw new ForbiddenException('Cannot edit a ticket tier that already has sales');
    }
    if (dto.salesEndAt !== undefined) this.assertSalesEndWithinEvent(event, dto.salesEndAt);

    if (dto.salesStartAt !== undefined) ticketType.salesStartAt = dto.salesStartAt ? new Date(dto.salesStartAt) : undefined;
    if (dto.salesEndAt !== undefined) ticketType.salesEndAt = dto.salesEndAt ? new Date(dto.salesEndAt) : undefined;
    const { salesStartAt, salesEndAt, ...rest } = dto;
    Object.assign(ticketType, rest);

    const saved = await this.ticketTypesRepository.save(ticketType);
    this.logger.log(`Updated ticket type ${saved.id} on event ${eventId}`);
    return saved;
  }

  async removeTicketType(
    eventId: string,
    ticketTypeId: string,
    userId: string,
    userRoles: string[],
  ): Promise<void> {
    const event = await this.findOne(eventId);
    await this.assertOwnsEvent(event, userId, userRoles);

    const ticketType = await this.findTicketTypeOrFail(eventId, ticketTypeId);
    if (ticketType.quantitySold > 0) {
      throw new ForbiddenException('Cannot remove a ticket tier that already has sales');
    }

    await this.ticketTypesRepository.remove(ticketType);
    this.logger.log(`Removed ticket type ${ticketTypeId} on event ${eventId}`);
  }

  private async findTicketTypeOrFail(eventId: string, ticketTypeId: string): Promise<TicketType> {
    const ticketType = await this.ticketTypesRepository.findOne({ where: { id: ticketTypeId, eventId } });
    if (!ticketType) {
      throw new NotFoundException(`Ticket type ${ticketTypeId} not found on event ${eventId}`);
    }
    return ticketType;
  }

  private async isOwnerOrAdmin(event: Event, userId: string, userRoles: string[]): Promise<boolean> {
    if (userRoles.includes('admin')) return true;
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    return !!organizer && organizer.id === event.organizerId;
  }

  private async assertOwnsEvent(event: Event, userId: string, userRoles: string[]): Promise<void> {
    if (!(await this.isOwnerOrAdmin(event, userId, userRoles))) {
      throw new ForbiddenException('You can only manage ticket types for your own events');
    }
  }

  // A rejected event is a dead end — it can't grow new sellable tiers or have existing
  // ones repriced. Pending-approval events are exempt on purpose: organizers build out
  // tiers while waiting on admin review, per the original ticket-type CRUD design.
  private assertNotRejected(event: Event): void {
    if (event.approvalStatus === EventApprovalStatus.REJECTED) {
      throw new BadRequestException('Cannot modify ticket types on a rejected event');
    }
  }

  // Participant enrollment with atomic, race-safe ticket-type decrement. When the tier
  // is sold out, the request creates a WaitlistEntry instead of failing outright.
  async enroll(eventId: string, userId: string, ticketTypeId?: string, quantity = 1): Promise<Enrollment | WaitlistEntryWithPosition> {
    const result = await this.dataSource.transaction(async (manager) => {
      let event = await manager.findOne(Event, {
        where: { id: eventId, deletedAt: null as any },
        relations: ['ticketTypes'],
      });

      if (!event) {
        throw new NotFoundException(`Event with id ${eventId} not found`);
      }

      if (!event.canEnroll()) {
        throw new BadRequestException('Event is not accepting enrollments');
      }

      if (event.capacity != null) {
        // Re-fetch with a row lock so the aggregate capacity check below is consistent
        // for the duration of this transaction.
        event = await manager.findOne(Event, {
          where: { id: eventId },
          lock: { mode: 'pessimistic_write' },
          relations: ['ticketTypes'],
        }) as Event;
      }

      let resolvedTicketTypeId = ticketTypeId;
      if (!resolvedTicketTypeId) {
        if (event.ticketTypes?.length === 1) {
          resolvedTicketTypeId = event.ticketTypes[0].id;
        } else {
          throw new BadRequestException('ticketTypeId is required for this event');
        }
      }

      const resolvedTicketType = event.ticketTypes?.find((t) => t.id === resolvedTicketTypeId);
      if (!resolvedTicketType) {
        throw new NotFoundException(`Ticket type ${resolvedTicketTypeId} not found on this event`);
      }

      const now = new Date();
      if (resolvedTicketType.salesStartAt && now < resolvedTicketType.salesStartAt) {
        throw new BadRequestException('Ticket sales have not started yet for this ticket type');
      }
      if (resolvedTicketType.salesEndAt && now > resolvedTicketType.salesEndAt) {
        throw new BadRequestException('Ticket sales have ended for this ticket type');
      }

      const existing = await manager.findOne(Enrollment, {
        where: { eventId, userId },
      });
      if (existing) {
        throw new ConflictException('User already enrolled in this event');
      }

      if (event.capacity != null) {
        const currentSold = event.ticketTypes.reduce((sum, t) => sum + t.quantitySold, 0);
        if (currentSold + quantity > event.capacity) {
          return { soldOut: true as const, ticketTypeId: resolvedTicketTypeId! };
        }
      }

      // Single atomic statement — no app-level check-then-write. Zero rows returned
      // means the tier is sold out (or oversold by a concurrent request that won the race).
      const updateResult = await manager.query(
        `UPDATE ticket_types
         SET quantity_sold = quantity_sold + $1, updated_at = now()
         WHERE id = $2 AND event_id = $3
           AND (quantity_total IS NULL OR quantity_sold + $1 <= quantity_total)
         RETURNING *`,
        [quantity, resolvedTicketTypeId, eventId],
      );

      if (!updateResult?.[0]?.length) {
        return { soldOut: true as const, ticketTypeId: resolvedTicketTypeId! };
      }

      const ticketType = updateResult[0][0] as { price: string };

      const bookingReference = `BK-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const totalAmount = Number(ticketType.price) * quantity;

      const enrollment = manager.create(Enrollment, {
        userId,
        eventId,
        ticketTypeId: resolvedTicketTypeId,
        quantity,
        totalAmount,
        status: 'confirmed',
        // Free tickets have no gateway/webhook to confirm payment later, so they must be
        // marked settled here. Paid tickets stay 'pending' until handleWebhook() confirms.
        paymentStatus: totalAmount === 0 ? 'paid' : 'pending',
        bookingDate: new Date(),
        bookingReference,
      });

      // The `existing` check above is an app-level guard, not a lock — two concurrent
      // enroll() calls for the same user+event can both pass it before either commits.
      // The Enrollment table's @Unique(['userId','eventId']) constraint is the real
      // backstop; translate its violation into the same clean 409 the app-level check
      // gives, instead of letting a raw Postgres error surface as a 500.
      let saved: Enrollment;
      try {
        saved = await manager.save(Enrollment, enrollment);
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw new ConflictException('User already enrolled in this event');
        }
        throw err;
      }

      // Section 5b: generate signed ticket_code for confirmed events (enclosing enrollmentId and eventId)
      if (saved.status === 'confirmed') {
        const ticketCode = this.jwtService.sign(
          { enrollmentId: saved.id, eventId: saved.eventId },
          { expiresIn: '365d' },
        );
        saved.ticketCode = ticketCode;
        saved = await manager.save(Enrollment, saved);
      }

      this.logger.log(`User ${userId} enrolled in event ${eventId}`);
      return { soldOut: false as const, enrollment: saved };
    });

    if (result.soldOut) {
      this.logger.log(`Ticket type ${result.ticketTypeId} sold out for event ${eventId}; user ${userId} joining waitlist`);
      return this.waitlistService.join(eventId, result.ticketTypeId, userId, quantity);
    }
    return result.enrollment;
  }

  // Participant-facing cancellation. Frees the tier's capacity and immediately attempts
  // to promote the next FIFO waitlist entry for it.
  async cancelEnrollment(enrollmentId: string, userId: string, userRoles: string[]): Promise<Enrollment> {
    const enrollment = await this.enrollmentRepository.findOne({ where: { id: enrollmentId } });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (!userRoles.includes('admin') && enrollment.userId !== userId) {
      throw new ForbiddenException('You can only cancel your own booking');
    }
    if (enrollment.status === 'cancelled' || enrollment.status === 'refunded') {
      throw new BadRequestException('This booking is already cancelled');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      enrollment.status = 'cancelled';
      enrollment.cancelledDate = new Date();
      const savedEnrollment = await manager.save(Enrollment, enrollment);

      if (enrollment.ticketTypeId) {
        await manager.query(
          `UPDATE ticket_types SET quantity_sold = GREATEST(quantity_sold - $1, 0), updated_at = now() WHERE id = $2`,
          [enrollment.quantity, enrollment.ticketTypeId],
        );
      }

      return savedEnrollment;
    });

    if (enrollment.ticketTypeId) {
      await this.waitlistService.promoteNext(enrollment.ticketTypeId);
    }

    this.logger.log(`Enrollment ${enrollmentId} cancelled by user ${userId}`);
    return saved;
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
      select: SAFE_ORGANIZER_SELECT,
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
      select: SAFE_ENROLLMENT_USER_SELECT,
    });
  }

  // Section 5c: check-in endpoint — ownership-based, signed token verification
  async checkIn(ticketCode: string, userId: string, userRoles: string[]): Promise<Enrollment> {
    let payload: { sub?: string; eventId: string; enrollmentId?: string };
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

    if (payload.enrollmentId !== enrollment.id || payload.eventId !== enrollment.eventId) {
      throw new BadRequestException('Ticket payload verification failed');
    }

    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({ where: { userId } });
      if (!organizer || organizer.id !== enrollment.event.organizerId) {
        throw new ForbiddenException('You can only check in tickets for your own events');
      }
    }

    if (enrollment.paymentStatus !== 'paid') {
      throw new BadRequestException('Cannot check in: payment for this booking is not confirmed');
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

  // Section 5d: Search confirmed enrollments by participant name
  async searchEnrollments(
    eventId: string,
    name: string,
    userId: string,
    userRoles: string[],
  ): Promise<Enrollment[]> {
    const event = await this.findOne(eventId);

    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({ where: { userId } });
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only search enrollments for your own events');
      }
    }

    return await this.enrollmentRepository.find({
      where: {
        eventId,
        status: 'confirmed',
        user: name ? { fullName: ILike(`%${name}%`) } : undefined,
      },
      relations: ['user'],
      select: SAFE_ENROLLMENT_USER_SELECT,
    });
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

  // See loophole.md: eventEndDate is nullable/optional (single-day event), but if
  // supplied it must not be before the start date.
  private assertValidEventDateRange(eventDate: string, eventEndDate?: string | null): void {
    if (!eventEndDate) return;
    if (eventEndDate < eventDate) {
      throw new BadRequestException('eventEndDate cannot be before eventDate');
    }
  }

  // See loophole.md §3.4: a ticket tier's sales window must not extend past when the
  // event actually ends (eventEndDate, not the single-day eventDate assumption).
  private assertSalesEndWithinEvent(event: Event, salesEndAt?: string): void {
    if (!salesEndAt) return;
    if (new Date(salesEndAt).getTime() > getEventEndDateTime(event).getTime()) {
      throw new BadRequestException('salesEndAt cannot be after the event ends');
    }
  }
}
