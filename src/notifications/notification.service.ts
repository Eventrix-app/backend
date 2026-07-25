import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NotificationJob, NotificationJobStatus, NotificationType } from '../entities/notification-job.entity';
import { User } from '../entities/user.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { EmailService } from '../email/email.service';
import { PushService } from '../push/push.service';
import {
  announcementEmail,
  bookingConfirmedEmail,
  eventApprovedEmail,
  eventCancelledEmail,
  eventChangedEmail,
  eventRejectedEmail,
  organizerFollowedEmail,
  organizerVerificationApprovedEmail,
  organizerVerificationRejectedEmail,
  refundStatusEmail,
  RenderedEmail,
  waitlistPromotedEmail,
} from '../email/templates';

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
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
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
  async enqueue(userId: string, type: NotificationType, payload: Record<string, unknown>): Promise<NotificationJob | undefined> {
    try {
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
    } catch (err) {
      // Must never fail the caller's already-committed operation (event approval, booking
      // confirmation, etc.) — a DB hiccup while queuing a notification should be logged and
      // swallowed here, not left to reject and potentially crash the process via an
      // unhandled rejection at a `void enqueue(...)` call site.
      this.logger.error(`Failed to enqueue notification [${type}] for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async sendEmailForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user?.email || user.emailEnabled === false) return;
      const { subject, html } = this.describeEmail(type, payload);
      await this.emailService.send(user.email, subject, html);
    } catch (err) {
      this.logger.warn(`Failed to email notification [${type}] to user ${user?.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendPushForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user || user.pushEnabled === false) return;
      const devices = await this.deviceTokenRepository.find({ where: { userId: user.id } });
      if (devices.length === 0) return;
      const { title, body } = this.describe(type, payload);
      // type is included alongside the raw payload so the app's notification-tap handler
      // can deep-link (EventDetails/Bookings/TicketDetails) without re-deriving it from
      // title/body text. Fanned out to every registered device (not just one) — a user
      // signed in on two phones expects a push on both, not just whichever logged in most
      // recently. PushService.send() never rejects (it catches internally), so one dead/
      // uninstalled device's token can't suppress delivery to the rest.
      await Promise.all(devices.map((d) => this.pushService.send(d.token, title, body, { type, ...payload })));
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

  async notifyAnnouncement(userIds: string[], eventId: string, announcementId: string, title: string): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.enqueue(userId, NotificationType.ANNOUNCEMENT, { eventId, announcementId, title })),
    );
  }

  async notifyOrganizerFollowed(organizerUserId: string, followerUserId: string, followerName: string): Promise<void> {
    await this.enqueue(organizerUserId, NotificationType.ORGANIZER_FOLLOWED, { followerUserId, followerName });
  }

  // eventId rides along so the frontend's push-tap handler can deep-link straight to
  // EventDetailsScreen instead of only being able to fall back to a generic notification.
  async notifyEventApproved(userId: string, eventId: string, eventTitle: string): Promise<void> {
    await this.enqueue(userId, NotificationType.EVENT_APPROVED, { eventId, eventTitle });
  }

  async notifyEventRejected(userId: string, eventId: string, eventTitle: string, reason: string): Promise<void> {
    await this.enqueue(userId, NotificationType.EVENT_REJECTED, { eventId, eventTitle, reason });
  }

  async notifyOrganizerVerificationApproved(userId: string): Promise<void> {
    await this.enqueue(userId, NotificationType.ORGANIZER_VERIFICATION_APPROVED, {});
  }

  async notifyOrganizerVerificationRejected(userId: string, reason: string): Promise<void> {
    await this.enqueue(userId, NotificationType.ORGANIZER_VERIFICATION_REJECTED, { reason });
  }

  // Fired once a booking is actually paid-and-confirmed — immediately for free events
  // (EventsService.enroll(), paymentStatus is 'paid' right away), or from the payment
  // webhook for paid events (PaymentsService.handleWebhook(), on gateway success). Never
  // fired for a paid enrollment still awaiting payment — that would tell someone they're
  // "confirmed" for a booking they haven't actually paid for yet.
  // Fired for every active (confirmed/pending) attendee when an organizer/admin cancels an
  // event outright — distinct from notifyEventChanged, which is for logistics edits
  // (date/time/venue) to an event that's still happening.
  async notifyEventCancelled(userIds: string[], eventId: string, eventTitle: string, reason?: string): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.enqueue(userId, NotificationType.EVENT_CANCELLED, { eventId, eventTitle, reason })),
    );
  }

  async notifyBookingConfirmed(
    userId: string,
    eventId: string,
    enrollmentId: string,
    eventTitle: string,
    bookingReference: string,
    quantity: number,
  ): Promise<void> {
    await this.enqueue(userId, NotificationType.BOOKING_CONFIRMED, {
      eventId,
      enrollmentId,
      eventTitle,
      bookingReference,
      quantity,
    });
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
        if (status === 'requested') {
          return {
            title: 'Refund request received',
            body: "We've received your refund request and will review it shortly.",
          };
        }
        return { title: 'Refund update', body: `Your refund is now "${status}".` };
      }
      case NotificationType.ANNOUNCEMENT: {
        const title = String(payload['title'] ?? 'New announcement');
        return { title: 'Event announcement', body: title };
      }
      case NotificationType.ORGANIZER_FOLLOWED: {
        const followerName = String(payload['followerName'] ?? 'Someone');
        return { title: 'New follower', body: `${followerName} started following you.` };
      }
      case NotificationType.EVENT_CANCELLED: {
        const eventTitle = String(payload['eventTitle'] ?? 'An event you booked');
        const reason = payload['reason'] ? ` Reason: ${String(payload['reason'])}.` : '';
        return {
          title: 'Event cancelled',
          body: `${eventTitle} has been cancelled.${reason} If you paid for this booking, request a refund from My Bookings in the app.`,
        };
      }
      case NotificationType.EVENT_APPROVED: {
        const eventTitle = String(payload['eventTitle'] ?? 'Your event');
        return { title: "You're live!", body: `${eventTitle} has been approved and is now visible to everyone.` };
      }
      case NotificationType.EVENT_REJECTED: {
        const eventTitle = String(payload['eventTitle'] ?? 'Your event');
        const reason = payload['reason'] ? ` ${String(payload['reason'])}` : '';
        return { title: 'Your event needs another look', body: `${eventTitle} wasn't approved this time.${reason}` };
      }
      case NotificationType.ORGANIZER_VERIFICATION_APPROVED:
        return {
          title: "You're verified!",
          body: 'Your organizer verification was approved — you can now create and publish events.',
        };
      case NotificationType.ORGANIZER_VERIFICATION_REJECTED: {
        const reason = String(payload['reason'] ?? '');
        return {
          title: 'Verification needs another look',
          body: `Your organizer verification wasn't approved. ${reason} You can update your details and resubmit.`,
        };
      }
      case NotificationType.BOOKING_CONFIRMED: {
        const eventTitle = String(payload['eventTitle'] ?? 'your event');
        const bookingReference = String(payload['bookingReference'] ?? '');
        const quantity = Number(payload['quantity'] ?? 1);
        return {
          title: 'Booking confirmed!',
          body: `You're confirmed for ${eventTitle} (${quantity} ticket${quantity === 1 ? '' : 's'}). Booking reference: ${bookingReference}. View your ticket in the app.`,
        };
      }
      default:
        return { title: 'Notification', body: '' };
    }
  }

  // Mirrors describe() one purpose at a time, but through templates.ts's branded HTML
  // (header/footer chrome) rather than the in-app list's plain title/body pair.
  private describeEmail(type: NotificationType, payload: Record<string, unknown>): RenderedEmail {
    switch (type) {
      case NotificationType.EVENT_CHANGED:
        return eventChangedEmail(payload['eventId'] ? String(payload['eventId']) : undefined);
      case NotificationType.WAITLIST_PROMOTED:
        return waitlistPromotedEmail(payload['enrollmentId'] ? String(payload['enrollmentId']) : undefined);
      case NotificationType.REFUND_STATUS:
        return refundStatusEmail(
          String(payload['status'] ?? 'updated'),
          payload['enrollmentId'] ? String(payload['enrollmentId']) : undefined,
        );
      case NotificationType.ANNOUNCEMENT:
        return announcementEmail(
          String(payload['title'] ?? 'New announcement'),
          payload['eventId'] ? String(payload['eventId']) : undefined,
        );
      case NotificationType.ORGANIZER_FOLLOWED:
        return organizerFollowedEmail(String(payload['followerName'] ?? 'Someone'));
      case NotificationType.EVENT_CANCELLED:
        return eventCancelledEmail(
          String(payload['eventTitle'] ?? 'An event you booked'),
          payload['reason'] ? String(payload['reason']) : undefined,
          payload['eventId'] ? String(payload['eventId']) : undefined,
        );
      case NotificationType.EVENT_APPROVED:
        return eventApprovedEmail(
          String(payload['eventTitle'] ?? 'Your event'),
          payload['eventId'] ? String(payload['eventId']) : undefined,
        );
      case NotificationType.EVENT_REJECTED:
        return eventRejectedEmail(
          String(payload['eventTitle'] ?? 'Your event'),
          String(payload['reason'] ?? ''),
          payload['eventId'] ? String(payload['eventId']) : undefined,
        );
      case NotificationType.ORGANIZER_VERIFICATION_APPROVED:
        return organizerVerificationApprovedEmail();
      case NotificationType.ORGANIZER_VERIFICATION_REJECTED:
        return organizerVerificationRejectedEmail(String(payload['reason'] ?? ''));
      case NotificationType.BOOKING_CONFIRMED:
        return bookingConfirmedEmail(
          String(payload['eventTitle'] ?? 'your event'),
          String(payload['bookingReference'] ?? ''),
          Number(payload['quantity'] ?? 1),
          payload['enrollmentId'] ? String(payload['enrollmentId']) : undefined,
        );
      default: {
        const { title, body } = this.describe(type, payload);
        return { subject: title, html: `<p>${body}</p>` };
      }
    }
  }
}
