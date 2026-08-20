import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Raw, Repository } from 'typeorm';
import * as QRCode from 'qrcode';
import { NotificationJob, NotificationJobStatus, NotificationType } from '../entities/notification-job.entity';
import { User } from '../entities/user.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { EmailAttachment, EmailService } from '../email/email.service';
import { PushService } from '../push/push.service';
import {
  announcementEmail,
  bookingConfirmedEmail,
  eventPendingApprovalEmail,
  refundRequestedEmail,
  userReportedEmail,
  eventApprovedEmail,
  eventCancelledEmail,
  eventChangedEmail,
  eventRejectedEmail,
  invoiceEmail,
  payoutProcessedEmail,
  payoutPaidEmail,
  organizerFollowedEmail,
  organizerVerificationApprovedEmail,
  organizerVerificationNewSubmissionEmail,
  organizerVerificationRejectedEmail,
  organizerVerificationSubmittedEmail,
  refundStatusEmail,
  RenderedEmail,
  waitlistPromotedEmail,
} from '../email/templates';
import type { InvoiceEmailLine } from '../email/templates';
import { renderTicketPdf } from '../common/pdf/ticket.pdf';

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  // The same payload the push carries, so tapping a row in the in-app list can deep-link
  // to exactly what the push would have. Without it the list can only mark-as-read: title
  // and body are prose and carry no ids to route on.
  payload: Record<string, unknown>;
}

