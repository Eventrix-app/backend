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
import { Event } from './event.entity';
import { TicketType } from './ticket-type.entity';
import { User } from './user.entity';

export enum WaitlistStatus {
  WAITING = 'waiting',
  PROMOTED = 'promoted',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

@Entity('waitlist_entries')
@Index(['ticketTypeId', 'status', 'createdAt'])
@Unique(['userId', 'ticketTypeId'])
export class WaitlistEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  @Column({ name: 'ticket_type_id', type: 'uuid' })
  ticketTypeId!: string;

  @ManyToOne(() => TicketType, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_type_id' })
  ticketType!: TicketType;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({
    type: 'varchar',
    length: 20,
    enum: WaitlistStatus,
    default: WaitlistStatus.WAITING,
  })
  status!: WaitlistStatus;

  @Column({ name: 'promoted_at', type: 'timestamp', nullable: true })
  promotedAt?: Date;

  @Column({ name: 'promoted_enrollment_id', type: 'uuid', nullable: true })
  promotedEnrollmentId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
