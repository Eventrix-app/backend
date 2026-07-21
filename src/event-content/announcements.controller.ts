import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { JwtPayload } from '../auth/jwt.util';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto } from './dto/announcement.dto';

@ApiTags('event-announcements')
@Controller('events/:eventId/announcements')
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Public()
  @Get()
  async findAll(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.announcementsService.findAll(eventId);
  }

  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateAnnouncementDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.announcementsService.create(eventId, dto, req.user.id, req.user.roles);
  }
}
