import { Injectable, NotFoundException, ForbiddenException, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike, In, Between, MoreThanOrEqual, LessThanOrEqual, Not } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Event, EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer, VerificationLevel } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType } from '../entities/ticket-type.entity';
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
import { getEventEndDateTime } from './utils/event-dates.util';
import { EVENTS_LIST_VERSION_KEY, eventDetailCacheKey, invalidateEventCaches } from './utils/event-cache.util';
import { CacheService } from '../common/cache/cache.service';

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
  ) {}

  // Public listings are read far more often than events are written, so they're cached for
  // a short window. The list is parameterized (category/online/page/limit), so instead of
  // invalidating every possible key combination on a write, a version number is folded into
  // the key — bumping it makes every previously-cached list entry unreachable at once.
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
  ): Promise<string> {
    const version = await this.cache.getVersion(EVENTS_LIST_VERSION_KEY);
    return `events:list:${version}:${categoryId ?? 'all'}:${isOnline ?? 'all'}:${page}:${limit}:${priceMin ?? '-'}:${priceMax ?? '-'}:${dateFrom ?? '-'}:${dateTo ?? '-'}`;
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

      const organizer = await manager.findOne(Organizer, { where: { userId } });
      const isAdmin = userRoles.includes('admin');

      // Previously this auto-created an Organizer profile and silently granted the
      // 'organizer' role to any user on their first event — no identity/KYC check at all.
      // Per #7, a user must submit and pass admin-reviewed verification (identity proof,
      // address proof, PAN/Aadhaar, UPI ID — see OrganizerController's verification
      // endpoints) before they gain authority to organize events. Admins creating on behalf
      // of an existing organizer (createEventDto.organizerId) are exempt from this gate.
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
        // Only reachable for an admin with no organizer profile of their own and no
        // organizerId in the request — the non-admin path above already guarantees a
        // verified organizer exists by this point.
        throw new BadRequestException('organizerId is required to create an event as an admin.');
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

    // Computed once, up front, rather than relying on assertFeaturedCapAvailable() inside
    // the loop — that would throw and abort the whole batch partway through (leaving a
    // partial seed committed) as soon as the 5th featured event was hit. Precomputing the
    // remaining headroom lets every event in the batch save cleanly, with at most that many
    // marked featured.
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
        ticketTypes: [{ name: 'General Admission', price: 0, quantityTotal: 100 }],
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
    // Filtered against the flat pricePerTicket column — events priced purely via
    // ticketTypes tiers (no flat price set) won't match a price-range filter. Acceptable v1
    // scope; revisit if/when tier-based pricing becomes the primary model.
    priceMin?: number;
    priceMax?: number;
    // 'YYYY-MM-DD', matched against Event.eventDate (a date column, not a timestamp).
    dateFrom?: string;
    dateTo?: string;
  }): Promise<{ events: Event[]; total: number; page: number; totalPages: number }> {
    const { categoryId, isOnline, page = 1, limit = 20, search, priceMin, priceMax, dateFrom, dateTo } = filters;

    // Free-text search bypasses the cache: caching would mean one cache entry per distinct
    // search string ever typed, most never hit again — unbounded cache growth for near-zero
    // hit rate, unlike the small, reused categoryId/isOnline/page/limit key space below.
    const trimmedSearch = search?.trim();
    const cacheKey = trimmedSearch
      ? null
      : await this.eventsListCacheKey(categoryId, isOnline, page, limit, priceMin, priceMax, dateFrom, dateTo);
    if (cacheKey) {
      const cached = await this.cache.get<{ events: Event[]; total: number; page: number; totalPages: number }>(cacheKey);
      if (cached) return cached;
    }

    const skip = (page - 1) * limit;
    // Cancelling an event only flips `status`, not `approvalStatus` (it was already
    // approved) — without excluding CANCELLED here too, a cancelled event stayed visible
    // in every public listing (Home/Search/Explore) since it still passed this filter.
    const base: any = {
      deletedAt: null as any,
      approvalStatus: EventApprovalStatus.APPROVED,
      status: Not(EventStatus.CANCELLED),
    };

    if (categoryId) base.categoryId = categoryId;
    if (isOnline !== undefined) base.isOnline = isOnline;

    if (priceMin !== undefined && priceMax !== undefined) base.pricePerTicket = Between(priceMin, priceMax);
    else if (priceMin !== undefined) base.pricePerTicket = MoreThanOrEqual(priceMin);
    else if (priceMax !== undefined) base.pricePerTicket = LessThanOrEqual(priceMax);

    if (dateFrom && dateTo) base.eventDate = Between(dateFrom, dateTo);
    else if (dateFrom) base.eventDate = MoreThanOrEqual(dateFrom);
    else if (dateTo) base.eventDate = LessThanOrEqual(dateTo);

    // SearchScreen previously only filtered events already paginated into the client — a
    // real, bookable event several pages deep in the catalog would never surface. Matching
    // server-side, before pagination, is what makes the full catalog actually searchable.
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
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });

    const result = {
      events: events.map((e) => this.withComputedSeats(e)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
    if (cacheKey) await this.cache.set(cacheKey, result, EventsService.EVENTS_LIST_TTL_SECONDS);
    return result;
  }

  // totalCapacity/availableTickets are deprecated static columns that real (non-seeded)
  // events never populate — recomputed here, at read time, for list/detail responses only
  // (never persisted, so it can't clobber those legacy columns for internal write-path
  // callers that call findOne() directly: update/approve/reject/ticket-type CRUD).
  // event.capacity (the organizer's explicit event-wide cap, if they set one at
  // creation/edit) wins when present; otherwise the total falls back to summing every
  // tier's own quantityTotal, same derivation as before that field existed. Either way,
  // "sold" is always the live sum across all tiers, so a capacity entered after some
  // tickets are already sold still nets out correctly.
  private withComputedSeats<T extends Event>(event: T): T {
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

  // Public-facing single-event lookup (the GET /:id route). Non-owners/non-admins may
  // only see approved events — a pending or rejected event's full details (venue,
  // organizer contact info, rejection reason) stay invisible to everyone except the
  // owning organizer or an admin. 404 rather than 403 so existence isn't leaked either.
  // Internal callers that already do their own authorization (update/remove/ticket-type
  // CRUD/etc.) should keep calling findOne() directly — this wrapper is only for that
  // one public route.
  // Cache-wraps findOne() for the public detail read path only — write paths (update,
  // approve, reject, remove, ticket-type CRUD) keep calling findOne() directly so they
  // always mutate a fresh row, never a stale cached copy.
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

    // Cancelling only flips `status`, not `approvalStatus` (it was already approved) — so
    // without this, a cancelled event's detail page stayed fully open to anyone with the
    // link/id, same bug findAllFiltered/findFromFollowing/findPublicEventsByOrganizer above
    // already had to fix for listings. Unlike those, this isn't a blanket hide: someone who
    // actually booked (any enrollment status — even a since-cancelled/refunded one counts as
    // "had a stake in this") still needs to reach this page for context and the "View Event"
    // link from their own ticket to keep working. A random non-enrolled viewer gets the same
    // 404 a pending/rejected event already gives.
    if (!isOwnerOrAdmin && event.status === EventStatus.CANCELLED) {
      const hasEnrollment = userId ? await this.enrollmentRepository.exist({ where: { eventId: id, userId } }) : false;
      if (!hasEnrollment) {
        throw new NotFoundException(`Event with id ${id} not found`);
      }
    }

    return this.withComputedSeats(event);
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

      // PATCH /events/:id has no @Roles('admin') guard — organizers legitimately use it
      // for everything else about their event, so the admin-moderation fields have to be
      // denylisted here instead. Without this, Object.assign(event, updateEventDto) below
      // would apply a client-supplied approvalStatus/approvedBy/rejectedBy/organizerId/
      // status verbatim, letting an organizer self-approve their own event, forge an
      // approvedBy/rejectedBy id, reassign the event to a different organizer, or silently
      // un-cancel an event outside the dedicated cancel endpoint.
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
    // Editing moderated content (title/description/category/cover image) on an
    // already-approved event sends it back for review, same as the free-to-paid
    // loophole above — logistics fields (date/time/venue/capacity) stay in the
    // "safe" bucket below and apply immediately instead.
    const CONTENT_FIELDS = ['title', 'description', 'categoryId', 'coverImageUrl', 'imageUrl'] as const;
    const contentChanged = CONTENT_FIELDS.some(
      (field) => updateEventDto[field] !== undefined && updateEventDto[field] !== event[field],
    );
    if (wasApproved && (switchingToPaid || contentChanged)) {
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

    await invalidateEventCaches(this.cache, updatedEvent.id);
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
    await invalidateEventCaches(this.cache, event.id);
  }

  // Soft cancellation (status flip, not a delete) — unlike remove() above, this is allowed
  // even with active bookings, since cancelling *is* the resolution path for an event that
  // can no longer happen: attendees are notified and can self-serve a refund via
  // PaymentsService.requestRefund(), rather than the event just vanishing on them.
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

    // Fire-and-forget, same reasoning as AnnouncementsService.notifyAttendees — the
    // cancellation itself is already committed by this point and must not fail because a
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

  async findMyFavorites(userId: string): Promise<Event[]> {
    const favorites = await this.favoritesRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    if (favorites.length === 0) return [];

    // A `select` nested under a relation (favorites.event.organizer.*) without also
    // listing the base Favorite/Event columns silently matched zero rows — TypeORM needs
    // the root entity's own columns selected too, not just a deeply-nested sub-selection.
    // Querying eventsRepository directly, the same select shape findAll/findAllFiltered
    // already use successfully, sidesteps that entirely.
    const events = await this.eventsRepository.find({
      where: { id: In(favorites.map((f) => f.eventId)) },
      relations: ['organizer', 'organizer.user', 'category'],
      select: SAFE_ORGANIZER_SELECT,
    });
    const eventById = new Map(events.map((e) => [e.id, e]));
    // Preserve favorites' own createdAt DESC order (most-recently-saved first) rather than
    // whatever order eventsRepository.find(In(...)) happens to return.
    return favorites.map((f) => eventById.get(f.eventId)).filter((e): e is Event => !!e);
  }

  // Backs GET /events/from-following. Deliberately not run through the shared
  // eventsListCacheKey/cache path findAllFiltered uses — that cache is keyed on filter
  // values that are the same for every requester (categoryId/isOnline/page/limit); this
  // result is scoped to one user's follow list, so caching it under a shared key would
  // leak one user's followed events into another user's response.
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
      },
      relations: ['organizer', 'organizer.user', 'category', 'ticketTypes'],
      select: SAFE_ORGANIZER_SELECT,
      order: { eventDate: 'ASC', startTime: 'ASC' },
      skip,
      take: limit,
    });
    return events.map((e) => this.withComputedSeats(e));
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

  // findByOrganizerId (above) returns every status, including drafts/pending/rejected —
  // correct for the organizer's own management screen, but exposing it publicly would leak
  // an organizer's unpublished events to any viewer. This is the public-safe counterpart
  // backing OrganizerProfileScreen's event list, independent of the viewer's follow status.
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
    await this.syncEventPaidStatusForTierPrice(event, dto.price);

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
    if (dto.price !== undefined) await this.syncEventPaidStatusForTierPrice(event, dto.price);

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

  // Gallery media (carousel items shown after the cover image on EventDetailsScreen).
  // Same visibility rule as ticket types: pricing/media for a not-yet-approved event is
  // only the organizer's/admin's business until it's actually approved for public viewing.
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

  // A rejected event is a dead end — it can't grow new sellable tiers or have existing
  // ones repriced. Pending-approval events are exempt on purpose: organizers build out
  // tiers while waiting on admin review, per the original ticket-type CRUD design.
  private assertNotRejected(event: Event): void {
    if (event.approvalStatus === EventApprovalStatus.REJECTED) {
      throw new BadRequestException('Cannot modify ticket types on a rejected event');
    }
  }

  // Mirrors update()'s switchingToPaid guard for the legacy flat-price field, but for
  // the tier-based path: pricing a tier above zero on a currently-free event is the same
  // "free event skipped admin review, then quietly became paid" gap — nested ticket-type
  // CRUD is the other place event pricing can change post-creation, so it needs the same
  // fix: flip isPaid, and if the event was already approved, send it back for review.
  private async syncEventPaidStatusForTierPrice(event: Event, tierPrice: number): Promise<void> {
    if (!(Number(tierPrice) > 0) || event.isPaid) return;

    event.isPaid = true;
    if (event.approvalStatus === EventApprovalStatus.APPROVED) {
      event.approvalStatus = EventApprovalStatus.PENDING_APPROVAL;
      event.approvalMethod = undefined;
      event.approvedAt = undefined;
      event.approvedBy = undefined;
    }
    await this.eventsRepository.save(event);
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
      return { soldOut: false as const, enrollment: saved, eventTitle: event.title };
    });

    if (result.soldOut) {
      this.logger.log(`Ticket type ${result.ticketTypeId} sold out for event ${eventId}; user ${userId} joining waitlist`);
      return this.waitlistService.join(eventId, result.ticketTypeId, userId, quantity);
    }

    // The confirmed enrollment just changed this ticket type's quantitySold, which
    // availableTickets (withComputedSeats) is derived from — invalidate so list/detail
    // reads don't keep serving the pre-booking count for the rest of the cache TTL.
    await invalidateEventCaches(this.cache, eventId);

    // Only free bookings are actually paid-and-confirmed at this point (paymentStatus is
    // set to 'paid' immediately for those, above) — a paid booking's confirmation email
    // fires from PaymentsService.handleWebhook() instead, once payment actually succeeds.
    if (result.enrollment.paymentStatus === 'paid') {
      void this.notificationService.notifyBookingConfirmed(
        userId,
        eventId,
        result.enrollment.id,
        result.eventTitle,
        result.enrollment.bookingReference,
        result.enrollment.quantity,
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

    // Frees up a seat, same as enroll() consuming one — invalidate for the same reason.
    // promoteNext (below) may immediately re-consume it via a promotion; that path
    // invalidates again itself, so the cache always ends up reflecting the net result.
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

  // General-purpose admin catalog listing — unlike findPending (hardcoded to the paid-
  // approval queue) and findAllFiltered (public browse, hardcoded to APPROVED), both
  // filters here are optional so admins can see draft/rejected/cancelled/ended events too.
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
      events: events.map((e) => this.withComputedSeats(e)),
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

  // Enforced wherever `featured` can flip false→true (createForUser, update). Not enforced
  // as a DB constraint — two concurrent requests could both pass this check and briefly
  // push the count to 6, but this is curation, not a financial/capacity invariant, so a
  // soft application-level check is an intentional, proportionate tradeoff.
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
}
