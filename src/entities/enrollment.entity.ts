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

  @Column({ name: 'booking_status', type: 'varchar', default: 'confirmed' })
  status!: string;

  @Column({ name: 'payment_status', type: 'varchar', default: 'pending', nullable: true })
  paymentStatus?: string;

  @Column({ name: 'payment_method', type: 'varchar', nullable: true })
  paymentMethod?: string;

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