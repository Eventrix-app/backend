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
  ForbiddenException,
} from '@nestjs/common';
import { OrganizerService } from './organizer.service';
import { CreateOrganizerDto } from './dto/create-organizer.dto';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { JwtPayload } from '../../auth/jwt.util';

@Roles('admin')
@ApiTags('organizers')
@Controller('organizers')
export class OrganizerController {
  constructor(private readonly organizerService: OrganizerService) {}

  @Public()
  @Post()
  async create(@Body() createOrganizerDto: CreateOrganizerDto) {
    return await this.organizerService.create(createOrganizerDto);
  }

  @Get()
  async findAll() {
    return await this.organizerService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.organizerService.findOne(id);
  }

  @Roles('admin', 'organizer')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrganizerDto: UpdateOrganizerDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const organizer = await this.organizerService.findOne(id);
    if (req.user.role !== 'admin' && req.user.id !== organizer.userId) {
      throw new ForbiddenException('You can only update your own profile');
    }
    return await this.organizerService.update(id, updateOrganizerDto);
  }

  @Roles('admin', 'organizer')
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const organizer = await this.organizerService.findOne(id);
    if (req.user.role !== 'admin' && req.user.id !== organizer.userId) {
      throw new ForbiddenException('You can only delete your own profile');
    }
    return await this.organizerService.remove(id);
  }
}
