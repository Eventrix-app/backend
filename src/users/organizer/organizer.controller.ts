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
import { OrganizerService } from './organizer.service';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { SubmitVerificationDto, RejectVerificationDto } from './dto/submit-verification.dto';
import { ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '../../auth/jwt.util';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditAction } from '../../common/decorators/audit-action.decorator';
import { ParseLimitIntPipe, ParsePageIntPipe } from '../../common/pipes/pagination.pipe';

const ADMIN_ONLY_FIELDS = ['commissionRate', 'commissionFlatFee', 'verificationLevel', 'autoApproveEvents'] as const;

@Roles('admin')
@ApiTags('organizers')
@Controller('organizers')
export class OrganizerController {
  constructor(private readonly organizerService: OrganizerService) {}

  @Get()
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParsePageIntPipe()) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseLimitIntPipe()) limit?: number,
  ) {
    return await this.organizerService.findAll(page, limit);
  }

  // Static-path routes must come before the bare `:id` route below — Nest/Express match
  // in declaration order, so `GET /organizers/my-following` would otherwise be swallowed
  // by `:id` first (and 400 on ParseUUIDPipe, since "my-following" isn't a UUID).
  @Roles()
  @Get('my-following')
  async findMyFollowing(@Request() req: Request & { user: JwtPayload }) {
    return await this.organizerService.getMyFollowing(req.user.id);
  }

  // --- KYC verification (#7) — static paths, must stay above the bare `:id` route below ---

  @Roles()
  @Get('verification/me')
  async getMyVerificationStatus(@Request() req: Request & { user: JwtPayload }) {
    return await this.organizerService.getMyVerificationStatus(req.user.id);
  }

  @Roles()
  @Post('verification')
  async submitVerification(
    @Body() dto: SubmitVerificationDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.organizerService.submitVerification(req.user.id, dto);
  }

  @Get('verification/pending')
  async getPendingVerifications() {
    return await this.organizerService.getPendingVerifications();
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.organizerService.findOne(id);
  }

  // Public-safe profile — deliberately a different endpoint/shape from findOne() above,
  // which returns PII (email, phone) and business-sensitive fields (commission, auto-
  // approve) meant for admins/the organizer themselves only. Any authenticated user can
  // view this one; req.user is always present here since the class isn't @Public().
  @Roles()
  @Get(':id/profile')
  async getPublicProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.organizerService.getPublicProfile(id, req.user.id);
  }

  @Roles()
  @Post(':id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  async follow(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.organizerService.follow(id, req.user.id);
  }

  @Roles()
  @Delete(':id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unfollow(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.organizerService.unfollow(id, req.user.id);
  }

  @Get(':id/verification/documents')
  async getVerificationDocuments(@Param('id', ParseUUIDPipe) id: string) {
    return await this.organizerService.getVerificationDocuments(id);
  }

  @AuditAction('organizer.verification.approve', 'organizer')
  @Post(':id/verification/approve')
  async approveVerification(@Param('id', ParseUUIDPipe) id: string) {
    return await this.organizerService.approveVerification(id);
  }

  @AuditAction('organizer.verification.reject', 'organizer')
  @Post(':id/verification/reject')
  async rejectVerification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return await this.organizerService.rejectVerification(id, dto.reason);
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
