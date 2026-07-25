import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinColumn,
  JoinTable,
  BeforeInsert,
  BeforeUpdate,
  Index,
} from 'typeorm';
import { Organizer } from './organizer.entity';
import { User } from './user.entity';
import { EventCategory } from './category.entity';
import { Enrollment } from './enrollment.entity';
import { TicketType } from './ticket-type.entity';
import { EventMedia } from './event-media.entity';

// Enums for type safety
export enum EventApprovalStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum EventStatus {
  UPCOMING = 'upcoming',
  ONGOING = 'ongoing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// Who bears platform commission + gateway fee. Settled default: ORGANIZER — the
// participant pays exactly ticket_type.price, and the organizer's payout is net of
// both commission and gateway fee (see Organizer.commissionRate/commissionFlatFee).
// PARTICIPANT is the opt-in mirror: buyer pays price + commission + gateway fee on
// top, organizer receives the full ticket price. Free events: no fee applies either way.
export enum FeePayer {
  ORGANIZER = 'organizer',
  PARTICIPANT = 'participant',
}

@Entity('events')
@Index(['eventDate', 'startTime'])
@Index(['approvalStatus', 'deletedAt'])
@Index(['categoryId', 'eventDate'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organizer_id' })
  organizerId!: string;

  @ManyToOne(() => EventCategory, (category) => category.events)
  @JoinColumn({ name: 'category_id' })
  category!: EventCategory;

  @Column({
    name: 'approval_status',
    type: 'enum',
    enum: EventApprovalStatus,
    default: EventApprovalStatus.DRAFT,
  })
  approvalStatus!: EventApprovalStatus;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  // RESTRICT, not CASCADE — see the matching comment on Organizer.user. A hard-deleted
  // organizer should not silently take every one of their events down with it.
  @ManyToOne(() => Organizer, (organizer) => organizer.events, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organizer_id' })
  organizer!: Organizer;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

  // Organizer-entered bullet points for the About tab — replaces what used to be a
  // hardcoded MOCK_HIGHLIGHTS/MOCK_WHO_SHOULD_ATTEND fallback on the frontend.
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  highlights!: string[];

  @Column({ name: 'who_should_attend', type: 'text', array: true, default: () => "'{}'" })
  whoShouldAttend!: string[];

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ name: 'venue_name', type: 'varchar', length: 255 })
  venueName!: string;

  @Column({ name: 'venue_address', type: 'text' })
  venueAddress!: string;

  @Column({ type: 'decimal', precision: 10, scale: 8, nullable: true })
  latitude!: number;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  longitude!: number;

  @Column({ name: 'event_date', type: 'date' })
  eventDate!: string;

  // Nullable, defaults to eventDate at the application level for single-day events (the
  // overwhelming majority of rows) — no backfill needed. Multi-day events (college fests,
  // conferences) set this explicitly. See loophole.md for why this exists: without it,
  // every "when does this event end" derivation silently assumed a single-day event.
  @Column({ name: 'event_end_date', type: 'date', nullable: true })
  eventEndDate?: string;

  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time', nullable: true })
  endTime!: string;

  /** @deprecated superseded by TicketType.price; kept for backward compat on legacy events. */
  @Column({
    name: 'price_per_ticket',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    default: 0,
  })
  pricePerTicket!: number;

  @Column({ type: 'varchar', length: 10, default: 'INR' })
  currency!: string;

  /** @deprecated superseded by TicketType.quantityTotal; kept for backward compat on legacy events. */
  @Column({ name: 'total_capacity', type: 'int', nullable: true })
  totalCapacity!: number;

  // Not a persisted column — EventsService.withComputedSeats() assigns this at read time
  // (live sum across ticket_types, or event.capacity when set). The old `available_tickets`
  // DB column this used to read/write was dropped: nothing ever read its stored value —
  // every response either recomputes it fresh here or never rendered the raw column at all.
  availableTickets?: number;

  // Aggregate cap across all ticket tiers for this event; null = unlimited (per-tier caps still apply).
  @Column({ type: 'int', nullable: true })
  capacity?: number;

  @Column({
    name: 'fee_payer',
    type: 'varchar',
    length: 20,
    enum: FeePayer,
    default: FeePayer.ORGANIZER,
  })
  feePayer!: FeePayer;

  @Column({ type: 'boolean', default: false })
  featured!: boolean;

  @Column({ name: 'is_online', type: 'boolean', default: false })
  isOnline!: boolean;

  @Column({ name: 'meeting_link', type: 'text', nullable: true })
  meetingLink?: string;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl?: string;

  @Column({ name: 'cover_image_url', type: 'text', nullable: true })
  coverImageUrl?: string;

  @Column({
    type: 'enum',
    enum: EventStatus,
    default: EventStatus.UPCOMING,
  })
  status!: EventStatus;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy?: string;

  @Column({ name: 'approved_at', type: 'timestamp', nullable: true })
  approvedAt?: Date;

  @Column({ name: 'rejected_by', type: 'uuid', nullable: true })
  rejectedBy?: string;

  @Column({ name: 'rejected_at', type: 'timestamp', nullable: true })
  rejectedAt?: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy?: string;

  @Column({ name: 'is_paid', type: 'boolean', default: false })
  isPaid!: boolean;

  @Column({ name: 'approval_method', type: 'varchar', length: 20, nullable: true })
  approvalMethod?: string;

  @Column({ name: 'refund_policy_type', type: 'varchar', length: 30, default: 'no_refunds' })
  refundPolicyType!: string;

  @Column({ name: 'refund_policy_text', type: 'text', nullable: true })
  refundPolicyText?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @OneToMany(() => Enrollment, (enrollment) => enrollment.event)
  enrollments!: Enrollment[];

  @OneToMany(() => TicketType, (ticketType) => ticketType.event)
  ticketTypes!: TicketType[];

  @OneToMany(() => EventMedia, (media) => media.event)
  media!: EventMedia[];

  @BeforeInsert()
  @BeforeUpdate()
  validateAndCalculate() {
    // Price validation
    if (this.pricePerTicket && this.pricePerTicket < 0) {
      throw new Error('Price per ticket cannot be negative');
    }

    // Image URL validation
    if (this.imageUrl && !this.isValidUrl(this.imageUrl)) {
      throw new Error('Invalid image URL format');
    }
  }

  // Helper methods
  isApproved(): boolean {
    return this.approvalStatus === EventApprovalStatus.APPROVED;
  }

  canEnroll(): boolean {
    return (
      this.approvalStatus === EventApprovalStatus.APPROVED &&
      this.status === EventStatus.UPCOMING
    );
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}
