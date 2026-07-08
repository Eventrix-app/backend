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
import { createClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';

import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly configService: ConfigService,
  ) { }

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

  @Get('my-events')
  async findMyEvents(@Request() req: Request & { user: JwtPayload }) {
    return await this.eventsService.findMyEvents(req.user.id);
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.eventsService.findOne(id);
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.eventsService.remove(id, req.user.id, req.user.roles);
  }

  // Section 3f: presigned upload URL for cover image
  @Post('upload-url')
  async getUploadUrl(
    @Body('fileName') fileName: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const supabase = createClient(
      this.configService.get<string>('SUPABASE_URL') ?? '',
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const path = `events/${req.user.id}/${Date.now()}-${fileName}`;
    const { data, error } = await supabase.storage
      .from('event-images')
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { signedUrl: data.signedUrl, path, token: data.token };
  }

  // Section 3e: enrollment visibility — ownership-based
  @Get(':id/enrollments')
  async getEnrollments(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.findEnrollments(id, req.user.id, req.user.roles);
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

  // Participant enrollment
  @Post(':id/enroll')
  @HttpCode(HttpStatus.CREATED)
  async enroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.eventsService.enroll(id, req.user.id);
  }

  // Section 4e / Section 5: get a single enrollment by id (for TicketDetailsScreen)
  @Get('enrollments/:enrollmentId')
  async getEnrollmentById(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return this.eventsService.findEnrollmentById(enrollmentId, req.user.id, req.user.roles);
  }
}
