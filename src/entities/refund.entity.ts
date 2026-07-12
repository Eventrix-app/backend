import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Enrollment } from './enrollment.entity';

export enum RefundStatus {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PROCESSED = 'processed',
  FAILED = 'failed',
}

// Forward-only transitions: a refund can never move backward or skip a step
// (e.g. requested -> processed without going through approved).
const ALLOWED_TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  [RefundStatus.REQUESTED]: [RefundStatus.APPROVED, RefundStatus.REJECTED],
  [RefundStatus.APPROVED]: [RefundStatus.PROCESSED, RefundStatus.FAILED],
  [RefundStatus.REJECTED]: [],
  [RefundStatus.PROCESSED]: [],
  [RefundStatus.FAILED]: [RefundStatus.APPROVED],
};

@Entity('refunds')
@Index(['enrollmentId'])
@Index(['status'])
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'enrollment_id', type: 'uuid' })
  enrollmentId!: string;

  @ManyToOne(() => Enrollment, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'enrollment_id' })
  enrollment!: Enrollment;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy!: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Column({
    type: 'varchar',
    length: 20,
    enum: RefundStatus,
    default: RefundStatus.REQUESTED,
  })
  status!: RefundStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount!: number;

  @Column({ name: 'gateway_refund_id', type: 'varchar', length: 255, nullable: true })
  gatewayRefundId?: string;

  @Column({ name: 'requested_at', type: 'timestamp' })
  requestedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamp', nullable: true })
  processedAt?: Date;

  static canTransition(from: RefundStatus, to: RefundStatus): boolean {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }
}
