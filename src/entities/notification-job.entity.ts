import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum NotificationType {
  EVENT_CHANGED = 'event_changed',
  WAITLIST_PROMOTED = 'waitlist_promoted',
  REFUND_STATUS = 'refund_status',
}

export enum NotificationJobStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

// A queued notification for a user. Phase 1 has no push/email transport wired up yet
// (that's Phase 2 — "reuse existing NotificationService triggers from Phase 1"), so jobs
// are delivered by logging and marked sent immediately; the queue/table shape is what
// Phase 2's real push integration will drain from instead of a log line.
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
