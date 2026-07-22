import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum NotificationType {
  EVENT_CHANGED = 'event_changed',
  WAITLIST_PROMOTED = 'waitlist_promoted',
  REFUND_STATUS = 'refund_status',
  ANNOUNCEMENT = 'announcement',
  ORGANIZER_FOLLOWED = 'organizer_followed',
  BOOKING_CONFIRMED = 'booking_confirmed',
  EVENT_CANCELLED = 'event_cancelled',
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

  @Column({ type: 'varchar', length: 30, enum: NotificationType })
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
