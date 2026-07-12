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
import { AuditAction } from '../../common/decorators/audit-action.decorator';

const ADMIN_ONLY_FIELDS = ['commissionRate', 'commissionFlatFee', 'verificationLevel', 'autoApproveEvents'] as const;

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

  // RolesGuard checks method-level metadata before falling back to the class-level
  // @Roles('admin') above — without this override, a non-admin organizer could never
  // reach the ownership check below at all (they'd 403 at the guard first), making
  // "self-service" impossible despite the check existing in the handler body.
  @AuditAction('organizer.update', 'organizer')
  @Roles('admin', 'organizer')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrganizerDto: UpdateOrganizerDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const organizer = await this.organizerService.findOne(id);
    const isAdmin = req.user.roles.includes('admin');
    if (!isAdmin && req.user.id !== organizer.userId) {
      throw new ForbiddenException('You can only update your own profile');
    }
    if (!isAdmin && ADMIN_ONLY_FIELDS.some((field) => updateOrganizerDto[field] !== undefined)) {
      throw new ForbiddenException('Only an admin can change commission rate or verification settings');
    }
    return await this.organizerService.update(id, updateOrganizerDto);
  }

  @AuditAction('organizer.remove', 'organizer')
  @Roles('admin', 'organizer')
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
