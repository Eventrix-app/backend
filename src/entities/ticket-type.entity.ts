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

// Fixed vocabulary organizers pick from rather than typing their own tier name — the whole
// point (see CreateTicketTypeDto) is that "ticket types" stays a small, comparable set
// across every event on the platform instead of one organizer's "VIP" being another's
// "Premium" being a third's "Gold Pass".
export enum TicketCategory {
  EARLY_BIRD = 'EARLY_BIRD',
  GENERAL = 'GENERAL',
  VIP = 'VIP',
}

// The display label for each category — what actually lands in TicketType.name. Centralized
// here (not left for each caller to invent) so "which category renders which name" has one
// answer; events.service.ts's createForUser/createTicketType/updateTicketType all derive
// `name` from this rather than trusting client input, which is what makes the enum
// meaningful — a client could otherwise still send an arbitrary `name` alongside a valid
// `category` and defeat the whole point.
export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  [TicketCategory.EARLY_BIRD]: 'Early Bird Pass',
  [TicketCategory.GENERAL]: 'General Pass',
  [TicketCategory.VIP]: 'VIP Pass',
};

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

  @Column({
    type: 'enum',
    enum: TicketCategory,
    default: TicketCategory.GENERAL,
  })
  category!: TicketCategory;

  // Kept alongside `category` rather than computed on read, even though it is always
  // TICKET_CATEGORY_LABELS[category]: BookingsScreen and every other existing consumer
  // already reads `ticketType.name` straight off the API response, and duplicating the
  // derivation at every read site is more places for the two to drift than storing it once
  // at write time in the one place (events.service.ts) that ever sets it.
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  // Bullet points shown on the ticket card ("Marathon entry", "Finisher medal", ...) — what
  // the organizer is actually communicating beyond the category name and price. Nullable
  // rather than defaulted to '{}' at the entity level so "no benefits set" (an older row,
  // or a tier where the organizer skipped the field) is distinguishable from "explicitly
  // zero benefits" if that distinction is ever needed; callers should treat both as empty.
  @Column({ type: 'text', array: true, nullable: true })
  benefits?: string[];

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
