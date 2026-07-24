import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { User } from './user.entity';

// Replaces the old single `users.push_token` column — one row per device/app-install
// instead of one slot per account, so logging in on a second device no longer silently
// steals push notifications from the first (see migration for the backfill from the old
// column). `token` is globally unique: registering a token already held by someone else
// (e.g. a previous user of a shared/resold device) reassigns it via upsert rather than
// leaving two rows pointing at the same physical device.
@Entity('device_tokens')
@Unique(['token'])
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar' })
  token!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // Bumped every time this token is (re-)registered — e.g. on every login/app-launch, not
  // just the first time — so a stale/uninstalled device's token can eventually be told
  // apart from an actively-used one if that's ever needed (no automatic pruning yet).
  @UpdateDateColumn({ name: 'last_used_at' })
  lastUsedAt!: Date;
}