// Notification types deliberately never sent by email — see sendEmailForJob below.
const PUSH_ONLY_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.SHORT_LIKED,
  NotificationType.SHORT_COMMENTED,
  // A block is a private user action, not a moderation decision — it belongs in the list as
  // context, but an email per block would bury the reports that need action.
  NotificationType.USER_BLOCKED,
]);

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

  // Both sends are fire-and-forget: callers await enqueue() as part of a state transition
  // that has already committed, so neither transport may fail the job.
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
      // Must never fail the caller's already-committed operation — an unhandled rejection at
      // a `void enqueue(...)` call site would crash the process.
      this.logger.error(`Failed to enqueue notification [${type}] for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async sendEmailForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user?.email || user.emailEnabled === false) return;
      // New types are emailed by default via the generic template. Right for bookings and
      // refunds, wrong for social signals — one email per reel like gets a domain flagged.
      if (PUSH_ONLY_TYPES.has(type)) return;
      const { subject, html } = this.describeEmail(type, payload);
      const attachments = await this.buildEmailAttachments(type, payload);
      await this.emailService.send(user.email, subject, html, attachments);
    } catch (err) {
      this.logger.warn(`Failed to email notification [${type}] to user ${user?.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Only BOOKING_CONFIRMED carries a ticket to render — every other type returns
  // undefined, which EmailService.send() treats as "no attachments" as normal.
  private async buildEmailAttachments(type: NotificationType, payload: Record<string, unknown>): Promise<EmailAttachment[] | undefined> {
    if (type !== NotificationType.BOOKING_CONFIRMED) return undefined;
    const ticketCode = payload['ticketCode'] ? String(payload['ticketCode']) : undefined;
    if (!ticketCode) return undefined;
    try {
      const qrPng = await QRCode.toBuffer(ticketCode, { type: 'png', margin: 1, width: 300 });
      // A PDF rather than a loose QR image: it saves to the device as one file carrying the
      // event, seat count and reference, which a bare .png does not.
      const ticketPdf = await renderTicketPdf({
        eventTitle: String(payload['eventTitle'] ?? 'Your event'),
        bookingReference: String(payload['bookingReference'] ?? ''),
        ticketCode,
        quantity: Number(payload['quantity'] ?? 1),
        eventDate: payload['eventDate'] ? String(payload['eventDate']) : undefined,
        startTime: payload['startTime'] ? String(payload['startTime']) : undefined,
        venueName: payload['venueName'] ? String(payload['venueName']) : undefined,
        qrPng,
      });

      return [
        { filename: 'eventrix-ticket.pdf', content: ticketPdf, contentType: 'application/pdf' },
      ];
    } catch (err) {
      this.logger.warn(`Failed to build ticket attachment: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async sendPushForJob(user: User | null, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      if (!user || user.pushEnabled === false) return;
      const devices = await this.deviceTokenRepository.find({ where: { userId: user.id } });
      if (devices.length === 0) return;
      const { title, body } = this.describe(type, payload);
      // type rides along so the tap handler can deep-link without parsing title/body. Fanned
      // out to every device, and one dead token can't suppress the rest.
      await Promise.all(devices.map((d) => this.pushService.send(d.token, title, body, { type, ...payload })));
    } catch (err) {
      this.logger.warn(`Failed to push notification [${type}] to user ${user?.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // likerName is denormalised rather than looked up at render time: a notification records
  // what happened and must still read correctly if the liker later renames.
  async notifyShortLiked(ownerUserId: string, shortId: string, likerName: string): Promise<void> {
    await this.enqueue(ownerUserId, NotificationType.SHORT_LIKED, { shortId, likerName });
  }

  // Carries the comment body so the notification shows what was said, not just that
  // something was.
  async notifyShortCommented(
    ownerUserId: string,
    shortId: string,
    commenterName: string,
    body: string,
  ): Promise<void> {
    await this.enqueue(ownerUserId, NotificationType.SHORT_COMMENTED, { shortId, commenterName, body });
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

  // enrollmentId rides along so a push tap can deep-link to TicketDetails, which needs it
  // rather than a refundId.
  // `reason` is only ever set on a rejection — it is the decision the organizer/admin wrote
  // back, and it rides in the payload so the push, the in-app row and the email can all
  // repeat it rather than telling the user only that they were refused.
  async notifyRefundStatus(
    userId: string,
    refundId: string,
    status: string,
    enrollmentId: string,
    reason?: string,
  ): Promise<void> {
    await this.enqueue(userId, NotificationType.REFUND_STATUS, { refundId, status, enrollmentId, reason });
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

  async notifyOrganizerVerificationSubmitted(userId: string): Promise<void> {
    await this.enqueue(userId, NotificationType.ORGANIZER_VERIFICATION_SUBMITTED, {});
  }

  // Admin queue alerts fan out to every admin. Resolving recipients here keeps each caller
  // from re-deriving "who is an admin".

  // roles is a jsonb array column on users; @> is the containment operator, which uses the
  // GIN index on it rather than scanning every row.
  private async findAdminUserIds(): Promise<string[]> {
    const admins = await this.usersRepository.find({
      where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
      select: ['id'],
    });
    return admins.map((a) => a.id);
  }

  // Never rethrows: every caller has already committed a user-facing action, so failing to
  // alert admins must not fail it.
  private async enqueueForAdmins(type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    try {
      const adminUserIds = await this.findAdminUserIds();
      if (adminUserIds.length === 0) {
        this.logger.warn(`No admin users found to notify for [${type}]`);
        return;
      }
      await Promise.all(adminUserIds.map((userId) => this.enqueue(userId, type, payload)));
    } catch (err) {
      this.logger.error(
        `Failed to fan out admin notification [${type}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async notifyOrganizerVerificationNewSubmission(applicantName: string, companyName: string): Promise<void> {
    await this.enqueueForAdmins(NotificationType.ORGANIZER_VERIFICATION_NEW_SUBMISSION, { applicantName, companyName });
  }

  // Fires on creation of a paid event by a non-auto-approve organizer, and again when an
  // approved event is edited back into review.
  async notifyAdminsEventPendingApproval(eventId: string, eventTitle: string, organizerName: string): Promise<void> {
    await this.enqueueForAdmins(NotificationType.EVENT_PENDING_APPROVAL, { eventId, eventTitle, organizerName });
  }

  // The review item for whoever approves it — distinct from notifyRefundStatus(REQUESTED),
  // which acknowledges the request to the participant.
  async notifyAdminsRefundRequested(
    refundId: string,
    enrollmentId: string,
    amount: number,
    requesterName: string,
    eventTitle: string,
  ): Promise<void> {
    await this.enqueueForAdmins(NotificationType.REFUND_REQUESTED, {
      refundId,
      enrollmentId,
      amount,
      requesterName,
      eventTitle,
    });
  }

  async notifyAdminsUserReported(
    reportId: string,
    targetType: string,
    targetId: string,
    reporterName: string,
    reason: string,
  ): Promise<void> {
    await this.enqueueForAdmins(NotificationType.USER_REPORTED, {
      reportId,
      targetType,
      targetId,
      reporterName,
      reason,
    });
  }

  async notifyAdminsUserBlocked(
    blockerId: string,
    blockerName: string,
    blockedId: string,
    blockedName: string,
  ): Promise<void> {
    await this.enqueueForAdmins(NotificationType.USER_BLOCKED, { blockerId, blockerName, blockedId, blockedName });
  }

  // Fires only once a booking is paid-and-confirmed: immediately for free events, from the
  // webhook for paid ones. Never while payment is still pending.
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
    ticketCode?: string,
    eventDate?: string,
    startTime?: string,
    venueName?: string,
  ): Promise<void> {
    await this.enqueue(userId, NotificationType.BOOKING_CONFIRMED, {
      eventId,
      enrollmentId,
      eventTitle,
      bookingReference,
      quantity,
      ticketCode,
      eventDate,
      startTime,
      venueName,
    });
  }

  // Tax receipt for a settled booking. Sent alongside notifyBookingConfirmed rather than
  // folded into it: that one carries the ticket and QR code, this one is the financial
  // document, and a buyer forwarding a receipt to an accountant should not be forwarding
  // their entry QR with it.
  //
  // `lines` is assembled by the caller because which fee lines a buyer may be shown depends
  // on who actually paid them (see PaymentsService.buildInvoiceEmailLines).
  async notifyInvoiceIssued(
    userId: string,
    payload: {
      invoiceNumber: string;
      enrollmentId: string;
      eventTitle: string;
      lines: InvoiceEmailLine[];
      total: number;
      currency: string;
      transactionId?: string;
    },
  ): Promise<void> {
    await this.enqueue(userId, NotificationType.INVOICE_ISSUED, { ...payload });
  }

  // Goes to the organizer's own user account (Organizer.userId), not the buyer.
  async notifyPayoutProcessed(
    organizerUserId: string,
    payload: {
      payoutId: string;
      eventId: string;
      eventTitle: string;
      ticketCount: number;
      grossRevenue: number;
      platformFee: number;
      gatewayFee: number;
      payoutAmount: number;
    },
  ): Promise<void> {
    await this.enqueue(organizerUserId, NotificationType.PAYOUT_PROCESSED, { ...payload });
  }

  // Sent when a transfer confirms, not when the sweep computes the obligation — see
  // NotificationType.PAYOUT_PAID.
  async notifyPayoutPaid(
    organizerUserId: string,
    payload: {
      payoutId: string;
      eventId: string;
      eventTitle: string;
      payoutAmount: number;
      transferReference?: string;
    },
  ): Promise<void> {
    await this.enqueue(organizerUserId, NotificationType.PAYOUT_PAID, { ...payload });
  }

  // ---------------------------------------------------------------------
  // Read-side for NotificationsScreen — lists the same jobs enqueue() persists,
  // rendered with a human-readable title/body derived from type + payload.
  // ---------------------------------------------------------------------
  // Capped rather than fully paginated — every booking, event change, follow, like, and
  // comment enqueues a row per user forever, so this list grows unboundedly. A hard cap on
  // the most recent entries (rather than real page/limit params) avoids changing this
  // endpoint's response shape for the app's existing notification feed screen.
  private static readonly MAX_NOTIFICATIONS_RETURNED = 200;

  async findMyNotifications(userId: string): Promise<NotificationRecord[]> {
    const jobs = await this.notificationJobsRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: NotificationService.MAX_NOTIFICATIONS_RETURNED,
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
      payload: job.payload ?? {},
    };
  }

  private describe(type: NotificationType, payload: Record<string, unknown>): { title: string; body: string } {
    const sanitize = (input: string) =>
      input.replace(/[&<>"']/g, (c) => {
        switch (c) {
          case '&':
            return '&amp;';
          case '<':
            return '&lt;';
          case '>':
            return '&gt;';
          case '"':
            return '&quot;';
          case "'":
            return '&#39;';
          default:
            return c;
        }
      });
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
        if (status === 'rejected') {
          const reason = payload['reason'] ? ` Reason: ${sanitize(String(payload['reason']))}` : '';
          return { title: 'Refund request declined', body: `Your refund request was not approved.${reason}` };
        }
        return { title: 'Refund update', body: `Your refund is now "${status}".` };
      }
      case NotificationType.ANNOUNCEMENT: {
        const title = String(payload['title'] ?? 'New announcement');
        return { title: 'Event announcement', body: title };
      }
      case NotificationType.ORGANIZER_FOLLOWED: {
        const followerName = sanitize(String(payload['followerName'] ?? 'Someone'));
        return { title: 'New follower', body: `${followerName} started following you.` };
      }
      case NotificationType.SHORT_LIKED: {
        const likerName = sanitize(String(payload['likerName'] ?? 'Someone'));
        return { title: 'New like', body: `${likerName} liked your reel.` };
      }
      case NotificationType.SHORT_COMMENTED: {
        const commenterName = sanitize(String(payload['commenterName'] ?? 'Someone'));
        const text = String(payload['body'] ?? '');
        // Truncated: a push body is clipped by the OS anyway, and an ellipsis reads better
        // than an arbitrary cut mid-word at the system's own limit.
        const preview = text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
        return { title: `${commenterName} commented`, body: preview || 'commented on your reel.' };
      }
      case NotificationType.EVENT_CANCELLED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'An event you booked'));
        const reason = payload['reason'] ? ` Reason: ${sanitize(String(payload['reason']))}.` : '';
        return {
          title: 'Event cancelled',
          body: `${eventTitle} has been cancelled.${reason} If you paid for this booking, request a refund from My Bookings in the app.`,
        };
      }
      case NotificationType.EVENT_APPROVED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'Your event'));
        return { title: "You're live!", body: `${eventTitle} has been approved and is now visible to everyone.` };
      }
      case NotificationType.EVENT_REJECTED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'Your event'));
        const reason = payload['reason'] ? ` ${sanitize(String(payload['reason']))}` : '';
        return { title: 'Your event needs another look', body: `${eventTitle} wasn't approved this time.${reason}` };
      }
      case NotificationType.ORGANIZER_VERIFICATION_APPROVED:
        return {
          title: "You're verified!",
          body: 'Your organizer verification was approved — you can now create and publish events.',
        };
      case NotificationType.ORGANIZER_VERIFICATION_REJECTED: {
        const reason = sanitize(String(payload['reason'] ?? ''));
        return {
          title: 'Verification needs another look',
          body: `Your organizer verification wasn't approved. ${reason} You can update your details and resubmit.`,
        };
      }
      case NotificationType.ORGANIZER_VERIFICATION_SUBMITTED:
        return {
          title: 'Documents submitted',
          body: "We've received your organizer verification documents — an admin will review them soon.",
        };
      case NotificationType.ORGANIZER_VERIFICATION_NEW_SUBMISSION: {
        const applicantName = sanitize(String(payload['applicantName'] ?? 'An applicant'));
        const companyName = sanitize(String(payload['companyName'] ?? 'their business'));
        return {
          title: 'New verification to review',
          body: `${applicantName} submitted organizer verification documents for ${companyName}.`,
        };
      }
      case NotificationType.EVENT_PENDING_APPROVAL: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'An event'));
        const organizerName = sanitize(String(payload['organizerName'] ?? 'An organizer'));
        return {
          title: 'Event awaiting approval',
          body: `${organizerName} submitted "${eventTitle}" for review.`,
        };
      }
      case NotificationType.REFUND_REQUESTED: {
        const requesterName = sanitize(String(payload['requesterName'] ?? 'A participant'));
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'an event'));
        const amount = Number(payload['amount'] ?? 0);
        return {
          title: 'Refund request to review',
          body: `${requesterName} requested a ₹${amount.toFixed(2)} refund for ${eventTitle}.`,
        };
      }
      case NotificationType.USER_REPORTED: {
        const reporterName = sanitize(String(payload['reporterName'] ?? 'Someone'));
        const targetType = String(payload['targetType'] ?? 'user').replace(/_/g, ' ');
        const reason = sanitize(String(payload['reason'] ?? ''));
        const preview = reason.length > 80 ? `${reason.slice(0, 80).trimEnd()}…` : reason;
        return {
          title: `New ${targetType} report`,
          body: `${reporterName} reported a ${targetType}.${preview ? ` Reason: ${preview}` : ''}`,
        };
      }
      case NotificationType.USER_BLOCKED: {
        const blockerName = sanitize(String(payload['blockerName'] ?? 'A user'));
        const blockedName = sanitize(String(payload['blockedName'] ?? 'another user'));
        return { title: 'User blocked', body: `${blockerName} blocked ${blockedName}.` };
      }
      case NotificationType.BOOKING_CONFIRMED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'your event'));
        const bookingReference = String(payload['bookingReference'] ?? '');
        const quantity = Number(payload['quantity'] ?? 1);
        return {
          title: 'Booking confirmed!',
          body: `You're confirmed for ${eventTitle} (${quantity} ticket${quantity === 1 ? '' : 's'}). Booking reference: ${bookingReference}. View your ticket in the app.`,
        };
      }
      case NotificationType.INVOICE_ISSUED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'your booking'));
        return { title: 'Invoice ready', body: `Your invoice for ${eventTitle} is available in the app.` };
      }
      case NotificationType.PAYOUT_PROCESSED: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'your event'));
        const amount = Number(payload['payoutAmount'] ?? 0);
        return { title: 'Payout processed', body: `₹${amount.toFixed(2)} settled for ${eventTitle}.` };
      }
      case NotificationType.PAYOUT_PAID: {
        const eventTitle = sanitize(String(payload['eventTitle'] ?? 'your event'));
        const amount = Number(payload['payoutAmount'] ?? 0);
        return { title: 'Payout sent', body: `₹${amount.toFixed(2)} transferred to your bank for ${eventTitle}.` };
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
          payload['reason'] ? String(payload['reason']) : undefined,
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
      case NotificationType.ORGANIZER_VERIFICATION_SUBMITTED:
        return organizerVerificationSubmittedEmail();
      case NotificationType.ORGANIZER_VERIFICATION_NEW_SUBMISSION:
        return organizerVerificationNewSubmissionEmail(
          String(payload['applicantName'] ?? 'An applicant'),
          String(payload['companyName'] ?? 'their business'),
        );
      case NotificationType.EVENT_PENDING_APPROVAL:
        return eventPendingApprovalEmail(
          String(payload['eventTitle'] ?? 'An event'),
          String(payload['organizerName'] ?? 'An organizer'),
        );
      case NotificationType.REFUND_REQUESTED:
        return refundRequestedEmail(
          String(payload['requesterName'] ?? 'A participant'),
          String(payload['eventTitle'] ?? 'an event'),
          Number(payload['amount'] ?? 0),
        );
      case NotificationType.USER_REPORTED:
        return userReportedEmail(
          String(payload['reporterName'] ?? 'Someone'),
          String(payload['targetType'] ?? 'user'),
          String(payload['reason'] ?? ''),
        );
      case NotificationType.BOOKING_CONFIRMED:
        return bookingConfirmedEmail(
          String(payload['eventTitle'] ?? 'your event'),
          String(payload['bookingReference'] ?? ''),
          Number(payload['quantity'] ?? 1),
          payload['enrollmentId'] ? String(payload['enrollmentId']) : undefined,
          payload['eventDate'] ? String(payload['eventDate']) : undefined,
          payload['startTime'] ? String(payload['startTime']) : undefined,
          payload['venueName'] ? String(payload['venueName']) : undefined,
          !!payload['ticketCode'],
        );
      case NotificationType.INVOICE_ISSUED:
        return invoiceEmail(
          String(payload['invoiceNumber'] ?? ''),
          String(payload['eventTitle'] ?? 'your booking'),
          (payload['lines'] as InvoiceEmailLine[] | undefined) ?? [],
          Number(payload['total'] ?? 0),
          String(payload['currency'] ?? 'INR') === 'INR',
          payload['enrollmentId'] ? String(payload['enrollmentId']) : undefined,
          payload['transactionId'] ? String(payload['transactionId']) : undefined,
        );
      case NotificationType.PAYOUT_PROCESSED:
        return payoutProcessedEmail(
          String(payload['eventTitle'] ?? 'your event'),
          Number(payload['ticketCount'] ?? 0),
          Number(payload['grossRevenue'] ?? 0),
          Number(payload['platformFee'] ?? 0),
          Number(payload['gatewayFee'] ?? 0),
          Number(payload['payoutAmount'] ?? 0),
        );
      case NotificationType.PAYOUT_PAID:
        return payoutPaidEmail(
          String(payload['eventTitle'] ?? 'your event'),
          Number(payload['payoutAmount'] ?? 0),
          payload['transferReference'] ? String(payload['transferReference']) : undefined,
        );
      default: {
        const { title, body } = this.describe(type, payload);
        return { subject: title, html: `<p>${body}</p>` };
      }
    }
  }
}
