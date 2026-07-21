import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Event } from './event.entity';

@Entity('event_schedule_items')
export class EventScheduleItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  @Index()
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  // Free-text (not a timestamp) — schedule items are often relative/approximate ("Doors
  // open", "7:00 PM – 7:30 PM") rather than a single instant, matching how the previously
  // hardcoded MOCK_SCHEDULE modeled it.
  @Column({ type: 'varchar', length: 100 })
  time!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  // Organizer-controlled display order — not createdAt, since reordering an existing
  // schedule shouldn't require deleting and recreating items.
  @Column({ type: 'int', default: 0 })
  order!: number;
}
