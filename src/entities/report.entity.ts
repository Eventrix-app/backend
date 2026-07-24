import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './user.entity';

export enum ReportTargetType {
  USER = 'user',
  CHAT_MESSAGE = 'chat_message',
  REVIEW = 'review',
}

export enum ReportStatus {
  PENDING = 'pending',
  DISMISSED = 'dismissed',
  ACTIONED = 'actioned',
}

// Polymorphic on purpose (targetType + targetId, no FK on targetId) — a report can point
// at a User, a ChatMessage, or an EventReview, three otherwise-unrelated tables. A single
// FK column can't reference three different tables at once; the alternative (three
// nullable FK columns, one per type) adds schema complexity for no real benefit here,
// since every read path already knows targetType and looks the row up explicitly.
@Entity('reports')
@Index(['status', 'createdAt'])
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'reporter_id', type: 'uuid' })
  reporterId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reporter_id' })
  reporter!: User;

  @Column({ name: 'target_type', type: 'varchar', length: 20, enum: ReportTargetType })
  targetType!: ReportTargetType;

  @Column({ name: 'target_id', type: 'uuid' })
  targetId!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'varchar', length: 20, enum: ReportStatus, default: ReportStatus.PENDING })
  status!: ReportStatus;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy?: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamp', nullable: true })
  reviewedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
