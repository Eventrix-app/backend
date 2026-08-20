import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Report, ReportStatus, ReportTargetType } from '../entities/report.entity';
import { User } from '../entities/user.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { EventReview } from '../entities/event-review.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { NotificationService } from '../notifications/notification.service';

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
  // Resolved from targetId for the admin queue. targetId alone answers none of the
  // questions a reviewer actually has: for a chat_message or review it is the content's
  // id, so it identifies neither the person being reported nor what they said. Both are
  // looked up here rather than denormalised onto the row, so a later rename or edit is
  // reflected instead of frozen at report time.
  reportedUser?: { id: string; fullName: string; email: string };
  // The reported content itself — the chat message body, or the review text. Undefined for
  // targetType 'user', where the report is about the account rather than one thing said.
  targetContent?: string;
  // When the reported content was posted, which is not the same as when it was reported.
  targetCreatedAt?: Date;
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
    private readonly notificationService: NotificationService,
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
    // A report is only useful if someone sees it: findAllForAdmin() is a pull queue nobody
    // is obliged to open, so push it to the dashboard bell too. Fire-and-forget — the report
    // is already saved and the reporter's request must not fail over a notification.
    void this.notifyAdminsOfReport(saved.id, reporterId, dto);
    return this.mapToRecord(saved);
  }

  private async notifyAdminsOfReport(reportId: string, reporterId: string, dto: CreateReportDto): Promise<void> {
    try {
      const reporter = await this.usersRepository.findOne({ where: { id: reporterId }, select: ['fullName'] });
      await this.notificationService.notifyAdminsUserReported(
        reportId,
        dto.targetType,
        dto.targetId,
        reporter?.fullName ?? 'Someone',
        dto.reason,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to notify admins of report ${reportId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      reports: await this.enrichTargets(reports.map((r) => this.mapToRecord(r))),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Resolves each report's target into the person and the content it refers to.
   *
   * Batched per target type rather than per report: an admin queue of 50 rows would
   * otherwise issue 100+ round trips, and reports arrive in bursts when one account
   * misbehaves, so the same message and the same user repeat across rows.
   *
   * A target that no longer exists is left unresolved rather than failing the whole list —
   * content gets deleted, including by the action() path below, and a report about deleted
   * content is still a record an admin needs to see.
   */
  private async enrichTargets(records: ReportRecord[]): Promise<ReportRecord[]> {
    const idsBy = (type: ReportTargetType) =>
      [...new Set(records.filter((r) => r.targetType === type).map((r) => r.targetId))];

    const [messages, reviews, users] = await Promise.all([
      this.loadBy(this.chatMessagesRepository, idsBy(ReportTargetType.CHAT_MESSAGE)),
      this.loadBy(this.reviewsRepository, idsBy(ReportTargetType.REVIEW)),
      this.loadBy(this.usersRepository, idsBy(ReportTargetType.USER)),
    ]);

    const asPerson = (u?: User) =>
      u ? { id: u.id, fullName: u.fullName, email: u.email } : undefined;

    return records.map((r) => {
      if (r.targetType === ReportTargetType.CHAT_MESSAGE) {
        const m = messages.get(r.targetId);
        return m
          ? { ...r, reportedUser: asPerson(m.user), targetContent: m.message, targetCreatedAt: m.createdAt }
          : r;
      }
      if (r.targetType === ReportTargetType.REVIEW) {
        const v = reviews.get(r.targetId);
        return v
          ? { ...r, reportedUser: asPerson(v.user), targetContent: v.text ?? '', targetCreatedAt: v.createdAt }
          : r;
      }
      const u = users.get(r.targetId);
      return u ? { ...r, reportedUser: asPerson(u) } : r;
    });
  }

  // `user` is joined for content targets so the reported author comes back with it; for a
  // USER target the row *is* the person, so the relation list is empty.
  private async loadBy<T extends { id: string }>(
    repo: Repository<T>,
    ids: string[],
  ): Promise<Map<string, T>> {
    if (ids.length === 0) return new Map();
    const rows = await repo.find({
      where: { id: In(ids) } as never,
      relations: repo.metadata.relations.some((rel) => rel.propertyName === 'user') ? ['user'] : [],
    });
    return new Map(rows.map((row) => [row.id, row]));
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
