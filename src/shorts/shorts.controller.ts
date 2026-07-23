import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShortsService } from './shorts.service';
import { RemoveShortDto } from './dto/remove-short.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';
import { ShortModerationStatus } from '../entities/short.entity';

// Admin-only moderation surface — no creator-facing endpoints yet (no real upload flow
// exists anywhere in the app to feed one). See Short entity's own comment for scope.
@Roles('admin')
@ApiTags('shorts')
@Controller('shorts')
export class ShortsController {
  constructor(private readonly shortsService: ShortsService) {}

  @Get('admin')
  async findAllForAdmin(
    @Query('moderationStatus') moderationStatus?: ShortModerationStatus,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return await this.shortsService.findAllForAdmin({ moderationStatus, page, limit });
  }

  @AuditAction('short.approve', 'short')
  @Patch(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string) {
    return await this.shortsService.approve(id);
  }

  @AuditAction('short.remove', 'short')
  @Patch(':id/remove')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RemoveShortDto) {
    return await this.shortsService.remove(id, dto.reason);
  }
}
