import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { numericTransformer } from '../common/database/numeric.transformer';
import { Organizer } from './organizer.entity';
import { Event } from './event.entity';

export enum PayoutStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
}

// One row per (organizer, event) batch produced by the T+3 payout cron sweep.
@Entity('payouts')
@Index(['eventId'])
@Index(['organizerId', 'status'])
export class Payout {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organizer_id', type: 'uuid' })
  organizerId!: string;

  @ManyToOne(() => Organizer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organizer_id' })
  organizer!: Organizer;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  @Column({ name: 'ticket_count', type: 'int' })
  ticketCount!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: numericTransformer })
  amount!: number;

  @Column({ type: 'varchar', length: 10, default: 'INR' })
  currency!: string;

  // PENDING, not PAID. The sweep only ever computes an obligation — there is no bank
  // transfer integration in this codebase, so a row created by settleEventPayout() means
  // "this is owed", never "this has been sent". Defaulting to PAID made every payout claim
  // money had moved when none had, which is wrong in the reconciliation direction that
  // matters: it overstates what has been settled.
  //
  // PAID is set only by markPayoutPaid(), which a real disbursement integration must call
  // once a transfer actually confirms.
  @Column({
    type: 'varchar',
    length: 20,
    enum: PayoutStatus,
    default: PayoutStatus.PENDING,
  })
  status!: PayoutStatus;

  // When the sweep computed the obligation. Always set on creation.
  @Column({ name: 'processed_at', type: 'timestamp', nullable: true })
  processedAt?: Date;

  // When money actually reached the organizer's bank. Stays NULL until a transfer confirms
  // — deliberately distinct from processedAt so "computed" and "sent" can never be conflated.
  @Column({ name: 'paid_at', type: 'timestamp', nullable: true })
  paidAt?: Date;

  // UTR or provider payout id — the organizer's only proof of payment, so persisted
  // rather than logged. Set with paidAt by markPayoutPaid().
  @Column({ name: 'transfer_reference', type: 'varchar', length: 128, nullable: true })
  transferReference?: string;

  // Admin-only context on why/how this was settled. Never shown to the organizer.
  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
