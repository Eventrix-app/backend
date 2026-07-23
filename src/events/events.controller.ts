import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { EventsService } from './events.service';
import { EventApprovalStatus, EventStatus } from '../entities/event.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EnrollDto } from './dto/enroll.dto';
import { CreateTicketTypeDto } from './dto/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dto/update-ticket-type.dto';
import { CreateEventMediaDto } from './dto/create-event-media.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';
import { UploadsService } from '../uploads/uploads.service';
import { ALLOWED_UPLOAD_CONTENT_TYPES, AllowedUploadContentType, UploadPurpose } from '../uploads/dto/create-signed-url.dto';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly uploadsService: UploadsService,
  ) { }

  // Admin-only testing endpoint: seed N events with a shared cover image.
  // All events are free → auto-approved and immediately visible in the app.
  // Declared before @Post() to guarantee NestJS registers it before the base route.
  @Roles('admin')
  @Post('bulk-seed')
  @HttpCode(HttpStatus.CREATED)
  async bulkSeed(
    @Body('count') count: number,
    @Body('coverImageUrl') coverImageUrl: string,
    @Body('categoryId') categoryId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    if (!count || count < 1 || count > 100) {
      throw new BadRequestException('count must be between 1 and 100');
    }
    if (!coverImageUrl) throw new BadRequestException('coverImageUrl is required');
    if (!categoryId) throw new BadRequestException('categoryId is required');
    return this.eventsService.bulkSeed(req.user.id, req.user.roles, count, coverImageUrl, categoryId);
  }

  @Post()
  async create(
    @Body() createEventDto: CreateEventDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.createForUser(createEventDto, req.user.id, req.user.roles);
  }

  @Public()
  @Get()
  async findAll(
    @Query('categoryId') categoryId?: string,
    @Query('isOnline') isOnline?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('search') search?: string,
    @Query('priceMin') priceMin?: string,
    @Query('priceMax') priceMax?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const onlineFlag = isOnline === undefined ? undefined : isOnline === 'true';

    const parsedPriceMin = priceMin !== undefined ? Number(priceMin) : undefined;
    const parsedPriceMax = priceMax !== undefined ? Number(priceMax) : undefined;
    if (parsedPriceMin !== undefined && (Number.isNaN(parsedPriceMin) || parsedPriceMin < 0)) {
      throw new BadRequestException('priceMin must be a non-negative number');
    }
    if (parsedPriceMax !== undefined && (Number.isNaN(parsedPriceMax) || parsedPriceMax < 0)) {
      throw new BadRequestException('priceMax must be a non-negative number');
    }

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (dateFrom !== undefined && !dateRe.test(dateFrom)) {
      throw new BadRequestException('dateFrom must be YYYY-MM-DD');
    }
    if (dateTo !== undefined && !dateRe.test(dateTo)) {
      throw new BadRequestException('dateTo must be YYYY-MM-DD');
    }

    return await this.eventsService.findAllFiltered({
      categoryId,
      isOnline: onlineFlag,
      page,
      limit,
      search,
      priceMin: parsedPriceMin,
      priceMax: parsedPriceMax,
      dateFrom,
      dateTo,
    });
  }

  // Admin list pending events (MUST come before :id route)
  @Roles('admin')
  @Get('pending')
  async findPending(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return await this.eventsService.findPending(page, limit);
  }

  // Admin catalog view across every status (draft/pending/approved/rejected × upcoming/
  // ongoing/completed/cancelled) — findPending above is scoped to the paid-approval queue
  // only, this is the general-purpose admin listing. MUST come before :id route.
  @Roles('admin')
  @Get('admin')
  async findAllForAdmin(
    @Query('approvalStatus') approvalStatus?: EventApprovalStatus,
    @Query('status') status?: EventStatus,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    if (approvalStatus !== undefined && !Object.values(EventApprovalStatus).includes(approvalStatus)) {
      throw new BadRequestException('Invalid approvalStatus');
    }
    if (status !== undefined && !Object.values(EventStatus).includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    return await this.eventsService.findAllForAdmin({ approvalStatus, status, page, limit });
  }

  @Get('my-events')
  async findMyEvents(@Request() req: Request & { user: JwtPayload }) {
    return await this.eventsService.findMyEvents(req.user.id);
  }

  @Get('my-waitlist')
  async findMyWaitlistEntries(@Request() req: Request & { user: JwtPayload }) {
    return await this.eventsService.findMyWaitlistEntries(req.user.id);
  }

  @Get('my-enrollments')
  async findMyEnrollments(@Request() req: Request & { user: JwtPayload }) {
    return await this.eventsService.findMyEnrollments(req.user.id);
  }

  @Get('my-favorites')
  async findMyFavorites(@Request() req: Request & { user: JwtPayload }) {
    return await this.eventsService.findMyFavorites(req.user.id);
  }

  // GET /events is @Public() (browsable without auth), so it can never see req.user — a
  // `following` query param there could never be scoped to a real requester. This is a
  // separate authenticated endpoint instead, matching the my-events/my-favorites shape.
  @Get('from-following')
  async findFromFollowing(
    @Request() req: Request & { user: JwtPayload },
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return await this.eventsService.findFromFollowing(req.user.id, page, limit);
  }

  // Backs OrganizerProfileScreen's event list — deliberately independent of whether the
  // viewer follows this organizer (unlike from-following above), since the whole point of
  // a profile page is to let someone decide whether to follow after seeing their events.
  @Public()
  @Get('by-organizer/:organizerId')
  async findPublicEventsByOrganizer(
    @Param('organizerId', ParseUUIDPipe) organizerId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return await this.eventsService.findPublicEventsByOrganizer(organizerId, page, limit);
  }

  @Public()
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user?: JwtPayload },
  ) {
    return await this.eventsService.findOneForViewer(id, req.user?.id, req.user?.roles ?? []);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateEventDto: UpdateEventDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.update(id, updateEventDto, req.user.id, req.user.roles);
  }

  // Admin approve event
  @Roles('admin')
  @AuditAction('event.approve', 'event')
  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.approve(id, req.user.id);
  }

  // Admin reject event
  @Roles('admin')
  @AuditAction('event.reject', 'event')
  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('rejectionReason') rejectionReason: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.reject(id, rejectionReason, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.remove(id, req.user.id, req.user.roles);
  }

  // Organizer/admin cancellation — a status flip (event stays visible as "cancelled"),
  // unlike remove() above which hard-blocks on active bookings. This is the actual
  // resolution path for "this event can no longer happen": attendees get notified and can
  // self-serve a refund, rather than needing a delete to somehow be forced through.
  @AuditAction('event.cancel', 'event')
  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string | undefined,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.cancelEvent(id, req.user.id, req.user.roles, reason);
  }

  // Nested ticket-type CRUD (organizer-only, own event). New tiers may be added at any
  // time; editing/removing a tier is blocked once it has sales.
  @Public()
  @Get(':id/ticket-types')
  async findTicketTypes(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user?: JwtPayload },
  ) {
    return await this.eventsService.findTicketTypes(id, req.user?.id, req.user?.roles ?? []);
  }

  @Post(':id/ticket-types')
  @HttpCode(HttpStatus.CREATED)
  async createTicketType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTicketTypeDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.createTicketType(id, dto, req.user.id, req.user.roles);
  }

  @Patch(':id/ticket-types/:ticketTypeId')
  async updateTicketType(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ticketTypeId', ParseUUIDPipe) ticketTypeId: string,
    @Body() dto: UpdateTicketTypeDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.updateTicketType(id, ticketTypeId, dto, req.user.id, req.user.roles);
  }

  @Delete(':id/ticket-types/:ticketTypeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTicketType(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ticketTypeId', ParseUUIDPipe) ticketTypeId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.removeTicketType(id, ticketTypeId, req.user.id, req.user.roles);
  }

  // Gallery media (organizer-only, own event). The cover image stays a plain field on the
  // event itself — this only covers the additional carousel images/videos shown after it.
  @Public()
  @Get(':id/media')
  async findMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user?: JwtPayload },
  ) {
    return await this.eventsService.findMedia(id, req.user?.id, req.user?.roles ?? []);
  }

  @Post(':id/media')
  @HttpCode(HttpStatus.CREATED)
  async addMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEventMediaDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.addMedia(id, dto, req.user.id, req.user.roles);
  }

  @Delete(':id/media/:mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.removeMedia(id, mediaId, req.user.id, req.user.roles);
  }

  // Deprecated: use POST /uploads/signed-url with purpose: "event-cover" instead
  // (see multipart.md §3.1). Kept as a thin forward — rather than a hard break — so any
  // in-flight client still gets a valid signed URL, now correctly organizer/admin-gated
  // instead of open to any authenticated user.
  @Post('upload-url')
  async getUploadUrl(
    @Body('contentType') contentType: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    // This route bypasses the CreateSignedUrlDto's @IsIn validation (no ValidationPipe
    // runs on a manually-built object), so the allow-list has to be re-checked here —
    // otherwise this deprecated path would silently defeat the restriction.
    const resolvedContentType = (contentType || 'image/jpeg') as AllowedUploadContentType;
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(resolvedContentType)) {
      throw new BadRequestException(`contentType must be one of: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(', ')}`);
    }

    return await this.uploadsService.createSignedUrl(
      { purpose: UploadPurpose.EVENT_COVER, contentType: resolvedContentType },
      req.user.id,
      req.user.roles,
    );
  }

  // Section 3e: enrollment visibility — ownership-based
  @Get(':id/enrollments')
  async getEnrollments(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.findEnrollments(id, req.user.id, req.user.roles);
  }

  // Section 5d: Search confirmed enrollments by participant name
  @Get(':id/enrollments/search')
  async searchEnrollments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('name') name: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.searchEnrollments(id, name, req.user.id, req.user.roles);
  }

  // Section 5c: check-in endpoint
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  async checkIn(
    @Body('ticketCode') ticketCode: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.checkIn(ticketCode, req.user.id, req.user.roles);
  }

  // Participant enrollment — tightly throttled to blunt scripted mass-enrollment/scalping.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post(':id/enroll')
  @HttpCode(HttpStatus.CREATED)
  async enroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() enrollDto: EnrollDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.enroll(id, req.user.id, enrollDto?.ticketTypeId, enrollDto?.quantity);
  }

  @Post(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addFavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.addFavorite(id, req.user.id);
  }

  @Delete(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.removeFavorite(id, req.user.id);
  }

  // Section 4e / Section 5: get a single enrollment by id (for TicketDetailsScreen)
  @Get('enrollments/:enrollmentId')
  async getEnrollmentById(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.findEnrollmentById(enrollmentId, req.user.id, req.user.roles);
  }

  // Participant-facing cancellation — frees the tier's capacity and auto-promotes the
  // next FIFO waitlist entry.
  @Patch('enrollments/:enrollmentId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelEnrollment(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.cancelEnrollment(enrollmentId, req.user.id, req.user.roles);
  }
}
