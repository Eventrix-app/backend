import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { Event } from './event.entity';
import { TicketType } from './ticket-type.entity';

export enum EnrollmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  WAITLISTED = 'waitlisted',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

@Entity('event_bookings')
@Index(['eventId', 'userId'])
// Partial unique index, not a plain @Unique — uniqueness only applies while the booking
// isn't cancelled, so cancelling and re-enrolling in the same event doesn't permanently
// 409 (see migration PartialUniqueIndexesAndCascadeFix). `where` is raw SQL against the
// actual DB column name, not the TS property name.
@Index(['userId', 'eventId'], { unique: true, where: `"booking_status" != 'cancelled'` })
export class Enrollment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'ticket_type_id', type: 'uuid', nullable: true })
  ticketTypeId?: string;

  @ManyToOne(() => TicketType, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'ticket_type_id' })
  ticketType?: TicketType;

  // Set once this booking has been swept into a payout batch. NULL = still payable /
  // pending eligibility. Used by the payout cron to exclude already-paid enrollments.
  @Column({ name: 'payout_id', type: 'uuid', nullable: true })
  payoutId?: string;

  @Column({ name: 'quantity_tickets', type: 'int', default: 1 })
  quantity!: number;

  @Column({ name: 'total_price', type: 'decimal', precision: 10, scale: 2, default: 0 })
  totalAmount!: number;

  // --- Frozen fee split, stamped once by handleWebhook() when the payment succeeds ---
  //
  // Everything below is a SNAPSHOT of what was actually charged and how it was actually
  // split, written inside the settlement transaction and never rewritten afterwards.
  //
  // Before this existed, payout, invoicing and refund reversal all re-derived the split from
  // enrollment.totalAmount against the organizer's CURRENT commissionRate. That made the
  // rate retroactive: an admin editing an organizer from 0% to 5% silently restated every
  // past event's payout and reissued every past invoice at a different total than the buyer
  // was billed and the ledger recorded. The same applies to the platform-wide defaults
  // (PLATFORM_COMMISSION_PERCENT, GATEWAY_FEE_*, TAX_GST_RATE) — an env change moved money
  // that had already been accounted for.
  //
  // NULL on every row booked before this shipped. Readers MUST fall back to
  // calculateFromChargedAmount() for those rather than treating NULL as zero — a frozen 0
  // (negotiated commission-free partner) and "never frozen" are different facts, which is
  // why these are nullable rather than `default: 0`. See PaymentsService.resolveBreakdown().
  @Column({ name: 'fee_payer_applied', type: 'varchar', length: 20, nullable: true })
  feePayerApplied?: string | null;

  // The commission inputs in force at settlement, kept alongside the resulting amounts so a
  // dispute can be answered with "you were on 5% + ₹0 on that date", not just a total.
  @Column({ name: 'commission_rate_applied', type: 'decimal', precision: 5, scale: 2, nullable: true })
  commissionRateApplied?: number | null;

  @Column({ name: 'commission_flat_fee_applied', type: 'decimal', precision: 10, scale: 2, nullable: true })
  commissionFlatFeeApplied?: number | null;

  // The base the split was computed from, across the whole order. Under feePayer=PARTICIPANT
  // this is strictly less than totalAmount (which carries the fees on top); under ORGANIZER
  // the two are equal; for a free event it is 0 while totalAmount is the ₹12.50 fee.
  @Column({ name: 'ticket_base_amount', type: 'decimal', precision: 10, scale: 2, nullable: true })
  ticketBaseAmount?: number | null;

  @Column({ name: 'platform_fee_amount', type: 'decimal', precision: 10, scale: 2, nullable: true })
  platformFeeAmount?: number | null;

  @Column({ name: 'gateway_fee_amount', type: 'decimal', precision: 10, scale: 2, nullable: true })
  gatewayFeeAmount?: number | null;

  @Column({ name: 'gst_amount', type: 'decimal', precision: 10, scale: 2, nullable: true })
  gstAmount?: number | null;

  // What the organizer is owed for this booking. THE figure the payout sweep sums — no
  // longer recomputed from live config at sweep time.
  @Column({ name: 'organizer_payout_amount', type: 'decimal', precision: 10, scale: 2, nullable: true })
  organizerPayoutAmount?: number | null;

  // Set together with the columns above. Distinguishes "frozen, and every amount happened to
  // be 0" from "never frozen" without having to test each column for NULL.
  @Column({ name: 'fees_frozen_at', type: 'timestamp', nullable: true })
  feesFrozenAt?: Date | null;

  @Column({ name: 'booking_status', type: 'varchar', default: 'confirmed' })
  status!: string;

  @Column({ name: 'payment_status', type: 'varchar', default: 'pending', nullable: true })
  paymentStatus?: string;

  @Column({ name: 'payment_method', type: 'varchar', nullable: true })
  paymentMethod?: string;

  // PayU's classic checkout has no "fetch order by id" API to round-trip through the way
  // Razorpay's fetchOrder() lets verifyPayment() recover which enrollment an order belongs
  // to — so we mint our own txnid at initiatePayUOrder() time and remember the mapping here
  // ourselves, looked up again when PayU's surl/furl callback arrives. Indexed since every
  // PayU return callback looks an enrollment up by this column.
  @Index()
  @Column({ name: 'payu_txn_id', type: 'varchar', nullable: true })
  payuTxnId?: string;

  @Column({ name: 'booking_reference', type: 'varchar' })
  bookingReference!: string;

  @Column({ name: 'ticket_code', type: 'text', nullable: true, unique: true })
  ticketCode?: string;

  // Intentionally not client-settable via any DTO/endpoint — a QR code must encode this
  // booking's own signed ticketCode, so it has to be generated server-side (at enrollment
  // or ticket-fetch time), never accepted as upload input. See multipart.md §3.5.
  @Column({ name: 'qr_code_url', type: 'text', nullable: true })
  qrCodeUrl?: string;

  @Column({ name: 'used_date', type: 'timestamp', nullable: true })
  checkedInAt?: Date;

  // Identity of the scan that claimed this ticket, generated on the scanning device before
  // its first send attempt and reused for every retry of that same scan. Lets checkIn()
  // answer "is this the same scan arriving twice, or a different one?" — see checkIn().
  @Column({ name: 'check_in_key', type: 'text', nullable: true })
  checkInKey?: string;

  // The organizer/admin user whose device claimed it. Only used to explain a rejected
  // duplicate ("already admitted at 19:38"), never for authorization.
  @Column({ name: 'checked_in_by', type: 'uuid', nullable: true })
  checkedInBy?: string;

  @Column({ name: 'booking_date', type: 'timestamp', nullable: true })
  bookingDate?: Date;

  @Column({ name: 'cancelled_date', type: 'timestamp', nullable: true })
  cancelledDate?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => User, (user) => user.enrollments, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Event, (event) => event.enrollments, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;
}