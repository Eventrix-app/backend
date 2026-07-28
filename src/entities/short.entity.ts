import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { Event } from './event.entity';

export enum ShortModerationStatus {
  UNDER_REVIEW = 'under_review',
  PUBLISHED = 'published',
  FLAGGED = 'flagged',
  REMOVED = 'removed',
}

// Backs the creator upload/feed flow (create/list-mine/delete/like) plus the admin
// moderation queue (list/approve/remove). Comments/feed-ranking are still deferred —
// see the "Explicitly out of scope" note in the reels backend plan.
@Entity('shorts')
@Index(['moderationStatus'])
export class Short {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'uploader_user_id', type: 'uuid' })
  uploaderUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uploader_user_id' })
  uploader!: User;

  // Every reel belongs to exactly one event — uploads always launch from an event
  // context (see the Reel Upload screen design), so this is required, not a loose tag.
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  // CASCADE, not RESTRICT — a reel has no meaning once its event is gone, unlike a
  // financial record. Matches EventMedia.event's CASCADE for the same reasoning.
  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  // Public-bucket URL (event-images bucket, reels/ prefix) — the Shorts feed reads this
  // table directly via the Supabase client with no backend round-trip, so this must be
  // a directly playable public URL, not a private path needing a signed read URL.
  @Column({ name: 'media_url', type: 'text' })
  mediaUrl!: string;

  @Column({ name: 'thumbnail_url', type: 'text', nullable: true })
  thumbnailUrl?: string;

  @Column({ type: 'text', nullable: true })
  caption?: string;

  // Where the reel was shot, as chosen by the uploader — seeded from their own device
  // position and re-pinnable on a map before sharing. Distinct from the event's venue
  // coordinates (already reachable via event_id): a reel is often filmed somewhere other
  // than the venue's exact pin, and attributing it to the venue would be a claim the
  // uploader never made. Nullable throughout — declining location permission must not
  // block posting, and a name with no coordinates (or the reverse) is a legitimate
  // partial result from reverse geocoding.
  @Column({ name: 'location_name', type: 'text', nullable: true })
  locationName?: string;

  // Same precision/scale as Event.latitude/longitude so the two are directly comparable.
  @Column({ type: 'decimal', precision: 10, scale: 8, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  longitude?: number;

  @Column({
    name: 'moderation_status',
    type: 'varchar',
    length: 20,
    enum: ShortModerationStatus,
    default: ShortModerationStatus.UNDER_REVIEW,
  })
  moderationStatus!: ShortModerationStatus;

  @Column({ name: 'flag_reason', type: 'text', nullable: true })
  flagReason?: string;

  @Column({ name: 'view_count', type: 'int', default: 0 })
  viewCount!: number;

  // Denormalized, kept in sync by ShortsService.like()/unlike() via an atomic
  // UPDATE ... WHERE ... claim (same idiom as ticket-capacity claims elsewhere) —
  // a live COUNT() per feed row isn't practical once the feed reads directly via
  // the Supabase client with no backend round-trip per row.
  @Column({ name: 'like_count', type: 'int', default: 0 })
  likeCount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt?: Date;
}
