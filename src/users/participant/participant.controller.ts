import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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

@Roles('admin')
@ApiTags('participants')
@Controller('participants')
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) {}

  @Public()
  @Post()
  async create(@Body() createParticipantDto: CreateParticipantDto) {
    return await this.participantService.create(createParticipantDto);
  }

  @Get()
  async findAll() {
    return await this.participantService.findAll();
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
