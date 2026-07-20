import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NotificationJob, NotificationJobStatus, NotificationType } from '../entities/notification-job.entity';
import { User } from '../entities/user.entity';
import { EmailService } from '../email/email.service';
import { PushService } from '../push/push.service';

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
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly emailService: EmailService,
    private readonly pushService: PushService,
  ) {}

  // Every job fires both an email and a push using the same title/body this generates
  // for the in-app notifications list — the persist-then-mark-sent shape above stays the
  // audit trail regardless of whether either transport actually reaches the user. Both
  // sends are fire-and-forget on purpose: neither EmailService.send() nor PushService.send()
  // ever throws, but even a hypothetical failure here must never fail the job itself,
  // since callers (e.g. PaymentsService.approveRefund) await enqueue() as part of a larger
  // state transition that has already committed.
  async enqueue(userId: string, type: NotificationType, payload: Record<string, unknown>): Promise<NotificationJob> {
    const job = this.notificationJobsRepository.create({ userId, type, payload, status: NotificationJobStatus.PENDING });
    const saved = await this.notificationJobsRepository.save(job);

    saved.status = NotificationJobStatus.SENT;
    saved.sentAt = new Date();
    await this.notificationJobsRepository.save(saved);

    this.logger.log(`Notification [${type}] delivered to user ${userId}: ${JSON.stringify(payload)}`);

    const user = await this.usersRepository.findOne({ where: { id: userId } });
    await Promise.all([
      this.sendEmailForJob(user, type, payload),
      this.sendPushForJob(user, type, payload),
    ]);

    return saved;
  }

  private async sendEmailForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user?.email) return;
      const { title, body } = this.describe(type, payload);
      await this.emailService.send(user.email, title, `<p>${body}</p>`);
    } catch (err) {
      this.logger.warn(`Failed to email notification [${type}] to user ${user?.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendPushForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user?.pushToken) return;
      const { title, body } = this.describe(type, payload);
      // type is included alongside the raw payload so the app's notification-tap handler
      // can deep-link (EventDetails/Bookings/TicketDetails) without re-deriving it from
      // title/body text.
      await this.pushService.send(user.pushToken, title, body, { type, ...payload });
    } catch (err) {
      this.logger.warn(`Failed to push notification [${type}] to user ${user?.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // enrollmentId rides along so the frontend's push-tap handler can deep-link straight to
  // TicketDetailsScreen (which needs a bookingId/enrollmentId, not a refundId) instead of
  // only being able to fall back to the general Bookings list.
  async notifyRefundStatus(userId: string, refundId: string, status: string, enrollmentId: string): Promise<void> {
    await this.enqueue(userId, NotificationType.REFUND_STATUS, { refundId, status, enrollmentId });
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
