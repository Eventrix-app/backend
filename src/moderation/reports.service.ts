import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Report, ReportStatus, ReportTargetType } from '../entities/report.entity';
import { User } from '../entities/user.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { EventReview } from '../entities/event-review.entity';
import { CreateReportDto } from './dto/create-report.dto';

export interface ReportRecord {
  id: string;
  reporterId: string;
  reporter?: { id: string; fullName: string; email: string };
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  status: ReportStatus;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  createdAt: Date;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(Report)
    private readonly reportsRepository: Repository<Report>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ChatMessage)
    private readonly chatMessagesRepository: Repository<ChatMessage>,
    @InjectRepository(EventReview)
    private readonly reviewsRepository: Repository<EventReview>,
  ) {}

  private mapToRecord(report: Report): ReportRecord {
    return {
      id: report.id,
      reporterId: report.reporterId,
      reporter: report.reporter
        ? { id: report.reporter.id, fullName: report.reporter.fullName, email: report.reporter.email }
        : undefined,
      targetType: report.targetType,
      targetId: report.targetId,
      reason: report.reason,
      status: report.status,
      reviewedBy: report.reviewedBy,
      reviewedAt: report.reviewedAt,
      createdAt: report.createdAt,
    };
  }

  async create(reporterId: string, dto: CreateReportDto): Promise<ReportRecord> {
    if (dto.targetType === ReportTargetType.USER && dto.targetId === reporterId) {
      throw new BadRequestException('You cannot report yourself');
    }

    const exists = await this.targetExists(dto.targetType, dto.targetId);
    if (!exists) {
      throw new NotFoundException(`${dto.targetType} ${dto.targetId} not found`);
    }

    const report = this.reportsRepository.create({
      reporterId,
      targetType: dto.targetType,
      targetId: dto.targetId,
      reason: dto.reason,
    });
    const saved = await this.reportsRepository.save(report);
    this.logger.log(`Report ${saved.id} created: ${dto.targetType} ${dto.targetId} by user ${reporterId}`);
    return this.mapToRecord(saved);
  }

  private async targetExists(targetType: ReportTargetType, targetId: string): Promise<boolean> {
    switch (targetType) {
      case ReportTargetType.USER:
        return this.usersRepository.exists({ where: { id: targetId } });
      case ReportTargetType.CHAT_MESSAGE:
        return this.chatMessagesRepository.exists({ where: { id: targetId } });
      case ReportTargetType.REVIEW:
        return this.reviewsRepository.exists({ where: { id: targetId } });
      default:
        return false;
    }
  }

  async findAllForAdmin(
    status?: ReportStatus,
    page: number = 1,
    limit: number = 50,
  ): Promise<{ reports: ReportRecord[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [reports, total] = await this.reportsRepository.findAndCount({
      where: status ? { status } : {},
      relations: ['reporter'],
      // Full User relation must never be selected wholesale (passwordHash, etc.) — see the
      // same pattern in reviews.service.ts/announcements.service.ts.
      select: { reporter: { id: true, fullName: true, email: true } },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      reports: reports.map((r) => this.mapToRecord(r)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async dismiss(id: string, adminId: string): Promise<ReportRecord> {
    const report = await this.findPendingOrFail(id);
    report.status = ReportStatus.DISMISSED;
    report.reviewedBy = adminId;
    report.reviewedAt = new Date();
    const saved = await this.reportsRepository.save(report);
    this.logger.log(`Report ${id} dismissed by admin ${adminId}`);
    return this.mapToRecord(saved);
  }

  // Upholds the report: for content (chat_message/review) this removes the offending
  // content outright — a report an admin has decided is valid shouldn't sit "actioned"
  // while the content stays visible to everyone else. For a reported *user*, no
  // automatic action is taken here — banning is a separate, deliberate admin decision via
  // the existing PATCH /admins/users/:userId/ban, not something a single report should
  // silently trigger.
  async action(id: string, adminId: string): Promise<ReportRecord> {
    const report = await this.findPendingOrFail(id);

    if (report.targetType === ReportTargetType.CHAT_MESSAGE) {
      await this.chatMessagesRepository.delete({ id: report.targetId });
    } else if (report.targetType === ReportTargetType.REVIEW) {
      await this.reviewsRepository.delete({ id: report.targetId });
    }

    report.status = ReportStatus.ACTIONED;
    report.reviewedBy = adminId;
    report.reviewedAt = new Date();
    const saved = await this.reportsRepository.save(report);
    this.logger.log(`Report ${id} actioned by admin ${adminId} (${report.targetType} ${report.targetId})`);
    return this.mapToRecord(saved);
  }

  private async findPendingOrFail(id: string): Promise<Report> {
    const report = await this.reportsRepository.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException(`Report ${id} not found`);
    }
    if (report.status !== ReportStatus.PENDING) {
      throw new BadRequestException(`Report ${id} has already been reviewed`);
    }
    return report;
  }
}
