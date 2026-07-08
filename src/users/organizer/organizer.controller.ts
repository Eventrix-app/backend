import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { OrganizerService } from './organizer.service';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '../../auth/jwt.util';
import { Roles } from '../../common/decorators/roles.decorator';

@Roles('admin')
@ApiTags('organizers')
@Controller('organizers')
export class OrganizerController {
  constructor(private readonly organizerService: OrganizerService) {}

  @Get()
  async findAll() {
    return await this.organizerService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.organizerService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrganizerDto: UpdateOrganizerDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const organizer = await this.organizerService.findOne(id);
    if (!req.user.roles.includes('admin') && req.user.id !== organizer.userId) {
      throw new ForbiddenException('You can only update your own profile');
    }
    return await this.organizerService.update(id, updateOrganizerDto);
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const organizer = await this.organizerService.findOne(id);
    if (!req.user.roles.includes('admin') && req.user.id !== organizer.userId) {
      throw new ForbiddenException('You can only delete your own profile');
    }
    return await this.organizerService.remove(id);
  }
}
