import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { JwtPayload } from '../auth/jwt.util';
import { ScheduleService } from './schedule.service';
import { CreateScheduleItemDto, UpdateScheduleItemDto } from './dto/schedule-item.dto';

@ApiTags('event-schedule')
@Controller('events/:eventId/schedule')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Public()
  @Get()
  async findAll(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.scheduleService.findAll(eventId);
  }

  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateScheduleItemDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.scheduleService.create(eventId, dto, req.user.id, req.user.roles);
  }

  @Patch(':itemId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateScheduleItemDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.scheduleService.update(eventId, itemId, dto, req.user.id, req.user.roles);
  }

  @Delete(':itemId')
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.scheduleService.remove(eventId, itemId, req.user.id, req.user.roles);
    return { message: 'Schedule item deleted' };
  }
}
