import {
  Body,
  Controller,
  Delete,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { CreateParticipantDto } from './dto/create-participant.dto';
import { UpdateParticipantDto } from './dto/update-participant.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '../../auth/jwt.util';
import { ParseLimitIntPipe, ParsePageIntPipe } from '../../common/pipes/pagination.pipe';
import { Throttle } from '@nestjs/throttler';

@Roles('admin')
@ApiTags('participants')
@Controller('participants')
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) {}

  // Functionally identical to /auth/register — same anti-abuse limit as AuthController's
  // own registration endpoint (@Throttle) instead of just the app-wide default, which was
  // never actually tightened for this second registration path.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  async create(@Body() createParticipantDto: CreateParticipantDto) {
    return await this.participantService.create(createParticipantDto);
  }

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParsePageIntPipe()) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseLimitIntPipe()) limit?: number,
  ) {
    return await this.participantService.findAll(page, limit);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.participantService.findOne(id);
  }

  @Roles('admin', 'user')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateParticipantDto: UpdateParticipantDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    if (!req.user.roles.includes('admin') && req.user.id !== id) {
      throw new ForbiddenException('You can only update your own profile');
    }
    return await this.participantService.update(id, updateParticipantDto);
  }

  @Roles('admin', 'user')
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    if (!req.user.roles.includes('admin') && req.user.id !== id) {
      throw new ForbiddenException('You can only delete your own profile');
    }
    return await this.participantService.remove(id);
  }
}
