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

@Entity('events')
@Index(['eventDate', 'startTime'])
@Index(['approvalStatus', 'deletedAt'])
@Index(['categoryId', 'eventDate'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organizer_id' })
  organizerId!: string;

  @ManyToMany(() => User, (user) => user.enrolledIn)
  @JoinTable({ name: 'event_participants' })
  participants!: User[];

  @ManyToOne(() => EventCategory, (category) => category.events)
  @JoinColumn({ name: 'category_id' })
  category!: EventCategory;

  @Column({
    type: 'enum',
    enum: EventApprovalStatus,
    default: EventApprovalStatus.DRAFT,
  })
  approvalStatus!: EventApprovalStatus;

  @Column({ type: 'text', nullable: true })
  rejectionReason?: string;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @ManyToOne(() => Organizer, (organizer) => organizer.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizer_id' })
  organizer!: Organizer;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

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

  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time', nullable: true })
  endTime!: string;

  @Column({ name: 'duration_minutes', type: 'int', nullable: true })
  durationMinutes!: number;

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

  @Column({ name: 'total_capacity', type: 'int', nullable: true })
  totalCapacity!: number;

  @Column({ name: 'available_tickets', type: 'int', nullable: true })
  availableTickets!: number;

  @Column({ type: 'boolean', default: false })
  featured!: boolean;

  @Column({ type: 'boolean', default: false })
  isOnline!: boolean;

  @Column({ type: 'text', nullable: true })
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


  @Column({ name: 'ticket_sales_open_date', type: 'date', nullable: true })
  ticketSalesOpenDate!: string;

  @Column({ name: 'ticket_sales_close_date', type: 'date', nullable: true })
  ticketSalesCloseDate!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date;

  @OneToMany(() => Enrollment, (enrollment) => enrollment.event)
  enrollments!: Enrollment[];

  @BeforeInsert()
  @BeforeUpdate()
  validateAndCalculate() {
    // Auto-calculate duration from start/end times
    if (this.startTime && this.endTime && !this.durationMinutes) {
      this.durationMinutes = this.calculateDuration(this.startTime, this.endTime);
    }
    
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
      this.status === EventStatus.UPCOMING &&
      (!this.availableTickets || this.availableTickets > 0)
    );
  }

  hasTicketsAvailable(): boolean {
    return !this.availableTickets || this.availableTickets > 0;
  }

  // Pure derived field calculation (no side effects)
  private calculateDuration(startTime: string, endTime: string): number {
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    let duration = endMinutes - startMinutes;
    // Handle overnight events
    if (duration < 0) {
      duration += 24 * 60;
    }

    return duration;
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
