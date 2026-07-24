import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum NotificationType {
  EVENT_CHANGED = 'event_changed',
  WAITLIST_PROMOTED = 'waitlist_promoted',
  REFUND_STATUS = 'refund_status',
  ANNOUNCEMENT = 'announcement',
  ORGANIZER_FOLLOWED = 'organizer_followed',
  BOOKING_CONFIRMED = 'booking_confirmed',
  EVENT_CANCELLED = 'event_cancelled',
  EVENT_APPROVED = 'event_approved',
  EVENT_REJECTED = 'event_rejected',
  ORGANIZER_VERIFICATION_APPROVED = 'organizer_verification_approved',
  ORGANIZER_VERIFICATION_REJECTED = 'organizer_verification_rejected',
}

export enum NotificationJobStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

// A queued notification for a user. Persisted first as an audit trail, then marked sent
// once NotificationService.enqueue() has fired both the email (EmailService) and push
// (PushService) transports for it — "sent" tracks that delivery was attempted, not that
// either transport actually reached the user (both are fire-and-forget and never throw).
@Entity('notification_jobs')
@Index(['userId', 'status'])
export class NotificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  // 40, not 30: 'organizer_verification_approved'/'_rejected' are 32 chars — a varchar(30)
  // column silently rejects every insert of either value at the DB level. Both crashed the
  // whole process too: NotificationService.enqueue() is always called via `void` (fire-
  // and-forget) at every call site, so the resulting unhandled promise rejection wasn't
  // just swallowed — Node treats an unhandled rejection as fatal by default.
  @Column({ type: 'varchar', length: 40, enum: NotificationType })
  type!: NotificationType;

  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, unknown>;

  @Column({
    type: 'varchar',
    length: 20,
    enum: NotificationJobStatus,
    default: NotificationJobStatus.PENDING,
  })
  status!: NotificationJobStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamp', nullable: true })
  sentAt?: Date;

  // User-facing read state for GET /notifications — distinct from `status`, which tracks
  // delivery (pending/sent/failed) rather than whether the recipient has seen it.
  @Column({ name: 'read_at', type: 'timestamp', nullable: true })
  readAt?: Date | null;
}
