import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationJob, NotificationJobStatus, NotificationType } from '../entities/notification-job.entity';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(NotificationJob)
    private readonly notificationJobsRepository: Repository<NotificationJob>,
  ) {}

  // No push/email transport is wired up yet (Phase 2 item) — jobs are persisted for
  // auditability/replay and "delivered" by logging, then marked sent immediately.
  async enqueue(userId: string, type: NotificationType, payload: Record<string, unknown>): Promise<NotificationJob> {
    const job = this.notificationJobsRepository.create({ userId, type, payload, status: NotificationJobStatus.PENDING });
    const saved = await this.notificationJobsRepository.save(job);

    saved.status = NotificationJobStatus.SENT;
    saved.sentAt = new Date();
    await this.notificationJobsRepository.save(saved);

    this.logger.log(`Notification [${type}] delivered to user ${userId}: ${JSON.stringify(payload)}`);
    return saved;
  }

  async notifyEventChanged(
    eventId: string,
    userIds: string[],
    changes: Record<string, { from: unknown; to: unknown }>,
  ): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.enqueue(userId, NotificationType.EVENT_CHANGED, { eventId, changes })),
    );
  }

  async notifyWaitlistPromoted(userId: string, eventId: string, enrollmentId: string): Promise<void> {
    await this.enqueue(userId, NotificationType.WAITLIST_PROMOTED, { eventId, enrollmentId });
  }

  async notifyRefundStatus(userId: string, refundId: string, status: string): Promise<void> {
    await this.enqueue(userId, NotificationType.REFUND_STATUS, { refundId, status });
  }
}
