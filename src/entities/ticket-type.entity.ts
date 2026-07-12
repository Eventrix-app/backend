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
import { Event } from './event.entity';

@Entity('ticket_types')
@Index(['eventId'])
export class TicketType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, (event) => event.ticketTypes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price!: number;

  @Column({ type: 'varchar', length: 10, default: 'INR' })
  currency!: string;

  @Column({ name: 'quantity_total', type: 'int', nullable: true })
  quantityTotal?: number;

  @Column({ name: 'quantity_sold', type: 'int', default: 0 })
  quantitySold!: number;

  @Column({ name: 'sales_start_at', type: 'timestamp', nullable: true })
  salesStartAt?: Date;

  @Column({ name: 'sales_end_at', type: 'timestamp', nullable: true })
  salesEndAt?: Date;

  @Column({ name: 'min_per_order', type: 'int', default: 1 })
  minPerOrder!: number;

  @Column({ name: 'max_per_order', type: 'int', nullable: true })
  maxPerOrder?: number;

  @Column({ name: 'is_hidden', type: 'boolean', default: false })
  isHidden!: boolean;

  @Column({ name: 'access_password', type: 'varchar', length: 255, nullable: true })
  accessPassword?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  hasCapacity(quantity: number): boolean {
    return this.quantityTotal == null || this.quantitySold + quantity <= this.quantityTotal;
  }
}
