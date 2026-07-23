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

// Deliberately minimal — backs only the admin moderation queue (list/approve/remove).
// No likes/comments/feed-ranking tables: nothing in the app (RN's ShortsScreen is still
// fully mock) consumes a real creator-upload/feed API yet, so that larger surface is left
// for when it's actually needed.
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

  // A short may optionally tag the event it was filmed at — not required.
  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId?: string;

  @ManyToOne(() => Event, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event?: Event;

  // Private-bucket storage path, same convention as Organizer's *ProofUrl fields —
  // resolved to a signed read URL at render time, not a public URL.
  @Column({ name: 'media_url', type: 'text' })
  mediaUrl!: string;

  @Column({ name: 'thumbnail_url', type: 'text', nullable: true })
  thumbnailUrl?: string;

  @Column({ type: 'text', nullable: true })
  caption?: string;

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

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt?: Date;
}
