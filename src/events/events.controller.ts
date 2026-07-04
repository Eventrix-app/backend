import {
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

import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) { }

  @Roles('admin', 'organizer')
  @Post()
  async create(
    @Body() createEventDto: CreateEventDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.createForUser(createEventDto, req.user.id, req.user.role);
  }

  @Public()
  @Get()
  async findAll(
    @Query('categoryId') categoryId?: string,
    @Query('isOnline') isOnline?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    const onlineFlag = isOnline === undefined ? undefined : isOnline === 'true';
    return await this.eventsService.findAllFiltered(categoryId, onlineFlag, page, limit);
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

  // Organizer view their events
  @Roles('organizer', 'admin')
  @Get('organizer/:organizerId')
  async findByOrganizer(@Param('organizerId') organizerId: string) {
    return await this.eventsService.findByOrganizerId(organizerId);
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.eventsService.findOne(id);
  }

  @Roles('admin', 'organizer')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateEventDto: UpdateEventDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.update(id, updateEventDto, req.user.id, req.user.role);
  }

  // Admin approve event
  @Roles('admin')
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
  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('rejectionReason') rejectionReason: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.reject(id, rejectionReason, req.user.id);
  }

  @Roles('admin', 'organizer')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.remove(id, req.user.id, req.user.role);
  }

  // Participant enrollment
  @Roles('user', 'admin', 'organizer')
  @Post(':id/enroll')
  @HttpCode(HttpStatus.CREATED)
  async enroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.enroll(id, req.user.id);
  }
}
