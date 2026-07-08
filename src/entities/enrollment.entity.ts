import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';
import { Event } from './event.entity';

export enum EnrollmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  WAITLISTED = 'waitlisted',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

@Entity('event_bookings')
@Index(['eventId', 'userId'])
@Unique(['userId', 'eventId'])
export class Enrollment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

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

  @Column({ name: 'ticket_code', type: 'varchar', length: 255, nullable: true, unique: true })
  ticketCode?: string;

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