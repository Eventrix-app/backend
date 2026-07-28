import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Short } from './short.entity';
import { User } from './user.entity';

// A comment on a reel.
//
// Flat, not threaded: replies would need a parent_id, a depth cap and a rendering strategy
// for nesting, and the feed's comment sheet has no affordance for any of that. A flat list
// is what the UI actually shows, so that is what is stored.
@Entity('short_comments')
// The one query this table serves is "newest comments for this reel", so the index matches
// it exactly rather than indexing short_id alone and leaving the sort to a heap scan.
@Index(['shortId', 'createdAt'])
export class ShortComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'short_id', type: 'uuid' })
  shortId!: string;

  // CASCADE — a comment has no meaning once the reel it is on is gone, same reasoning as
  // ShortLike and EventMedia.
  @ManyToOne(() => Short, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'short_id' })
  short!: Short;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // Soft delete, unlike ShortLike which is hard-deleted on unlike. A like is a toggle with
  // no content; a comment is authored text, and moderation needs to be able to look at what
  // was said after it was removed.
  @DeleteDateColumn({ name: 'deleted_at' })
  deletedAt?: Date;
}
