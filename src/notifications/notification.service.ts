import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NotificationJob, NotificationJobStatus, NotificationType } from '../entities/notification-job.entity';

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
}

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

  // ---------------------------------------------------------------------
  // Read-side for NotificationsScreen — lists the same jobs enqueue() persists,
  // rendered with a human-readable title/body derived from type + payload.
  // ---------------------------------------------------------------------
  async findMyNotifications(userId: string): Promise<NotificationRecord[]> {
    const jobs = await this.notificationJobsRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return jobs.map((job) => this.toRecord(job));
  }

  async markRead(id: string, userId: string): Promise<void> {
    const result = await this.notificationJobsRepository.update({ id, userId }, { readAt: new Date() });
    if (result.affected === 0) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notificationJobsRepository.update({ userId, readAt: IsNull() }, { readAt: new Date() });
  }

  private toRecord(job: NotificationJob): NotificationRecord {
    const { title, body } = this.describe(job.type, job.payload ?? {});
    return {
      id: job.id,
      type: job.type,
      title,
      body,
      createdAt: job.createdAt,
      readAt: job.readAt ?? null,
    };
  }

  private describe(type: NotificationType, payload: Record<string, unknown>): { title: string; body: string } {
    switch (type) {
      case NotificationType.EVENT_CHANGED:
        return { title: 'Event updated', body: 'An event you booked has changed — check the details.' };
      case NotificationType.WAITLIST_PROMOTED:
        return { title: "You're in!", body: "A spot opened up and you've been moved off the waitlist." };
      case NotificationType.REFUND_STATUS: {
        const status = String(payload['status'] ?? 'updated');
        return { title: 'Refund update', body: `Your refund is now "${status}".` };
      }
      default:
        return { title: 'Notification', body: '' };
    }
  }
}
