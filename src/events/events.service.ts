import { Injectable, NotFoundException, ForbiddenException, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, ILike, In, IsNull, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Event, EventApprovalStatus, EventStatus, FeePayer } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer, VerificationLevel } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType, TicketCategory, TICKET_CATEGORY_LABELS } from '../entities/ticket-type.entity';
import { Favorite } from '../entities/favorite.entity';
import { Follow } from '../entities/follow.entity';
import { EventMedia } from '../entities/event-media.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { CreateEventMediaDto } from './dto/create-event-media.dto';
import { AuditLogService } from '../common/audit-log/audit-log.service';
import { WaitlistService, WaitlistEntryWithPosition } from '../waitlist/waitlist.service';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { NotificationService } from '../notifications/notification.service';
import { getEventEndDateTime, isEventOver, todayIstDateKey } from './utils/event-dates.util';
import { EVENTS_LIST_VERSION_KEY, eventDetailCacheKey, invalidateEventCaches } from './utils/event-cache.util';
import { CacheService } from '../common/cache/cache.service';
import { FeeCalculationService, toCommissionConfig } from '../payments/fee-calculation.service';
import { LedgerService } from '../payments/ledger.service';

// 'organizer.user' pulls the full User entity including passwordHash, and nothing scopes it
// out — every read path that eager-loads it must select columns explicitly.
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
    @InjectRepository(Favorite)
    private readonly favoritesRepository: Repository<Favorite>,
    @InjectRepository(Follow)
    private readonly followsRepository: Repository<Follow>,
    @InjectRepository(EventMedia)
    private readonly eventMediaRepository: Repository<EventMedia>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly waitlistService: WaitlistService,
    private readonly notificationService: NotificationService,
    private readonly cache: CacheService,
    private readonly feeCalculationService: FeeCalculationService,
    private readonly ledgerService: LedgerService,
  ) {}

  // Listings are read far more than written, so they're cached. A version number folded into
  // the key invalidates every parameterised entry at once instead of enumerating them.
  private static readonly EVENTS_LIST_TTL_SECONDS = 45;
  private static readonly EVENT_DETAIL_TTL_SECONDS = 60;
  // Home screen's featured carousel is a small curated rail, not a paginated list — capped
  // server-side so no client has to defensively truncate an unbounded response.
  private static readonly MAX_FEATURED_EVENTS = 5;

  private async eventsListCacheKey(
    categoryId: string | undefined,
    isOnline: boolean | undefined,
    page: number,
    limit: number,
    priceMin: number | undefined,
    priceMax: number | undefined,
    dateFrom: string | undefined,
    dateTo: string | undefined,
    sortBy: string,
  ): Promise<string> {
    const version = await this.cache.getVersion(EVENTS_LIST_VERSION_KEY);
    return `events:list:${version}:${categoryId ?? 'all'}:${isOnline ?? 'all'}:${page}:${limit}:${priceMin ?? '-'}:${priceMax ?? '-'}:${dateFrom ?? '-'}:${dateTo ?? '-'}:${sortBy}`;
  }

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
    if (createEventDto.featured) {
      await this.assertFeaturedCapAvailable();
    }

    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      if (!user.isEmailVerified) {
        throw new ForbiddenException('Please verify your email before creating events');
      }

      const organizer = await manager.findOne(Organizer, { where: { userId } });
      const isAdmin = userRoles.includes('admin');

      // Creating an event used to silently grant the organizer role with no KYC. Organizers
      // must now pass admin-reviewed verification; admins acting for one are exempt.
      if (!isAdmin && organizer?.verificationLevel !== VerificationLevel.DOCUMENT_VERIFIED) {
        throw new ForbiddenException(
          'You must complete organizer verification before you can create events. Submit your details for review from your profile.',
        );
      }

      if (isAdmin && createEventDto.organizerId) {
        await this.validateOrganizer(createEventDto.organizerId);
      } else if (organizer) {
        createEventDto.organizerId = organizer.id;
      } else {
        // Only reachable for an admin with no organizer profile and no organizerId — the
        // non-admin path above already guarantees a verified organizer.
        throw new BadRequestException('organizerId is required to create an event as an admin.');
      }

      const { ticketTypes, ...eventFields } = createEventDto;

      // isPaid is derived from ticket-type prices when tiers are supplied; falls back to the
      // legacy flat price only for callers that haven't migrated to ticketTypes yet.
      const isFree = ticketTypes?.length
        ? ticketTypes.every((t) => !t.price || Number(t.price) === 0)
        : !createEventDto.pricePerTicket || Number(createEventDto.pricePerTicket) === 0;

      // Organizers with autoApproveEvents (admin-set, document_verified) skip the queue even
      // for paid events. Still recorded as auto-approved for audit.
      const autoApprovedByOrganizer = !isFree && !!organizer?.autoApproveEvents;
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
            category: t.category,
            // Derived, not taken from the client — see CreateTicketTypeDto's comment on why
            // there is no `name` field to trust in the first place.
            name: TICKET_CATEGORY_LABELS[t.category],
            benefits: t.benefits,
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
      return { savedEvent, autoApprovedByOrganizer, organizerName: organizer?.companyName ?? user.fullName };
    }).then(async ({ savedEvent, autoApprovedByOrganizer, organizerName }) => {
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
      // Only events that actually landed in the queue — an auto-approved one has nothing
      // for an admin to do. Fire-and-forget after commit, like the audit write above.
      if (savedEvent.approvalStatus === EventApprovalStatus.PENDING_APPROVAL) {
        void this.notificationService.notifyAdminsEventPendingApproval(
          savedEvent.id,
          savedEvent.title,
          organizerName,
        );
      }

      // Creation was the one mutating path that never invalidated the list cache — update,
      // cancel, delete, approve, reject and enrol all did. A free event auto-approves and is
      // public the instant it commits, so without this it stayed missing from the feed for
      // the cache's full TTL and read as "my event wasn't created".
      if (savedEvent.approvalStatus === EventApprovalStatus.APPROVED) {
        await invalidateEventCaches(this.cache, savedEvent.id);
      }
      return savedEvent;
    });
  }

  // Testing-only: create N events in one shot, all sharing the same cover image.
  // Events are free → auto-approved so they show up immediately in the app.
  async bulkSeed(
    userId: string,
    userRoles: string[],
    count: number,
    coverImageUrl: string,
    categoryId: string,
  ): Promise<Event[]> {
    await this.validateCategory(categoryId);

    const venues = [
      { name: 'The Grand Arena', address: 'MG Road, Bangalore' },
      { name: 'City Convention Centre', address: 'Connaught Place, New Delhi' },
      { name: 'Skyline Rooftop', address: 'Bandra West, Mumbai' },
      { name: 'Riverside Pavilion', address: 'Anna Salai, Chennai' },
      { name: 'Tech Park Auditorium', address: 'Hitech City, Hyderabad' },
    ];

    const titles = [
      'Startup Summit', 'Music Fest', 'Art & Culture Expo', 'Food Carnival',
      'Tech Conference', 'Comedy Night', 'Fitness Bootcamp', 'Photography Walk',
      'Book Fair', 'Dance Workshop', 'Gaming Tournament', 'Wellness Retreat',
      'Film Screening', 'Hackathon', 'Fashion Show',
    ];

    const imageUrls = [
      'https://zlgvwkdlifdpfncagcuc.supabase.co/storage/v1/object/public/event-images/event-covers/cd485a16-fa8b-485d-b86d-62240662c22f/8642896f-89ab-4bd2-b0cf-df04a065dc5c.png',
      'https://zlgvwkdlifdpfncagcuc.supabase.co/storage/v1/object/public/event-images/event-covers/cd485a16-fa8b-485d-b86d-62240662c22f/3c2a247c-8e50-4cea-a3cc-e9d5bec21723.jpg',
      'https://zlgvwkdlifdpfncagcuc.supabase.co/storage/v1/object/public/event-images/event-covers/cd485a16-fa8b-485d-b86d-62240662c22f/a21ae486-d43a-4581-be2d-19bf3e96bed7.png',
      'https://zlgvwkdlifdpfncagcuc.supabase.co/storage/v1/object/public/event-images/event-covers/cd485a16-fa8b-485d-b86d-62240662c22f/aaef70eb-0d2c-4d25-b801-950104f3d3ad.jpg',
    ];

    const results: Event[] = [];
    const today = new Date();

    // Headroom computed up front: throwing inside the loop would abort the batch partway and
    // leave a partial seed committed.
    const currentFeaturedCount = await this.eventsRepository.count({
      where: { featured: true, deletedAt: null as any },
    });
    let remainingFeaturedSlots = Math.max(0, EventsService.MAX_FEATURED_EVENTS - currentFeaturedCount);

    for (let i = 0; i < count; i++) {
      const daysAhead = 3 + (i % 30);
      const eventDate = new Date(today);
      eventDate.setDate(today.getDate() + daysAhead);
      const dateStr = eventDate.toISOString().split('T')[0];

      const venue = venues[i % venues.length];
      const title = `${titles[i % titles.length]} ${i + 1}`;
      // Cycle through all 4 real cover images; fall back to the caller-supplied URL
      // only if the built-in pool is somehow exhausted (shouldn't happen in practice).
      const resolvedCover = imageUrls[i % imageUrls.length] ?? coverImageUrl;

      const wantsFeatured = i % 3 === 0 && remainingFeaturedSlots > 0;
      if (wantsFeatured) remainingFeaturedSlots--;

      const dto: CreateEventDto = {
        title,
        description: `This is a seeded test event — ${title}. Created for development and QA purposes.`,
        categoryId,
        venueName: venue.name,
        venueAddress: venue.address,
        eventDate: dateStr,
        startTime: '10:00',
        endTime: '18:00',
        coverImageUrl: resolvedCover,
        imageUrl: resolvedCover,
        featured: wantsFeatured,
        isOnline: false,
        pricePerTicket: 0,
        totalCapacity: 100,
        ticketTypes: [{ category: TicketCategory.GENERAL, price: 0, quantityTotal: 100 }],
      };

      const event = await this.createForUser(dto, userId, userRoles);
      results.push(event);
    }

    this.logger.log(`Bulk seeded ${results.length} events by user ${userId}`);
    return results;
  }

  // Filtered list for public endpoint with pagination
  async findAllFiltered(filters: {
    categoryId?: string;
    isOnline?: boolean;
    page?: number;
    limit?: number;
    search?: string;
    // Matches the flat pricePerTicket column only, so tier-priced events with no flat price
    // won't match a price filter. Accepted v1 scope.
    priceMin?: number;
    priceMax?: number;
    // 'YYYY-MM-DD', matched against Event.eventDate (a date column, not a timestamp).
    dateFrom?: string;
    dateTo?: string;
    // 'eventDate' (default): soonest-upcoming first — the long-standing browse order.
    // 'newest': most-recently-created first, for Home's latest feed and Explore's full catalog.
    sortBy?: 'eventDate' | 'newest';
  }): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const { categoryId, isOnline, page = 1, limit = 20, search, priceMin, priceMax, dateFrom, dateTo, sortBy = 'eventDate' } = filters;

    // Free-text search bypasses the cache: one entry per distinct search string is unbounded
    // growth for near-zero hit rate.
    const trimmedSearch = search?.trim();
    const cacheKey = trimmedSearch
      ? null
      : await this.eventsListCacheKey(categoryId, isOnline, page, limit, priceMin, priceMax, dateFrom, dateTo, sortBy);
    if (cacheKey) {
      const cached = await this.cache.get<{ events: Event[]; total: number; page: number; totalPages: number }>(cacheKey);
      if (cached) return cached;
    }

    const skip = (page - 1) * limit;
    // Public browse now returns every approved event whatever its state — upcoming, ongoing,
    // finished or cancelled — and the client labels each one (see the status badge in
    // EventInterestCard). Previously this excluded cancelled events and floored eventDate at
    // today, which meant a catalogue of past events rendered as an empty app while the admin
    // dashboard showed them all.
    //
    // Still excluded, and deliberately: soft-deleted rows, and anything not APPROVED —
    // a pending or rejected event is not public at all, which is a different question from
    // whether it has already happened.
    const base: any = {
      deletedAt: null as any,
      approvalStatus: EventApprovalStatus.APPROVED,
    };

    if (categoryId) base.categoryId = categoryId;
    if (isOnline !== undefined) base.isOnline = isOnline;

    if (priceMin !== undefined && priceMax !== undefined) base.pricePerTicket = Between(priceMin, priceMax);
    else if (priceMin !== undefined) base.pricePerTicket = MoreThanOrEqual(priceMin);
    else if (priceMax !== undefined) base.pricePerTicket = LessThanOrEqual(priceMax);

    // An explicit range from the caller is honoured exactly. There is no longer an implicit
    // floor at today: a caller that wants only future events asks for them with dateFrom,
    // rather than the listing deciding on their behalf.
    if (dateFrom && dateTo) base.eventDate = Between(dateFrom, dateTo);
    else if (dateFrom) base.eventDate = MoreThanOrEqual(dateFrom);
    else if (dateTo) base.eventDate = LessThanOrEqual(dateTo);

    // Matched server-side before pagination — filtering only the current page meant a
    // bookable event several pages deep could never surface.
    const where: any = trimmedSearch
      ? [
          { ...base, title: ILike(`%${trimmedSearch}%`) },
          { ...base, venueName: ILike(`%${trimmedSearch}%`) },
        ]
      : base;

    const [events, total] = await this.eventsRepository.findAndCount({
      where,
      relations: ['organizer', 'organizer.user', 'category', 'ticketTypes'],
      select: SAFE_ORGANIZER_SELECT,
      // id tiebreaker: rapidly-created rows share a createdAt to the millisecond, so
      // createdAt alone makes ordering (and pagination) non-deterministic.
      order: sortBy === 'newest' ? { createdAt: 'DESC', id: 'DESC' } : { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });

    const result = {
      events: events.map((e) => this.withComputedFields(e)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
    if (cacheKey) await this.cache.set(cacheKey, result, EventsService.EVENTS_LIST_TTL_SECONDS);
    return result;
  }

  // totalCapacity/availableTickets/isCompleted are recomputed at read time and never
  // persisted, so they can't clobber the legacy columns for write-path callers.
  private withComputedFields<T extends Event>(event: T): T {
    const tiers = event.ticketTypes;
    const totalSold = tiers?.length ? tiers.reduce((sum, t) => sum + t.quantitySold, 0) : 0;
    const tierDerivedCapacity =
      tiers?.length && tiers.every((t) => t.quantityTotal != null)
        ? tiers.reduce((sum, t) => sum + t.quantityTotal!, 0)
        : undefined;
    const totalCapacity = event.capacity ?? tierDerivedCapacity;
    return {
      ...event,
      totalCapacity,
      availableTickets: totalCapacity != null ? Math.max(totalCapacity - totalSold, 0) : undefined,
      isCompleted: isEventOver(event),
      ticketTypes: undefined,
    } as T;
  }

  async findOne(id: string): Promise<Event> {
    const event = await this.eventsRepository.findOne({
      where: { id, deletedAt: null as any },
      relations: ['organizer', 'organizer.user', 'category', 'ticketTypes'],
      select: SAFE_ORGANIZER_SELECT,
    });
    if (!event) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }
    return event;
  }

  // Public GET /:id: non-owners see approved events only, 404 rather than 403 so existence
  // isn't leaked. Write paths call findOne() directly to avoid a stale cached row.
  private async findOneCached(id: string): Promise<Event> {
    const cacheKey = eventDetailCacheKey(id);
    const cached = await this.cache.get<Event>(cacheKey);
    if (cached) return cached;
    const event = await this.findOne(id);
    await this.cache.set(cacheKey, event, EventsService.EVENT_DETAIL_TTL_SECONDS);
    return event;
  }

  async findOneForViewer(id: string, userId?: string, userRoles: string[] = []): Promise<Event> {
    const event = await this.findOneCached(id);
    const isOwnerOrAdmin = userId ? await this.isOwnerOrAdmin(event, userId, userRoles) : false;
    // Plain field check rather than event.isApproved() — a cache hit returns a plain
    // deserialized object, not an Event class instance, so it has no instance methods.
    if (!isOwnerOrAdmin && event.approvalStatus !== EventApprovalStatus.APPROVED) {
      throw new NotFoundException(`Event with id ${id} not found`);
    }

    // Cancelling flips status only, so a cancelled event's page stayed open to anyone with
    // the link. Anyone who booked still needs access; other viewers get the same 404.
    if (!isOwnerOrAdmin && event.status === EventStatus.CANCELLED) {
      const hasEnrollment = userId ? await this.enrollmentRepository.exist({ where: { eventId: id, userId } }) : false;
      if (!hasEnrollment) {
        throw new NotFoundException(`Event with id ${id} not found`);
      }
    }

    return this.withComputedFields(event);
  }

  async update(id: string, updateEventDto: UpdateEventDto, userId: string, userRoles: string[]): Promise<Event> {
    const event = await this.findOne(id);

    // Validate category if being updated
    if (updateEventDto.categoryId) {
      await this.validateCategory(updateEventDto.categoryId);
    }

    // Only checked on a false→true transition — resaving an already-featured event
    // (or explicitly unfeaturing one) must never trip the cap.
    if (updateEventDto.featured === true && !event.featured) {
      await this.assertFeaturedCapAvailable();
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

      // PATCH /events/:id has no admin guard, so moderation fields are denylisted here —
      // otherwise an organizer could self-approve, reassign, or silently un-cancel.
      if (updateEventDto.organizerId !== undefined && updateEventDto.organizerId !== event.organizerId) {
        throw new ForbiddenException('Only an admin can reassign an event to a different organizer');
      }
      if (updateEventDto.status !== undefined) {
        throw new ForbiddenException('Only an admin can change event status directly');
      }
      if (
        updateEventDto.approvalStatus !== undefined &&
        updateEventDto.approvalStatus !== EventApprovalStatus.DRAFT &&
        updateEventDto.approvalStatus !== EventApprovalStatus.PENDING_APPROVAL
      ) {
        throw new ForbiddenException('Only an admin can approve or reject an event');
      }
      if (
        updateEventDto.approvedBy !== undefined ||
        updateEventDto.rejectedBy !== undefined ||
        updateEventDto.rejectionReason !== undefined
      ) {
        throw new ForbiddenException('Only an admin can set approval/rejection metadata on an event');
      }
    }

    // Section 4c: close free-to-paid loophole
    const wasApproved = event.approvalStatus === EventApprovalStatus.APPROVED;
    const switchingToPaid =
      updateEventDto.pricePerTicket !== undefined &&
      Number(updateEventDto.pricePerTicket) > 0 &&
      !event.isPaid;
    // Editing moderated content (title/description/category/cover) re-opens review;
    // logistics fields below apply immediately.
    const CONTENT_FIELDS = ['title', 'description', 'categoryId', 'coverImageUrl', 'imageUrl'] as const;
    const contentChanged = CONTENT_FIELDS.some(
      (field) => updateEventDto[field] !== undefined && updateEventDto[field] !== event[field],
    );
    // Free events are auto-approved at creation and must stay that way: only paid events
    // ever sit in the admin queue. Without the willBePaid guard, a free event was approved on
    // create and then un-approved seconds later by its own cover-image upload — the app
    // uploads media after the event row exists, and coverImageUrl is a content field. That
    // left it PENDING_APPROVAL, invisible in the app, and (because findPending filtered on
    // isPaid) absent from the queue an admin would have to use to fix it.
    const willBePaid =
      updateEventDto.pricePerTicket !== undefined
        ? Number(updateEventDto.pricePerTicket) > 0
        : event.isPaid;
    if (wasApproved && (switchingToPaid || (contentChanged && willBePaid))) {
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

    // Only a live event returns to the queue — editing an already-pending event doesn't
    // re-alert, since it is still in the same review list.
    if (wasApproved && updatedEvent.approvalStatus === EventApprovalStatus.PENDING_APPROVAL) {
      void this.notifyAdminsOfPendingApproval(updatedEvent);
    }

    await invalidateEventCaches(this.cache, updatedEvent.id);
    return updatedEvent;
  }

  // Resolves the organizer's name for the admin alert. Never throws: called fire-and-forget
  // after the primary write has committed.
  private async notifyAdminsOfPendingApproval(event: Event): Promise<void> {
    try {
      const organizer = event.organizerId
        ? await this.organizersRepository.findOne({ where: { id: event.organizerId } })
        : null;
      await this.notificationService.notifyAdminsEventPendingApproval(
        event.id,
        event.title,
        organizer?.companyName ?? 'An organizer',
      );
    } catch (err) {
      this.logger.warn(
        `Failed to notify admins that event ${event.id} is pending approval: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    // An event with unresolved bookings can't vanish — that strands a paying participant or
    // lets an organizer dodge a refund.
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
    await invalidateEventCaches(this.cache, event.id);
  }

  // Soft cancellation, allowed even with active bookings: cancelling IS the resolution path,
  // and attendees can then self-serve a refund.
  async cancelEvent(id: string, userId: string, userRoles: string[], reason?: string): Promise<Event> {
    const event = await this.findOne(id);

    if (!userRoles.includes('admin')) {
      const organizer = await this.organizersRepository.findOne({ where: { userId } });
      if (!organizer || organizer.id !== event.organizerId) {
        throw new ForbiddenException('You can only cancel your own events');
      }
    }

    if (event.status === EventStatus.CANCELLED) {
      throw new BadRequestException('This event is already cancelled');
    }
    if (getEventEndDateTime(event).getTime() < Date.now()) {
      throw new BadRequestException('Cannot cancel an event that has already ended');
    }

    event.status = EventStatus.CANCELLED;
    event.updatedBy = userId;
    const saved = await this.eventsRepository.save(event);
    await invalidateEventCaches(this.cache, saved.id);

    this.logger.log(`Event ${saved.id} (${saved.title}) cancelled by user ${userId}${reason ? `: ${reason}` : ''}`);

    // Fire-and-forget: the cancellation is already committed and must not fail because a
    // notification hiccuped.
    void this.notifyEventCancelled(saved.id, saved.title, reason);

    return saved;
  }

  private async notifyEventCancelled(eventId: string, eventTitle: string, reason?: string): Promise<void> {
    const activeEnrollments = await this.enrollmentRepository.find({
      where: [{ eventId, status: 'confirmed' }, { eventId, status: 'pending' }],
    });
    const userIds = [...new Set(activeEnrollments.map((e) => e.userId))];
    if (userIds.length === 0) return;
    await this.notificationService.notifyEventCancelled(userIds, eventId, eventTitle, reason);
  }

  async findMyEvents(userId: string): Promise<Event[]> {
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) return [];
    const events = await this.eventsRepository.find({
      where: { organizerId: organizer.id, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
      select: SAFE_ORGANIZER_SELECT,
    });
    return events.map((e) => this.withComputedFields(e));
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

  async findMyFavorites(userId: string): Promise<Event[]> {
    const favorites = await this.favoritesRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    if (favorites.length === 0) return [];

    // A select nested under a relation without the root entity's own columns silently
    // matched zero rows in TypeORM, so query eventsRepository directly instead.
    const events = await this.eventsRepository.find({
      where: { id: In(favorites.map((f) => f.eventId)) },
      relations: ['organizer', 'organizer.user', 'category'],
      select: SAFE_ORGANIZER_SELECT,
    });
    const eventById = new Map(events.map((e) => [e.id, this.withComputedFields(e)]));
    // Preserve favorites' own createdAt DESC order (most-recently-saved first) rather than
    // whatever order eventsRepository.find(In(...)) happens to return.
    return favorites.map((f) => eventById.get(f.eventId)).filter((e): e is Event => !!e);
  }

  // Not cached: the shared list cache is keyed on filters identical for every requester,
  // so caching a per-user follow list would leak one user's events into another's response.
  async findFromFollowing(userId: string, page: number = 1, limit: number = 20): Promise<Event[]> {
    const follows = await this.followsRepository.find({ where: { userId } });
    if (follows.length === 0) return [];

    const organizerIds = follows.map((f) => f.organizerId);
    const skip = (page - 1) * limit;
    const events = await this.eventsRepository.find({
      where: {
        organizerId: In(organizerIds),
        approvalStatus: EventApprovalStatus.APPROVED,
        status: Not(EventStatus.CANCELLED),
        deletedAt: null as any,
        eventDate: MoreThanOrEqual(todayIstDateKey()),
      },
      relations: ['organizer', 'organizer.user', 'category', 'ticketTypes'],
      select: SAFE_ORGANIZER_SELECT,
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });
    return events.map((e) => this.withComputedFields(e));
  }

  async addFavorite(eventId: string, userId: string): Promise<void> {
    const event = await this.eventsRepository.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException(`Event ${eventId} not found`);

    const existing = await this.favoritesRepository.findOne({ where: { userId, eventId } });
    if (existing) return; // idempotent — saving twice is a no-op, not an error

    const favorite = this.favoritesRepository.create({ userId, eventId });
    try {
      await this.favoritesRepository.save(favorite);
    } catch (err) {
      // Race: two concurrent "save" taps for the same event both passed the check above.
      if ((err as { code?: string })?.code !== '23505') throw err;
    }
  }

  async removeFavorite(eventId: string, userId: string): Promise<void> {
    await this.favoritesRepository.delete({ userId, eventId });
  }

  // Public-safe counterpart to findByOrganizerId, which returns drafts and rejected events
  // — correct for the organizer's own screen, a leak if exposed publicly.
  async findPublicEventsByOrganizer(organizerId: string, page: number = 1, limit: number = 20): Promise<Event[]> {
    const skip = (page - 1) * limit;
    return await this.eventsRepository.find({
      where: {
        organizerId,
        approvalStatus: EventApprovalStatus.APPROVED,
        status: Not(EventStatus.CANCELLED),
        deletedAt: null as any,
      },
      relations: ['organizer', 'organizer.user', 'category'],
      select: SAFE_ORGANIZER_SELECT,
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });
  }

  async findByOrganizerId(organizerId: string): Promise<Event[]> {
    return await this.eventsRepository.find({
      where: { organizerId, deletedAt: null as any },
      relations: ['organizer', 'organizer.user'],
      select: SAFE_ORGANIZER_SELECT,
    });
  }

  // Ticket-type CRUD (organizer's own event; admins any). Editing or removing a tier is
  // blocked once it has sales — that protects buyers, not the approval workflow.
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
    const newSalesStartAt = dto.salesStartAt ? new Date(dto.salesStartAt) : undefined;
    const newSalesEndAt = dto.salesEndAt ? new Date(dto.salesEndAt) : undefined;
    this.assertSalesWindowOrdered(newSalesStartAt, newSalesEndAt);
    await this.syncEventPaidStatusForTierPrice(event, dto.price);

    const ticketType = this.ticketTypesRepository.create({
      eventId,
      category: dto.category,
      name: TICKET_CATEGORY_LABELS[dto.category],
      benefits: dto.benefits,
      price: dto.price,
      currency: dto.currency ?? event.currency,
      quantityTotal: dto.quantityTotal,
      salesStartAt: newSalesStartAt,
      salesEndAt: newSalesEndAt,
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
    if (dto.price !== undefined) await this.syncEventPaidStatusForTierPrice(event, dto.price);

    if (dto.salesStartAt !== undefined) ticketType.salesStartAt = dto.salesStartAt ? new Date(dto.salesStartAt) : undefined;
    if (dto.salesEndAt !== undefined) ticketType.salesEndAt = dto.salesEndAt ? new Date(dto.salesEndAt) : undefined;
    this.assertSalesWindowOrdered(ticketType.salesStartAt, ticketType.salesEndAt);
    // category is pulled out rather than left in `rest`: assigning it alone would leave the
    // stored `name` describing the *old* category, since nothing else recomputes it.
    const { salesStartAt, salesEndAt, category, ...rest } = dto;
    Object.assign(ticketType, rest);
    if (category !== undefined) {
      ticketType.category = category;
      ticketType.name = TICKET_CATEGORY_LABELS[category];
    }

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
    // quantitySold can be 0 while people are queued via an event-level capacity cap.
    // Deleting the tier would cascade-delete those waitlist rows with no notice.
    if (await this.waitlistService.hasWaitingEntries(ticketTypeId)) {
      throw new ForbiddenException('Cannot remove a ticket tier that people are currently waitlisted for');
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

  // Same visibility rule as ticket types: media for a not-yet-approved event stays visible
  // only to the organizer and admins.
  async findMedia(eventId: string, userId?: string, userRoles: string[] = []): Promise<EventMedia[]> {
    const event = await this.findOne(eventId);
    const isOwnerOrAdmin = userId ? await this.isOwnerOrAdmin(event, userId, userRoles) : false;
    if (!isOwnerOrAdmin && !event.isApproved()) {
      return [];
    }
    return this.eventMediaRepository.find({ where: { eventId }, order: { position: 'ASC', createdAt: 'ASC' } });
  }

  async addMedia(eventId: string, dto: CreateEventMediaDto, userId: string, userRoles: string[]): Promise<EventMedia> {
    const event = await this.findOne(eventId);
    await this.assertOwnsEvent(event, userId, userRoles);
    this.assertNotRejected(event);

    const media = this.eventMediaRepository.create({
      eventId,
      type: dto.type,
      url: dto.url,
      position: dto.position ?? 0,
    });
    const saved = await this.eventMediaRepository.save(media);
    this.logger.log(`Added ${saved.type} media ${saved.id} on event ${eventId}`);
    return saved;
  }

  async removeMedia(eventId: string, mediaId: string, userId: string, userRoles: string[]): Promise<void> {
    const event = await this.findOne(eventId);
    await this.assertOwnsEvent(event, userId, userRoles);

    const media = await this.eventMediaRepository.findOne({ where: { id: mediaId, eventId } });
    if (!media) {
      throw new NotFoundException(`Media ${mediaId} not found on event ${eventId}`);
    }
    await this.eventMediaRepository.remove(media);
    this.logger.log(`Removed media ${mediaId} on event ${eventId}`);
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

  // A rejected event is a dead end. Pending events are exempt on purpose — organizers build
  // out tiers while waiting on review.
  private assertNotRejected(event: Event): void {
    if (event.approvalStatus === EventApprovalStatus.REJECTED) {
      throw new BadRequestException('Cannot modify ticket types on a rejected event');
    }
  }

  // Same guard as update()'s switchingToPaid, for the tier path: a free event that quietly
  // becomes paid skipped admin review, so flip isPaid and re-open review if approved.
  private async syncEventPaidStatusForTierPrice(event: Event, tierPrice: number): Promise<void> {
    if (!(Number(tierPrice) > 0) || event.isPaid) return;

    event.isPaid = true;
    const sentBackForReview = event.approvalStatus === EventApprovalStatus.APPROVED;
    if (sentBackForReview) {
      event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
      event.approvalMethod = undefined;
      event.approvedAt = undefined;
      event.approvedBy = undefined;
    }
    await this.eventsRepository.save(event);
    if (sentBackForReview) {
      void this.notifyAdminsOfPendingApproval(event);
    }
  }

  // Participant enrollment with atomic, race-safe ticket-type decrement. When the tier
  // is sold out, the request creates a WaitlistEntry instead of failing outright.
  async enroll(
    eventId: string,
    userId: string,
    ticketTypeId?: string,
    quantity = 1,
    accessPassword?: string,
  ): Promise<Enrollment | WaitlistEntryWithPosition> {
    const result = await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user?.isEmailVerified) {
        throw new ForbiddenException('Please verify your email before enrolling in events');
      }

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

      if (resolvedTicketType.accessPassword && resolvedTicketType.accessPassword !== accessPassword) {
        throw new ForbiddenException('Incorrect access password for this ticket type');
      }

      if (quantity < resolvedTicketType.minPerOrder) {
        throw new BadRequestException(`Minimum ${resolvedTicketType.minPerOrder} ticket(s) per order for this ticket type`);
      }
      if (resolvedTicketType.maxPerOrder != null && quantity > resolvedTicketType.maxPerOrder) {
        throw new BadRequestException(`Maximum ${resolvedTicketType.maxPerOrder} ticket(s) per order for this ticket type`);
      }

      const now = new Date();
      if (resolvedTicketType.salesStartAt && now < resolvedTicketType.salesStartAt) {
        throw new BadRequestException('Ticket sales have not started yet for this ticket type');
      }
      if (resolvedTicketType.salesEndAt && now > resolvedTicketType.salesEndAt) {
        throw new BadRequestException('Ticket sales have ended for this ticket type');
      }

      // Excludes cancelled bookings — a user who cancelled must be able to enroll again,
      // matching the partial unique index below (booking_status != 'cancelled').
      const existing = await manager.findOne(Enrollment, {
        where: { eventId, userId, status: Not('cancelled') },
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
      const baseAmount = Number(ticketType.price) * quantity;

      // Always run the fee calculation: it is the only place that knows what a buyer owes,
      // and short-circuiting free events would skip the flat registration fee.
      const feeOrganizer = await manager.findOne(Organizer, { where: { id: event.organizerId } });
      const breakdown = this.feeCalculationService.calculate(
        baseAmount,
        toCommissionConfig(feeOrganizer),
        event.feePayer,
      );
      const totalAmount = breakdown.buyerPrice;

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

      // The `existing` check is a guard, not a lock — the @Unique(userId,eventId) constraint
      // is the real backstop, translated here into the same 409 rather than a raw 500.
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
      return {
        soldOut: false as const,
        enrollment: saved,
        eventTitle: event.title,
        eventDate: event.eventDate,
        startTime: event.startTime,
        venueName: event.venueName,
      };
    });

    if (result.soldOut) {
      this.logger.log(`Ticket type ${result.ticketTypeId} sold out for event ${eventId}; user ${userId} joining waitlist`);
      return this.waitlistService.join(eventId, result.ticketTypeId, userId, quantity);
    }

    // The booking changed quantitySold, which availableTickets derives from — invalidate so
    // reads don't serve the pre-booking count for the rest of the TTL.
    await invalidateEventCaches(this.cache, eventId);

    // Only free bookings are paid-and-confirmed here; a paid booking's confirmation fires
    // from PaymentsService.handleWebhook() once payment succeeds.
    if (result.enrollment.paymentStatus === 'paid') {
      void this.notificationService.notifyBookingConfirmed(
        userId,
        eventId,
        result.enrollment.id,
        result.eventTitle,
        result.enrollment.bookingReference,
        result.enrollment.quantity,
        result.enrollment.ticketCode,
        result.eventDate,
        result.startTime,
        result.venueName,
      );
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

    // Frees a seat, same as enroll() consuming one. promoteNext may re-consume it and
    // invalidates again, so the cache ends up reflecting the net result.
    await invalidateEventCaches(this.cache, enrollment.eventId);

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
    await invalidateEventCaches(this.cache, event.id);

    // Fire-and-forget, same reasoning as cancelEvent()/notifyEventCancelled above — approval
    // is already committed by this point and must not fail because a notification hiccuped.
    void this.notificationService.notifyEventApproved(event.organizer.userId, event.id, event.title);

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
    await invalidateEventCaches(this.cache, event.id);

    // Fire-and-forget, same reasoning as approve() above.
    void this.notificationService.notifyEventRejected(event.organizer.userId, event.id, event.title, rejectionReason);

    return saved;
  }

  async findPending(page: number = 1, limit: number = 20): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;

    const [events, total] = await this.eventsRepository.findAndCount({
      // No isPaid filter. Only paid events are supposed to reach this queue, but that is
      // enforced where approval is decided — filtering it here as well meant any free event
      // that did become pending was invisible to the only screen that could approve it, so it
      // stayed unapproved and unreachable forever. The queue must show everything awaiting
      // review, not a subset it assumes is the only possibility.
      where: {
        approvalStatus: EventApprovalStatus.PENDING_APPROVAL,
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

  // Admin catalog listing: both filters are optional, unlike findPending (paid queue) and
  // findAllFiltered (public, APPROVED only), so drafts and cancelled events are visible.
  async findAllForAdmin(filters: {
    approvalStatus?: EventApprovalStatus;
    status?: EventStatus;
    page?: number;
    limit?: number;
  }): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const { approvalStatus, status, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { deletedAt: null as any };
    if (approvalStatus) where.approvalStatus = approvalStatus;
    if (status) where.status = status;

    const [events, total] = await this.eventsRepository.findAndCount({
      where,
      relations: ['organizer', 'organizer.user', 'category'],
      select: SAFE_ORGANIZER_SELECT,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      events: events.map((e) => this.withComputedFields(e)),
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
  async checkIn(
    ticketCode: string,
    userId: string,
    userRoles: string[],
    idempotencyKey?: string,
  ): Promise<Enrollment> {
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

    // Atomic claim: a read-then-write would honor the same ticket twice when scanned
    // concurrently. Stamping which scan won is what lets the branch below spot a retry.
    //
    // Destructured, because TypeORM's postgres driver returns [rows, rowCount] for UPDATE
    // and DELETE, and plain rows only for SELECT/INSERT (see PostgresQueryRunner.query).
    // Reading the result directly as the rows array made `.length` always 2 — truthy even
    // when the WHERE matched nothing — so the "claim won" branch was taken on EVERY scan.
    // A ticket already stamped used_date still reported a successful check-in, which made
    // every ticket reusable without limit: the one thing this atomic claim exists to stop.
    const [claimedRows] = await this.enrollmentRepository.query(
      `UPDATE event_bookings SET used_date = now(), check_in_key = $2, checked_in_by = $3
       WHERE id = $1 AND used_date IS NULL
       RETURNING used_date`,
      [enrollment.id, idempotencyKey ?? null, userId],
    );

    if (claimedRows?.length) {
      enrollment.checkedInAt = claimedRows[0].used_date;
      enrollment.checkInKey = idempotencyKey;
      enrollment.checkedInBy = userId;
      return enrollment;
    }

    // Lost the claim: the ticket was already used. Whether that is a problem depends
    // entirely on *whose* scan got there first.
    const [existing] = await this.enrollmentRepository.query(
      `SELECT used_date, check_in_key, checked_in_by FROM event_bookings WHERE id = $1`,
      [enrollment.id],
    );

    // Same scan arriving twice (retry or offline replay) — nobody got in twice, so this is
    // a success. Without it the client cannot tell this from a genuine duplicate.
    if (idempotencyKey && existing?.check_in_key === idempotencyKey) {
      enrollment.checkedInAt = existing.used_date;
      enrollment.checkInKey = existing.check_in_key;
      enrollment.checkedInBy = existing.checked_in_by;
      return enrollment;
    }

    // A different scan claimed it. Two offline gates genuinely can both admit one ticket,
    // so report it precisely enough for the organizer to act.
    throw new ConflictException({
      message: 'Ticket already checked in',
      error: 'Conflict',
      statusCode: 409,
      alreadyCheckedIn: true,
      checkedInAt: existing?.used_date ?? null,
      checkedInBy: existing?.checked_in_by ?? null,
      // The distinction the client actually branches on: true means a second scan really
      // did happen and somebody may have been admitted twice.
      duplicateScan: true,
    });
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

  // Not a DB constraint: two concurrent requests could briefly push the count to 6, but this
  // is curation, not a financial invariant, so an app-level check is proportionate.
  private async assertFeaturedCapAvailable(): Promise<void> {
    const currentCount = await this.eventsRepository.count({
      where: { featured: true, deletedAt: null as any },
    });
    if (currentCount >= EventsService.MAX_FEATURED_EVENTS) {
      throw new BadRequestException(
        `Only ${EventsService.MAX_FEATURED_EVENTS} events can be featured at a time. Unfeature another event first.`,
      );
    }
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

  // A swapped start/end would create a tier whose sales window can never be open, with no
  // error surfaced to the organizer at creation time.
  private assertSalesWindowOrdered(salesStartAt?: Date, salesEndAt?: Date): void {
    if (salesStartAt && salesEndAt && salesStartAt.getTime() >= salesEndAt.getTime()) {
      throw new BadRequestException('salesStartAt must be before salesEndAt');
    }
  }
}
