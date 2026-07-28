import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Short } from './short.entity';
import { User } from './user.entity';

/**
 * One row per account that has watched a reel — the record that makes view_count mean
 * "how many people watched this" rather than "how many times a player started".
 *
 * The unique constraint is the whole mechanism: recording a view is an INSERT that either
 * succeeds (a genuinely new viewer, so the counter moves) or violates the constraint (this
 * account has watched before, so it does not). Same idiom as ShortLike, and the same reason
 * — the database, not the client, decides what counts as a duplicate. A client-side guard
 * only lasts as long as the app process.
 *
 * Deliberately keyed by user, not device: a signed-out viewer has no identity to deduplicate
 * against, and counting by device would let the same person inflate a count by reinstalling.
 * Views are therefore only recorded for authenticated users.
 */
@Entity('short_views')
@Unique(['userId', 'shortId'])
export class ShortView {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'short_id', type: 'uuid' })
  shortId!: string;

  @ManyToOne(() => Short, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'short_id' })
  short!: Short;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
