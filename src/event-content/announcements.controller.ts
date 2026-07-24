import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { JwtPayload } from '../auth/jwt.util';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto';

@ApiTags('event-announcements')
@Controller('events/:eventId/announcements')
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Public()
  @Get()
  async findAll(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.announcementsService.findAll(eventId);
  }

  // Every announcement fans out to (and push-notifies, see AnnouncementsService) every
  // attendee of the event — unlike enroll's per-scalper-account throttle, this bounds how
  // much any one organizer can broadcast to their own attendee list.
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateAnnouncementDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.announcementsService.create(eventId, dto, req.user.id, req.user.roles);
  }

  @Patch(':announcementId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('announcementId', ParseUUIDPipe) announcementId: string,
    @Body() dto: UpdateAnnouncementDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.announcementsService.update(eventId, announcementId, dto, req.user.id, req.user.roles);
  }

  @Delete(':announcementId')
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('announcementId', ParseUUIDPipe) announcementId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.announcementsService.remove(eventId, announcementId, req.user.id, req.user.roles);
    return { message: 'Announcement deleted' };
  }
}
