import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Event } from './event.entity';

export enum EventMediaType {
  IMAGE = 'image',
  VIDEO = 'video',
}

// Gallery items for an event's EventDetailsScreen carousel — the cover image itself stays
// on Event.coverImageUrl; this table only holds the additional images/videos shown after it.
@Entity('event_media')
@Index(['eventId'])
export class EventMedia {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, (event) => event.media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  @Column({ type: 'varchar', length: 10, enum: EventMediaType })
  type!: EventMediaType;

  @Column({ type: 'text' })
  url!: string;

  // Carousel display order — ascending, gaps allowed (no reindex on delete).
  @Column({ type: 'int', default: 0 })
  position!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
