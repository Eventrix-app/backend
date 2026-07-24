import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportStatus } from '../entities/report.entity';
import { JwtPayload } from '../auth/jwt.util';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Any authenticated user can report — no role restriction. Throttled tighter than the
  // app-wide default to make a report-spam nuisance attack (flooding the moderation queue)
  // more costly than filing one genuine report.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  async create(@Body() dto: CreateReportDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.reportsService.create(req.user.id, dto);
  }

  @Roles('admin')
  @Get()
  async findAll(
    @Query('status') status?: ReportStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (status !== undefined && !Object.values(ReportStatus).includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    return await this.reportsService.findAllForAdmin(
      status,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Roles('admin')
  @AuditAction('report.dismiss', 'report')
  @Patch(':id/dismiss')
  async dismiss(@Param('id', ParseUUIDPipe) id: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.reportsService.dismiss(id, req.user.id);
  }

  @Roles('admin')
  @AuditAction('report.action', 'report')
  @Patch(':id/action')
  async action(@Param('id', ParseUUIDPipe) id: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.reportsService.action(id, req.user.id);
  }
}
