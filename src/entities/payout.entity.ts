import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
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

  @Column({ type: 'decimal', precision: 12, scale: 2 })
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

  // The bank/gateway reference for the transfer that settled this payout — a UTR for an
  // NEFT/IMPS transfer, or the disbursement provider's own payout id. Written by
  // markPayoutPaid() alongside paidAt.
  //
  // This is the organizer's only proof of payment and the thing they will quote when a
  // transfer is disputed or reconciled against a bank statement, so it is persisted rather
  // than merely logged: markPayoutPaid() accepted a reference from the start but only wrote
  // it to the application log, where it is unqueryable and expires with log retention.
  @Column({ name: 'transfer_reference', type: 'varchar', length: 128, nullable: true })
  transferReference?: string;

  // Free-text context from whoever confirmed the transfer ("paid manually, PayU payout API
  // returned 502 twice"). Operational history for the admin who has to explain this payout
  // six months from now; never shown to the organizer.
  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
