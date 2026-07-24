import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './user.entity';

// One row per issued session (login/register/social login), not per request — the row's
// own id doubles as the JWT's `jti` claim (see jwt.util.ts), so a session can be looked up
// and individually revoked without needing a separate token blocklist. POST /auth/refresh
// reuses the same row (bumping lastSeenAt) rather than creating a new one, since it's
// re-issuing a token for an existing session (sliding TTL), not starting a new one — see
// AuthService.refresh().
@Entity('user_sessions')
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // Client-supplied best-effort label (e.g. "iPhone 14 Pro · iOS 17.4") — falls back to the
  // raw User-Agent header when the client doesn't send one (e.g. an older app build).
  @Column({ name: 'device_label', type: 'varchar', nullable: true })
  deviceLabel?: string | null;

  @Column({ name: 'user_agent', type: 'varchar', nullable: true })
  userAgent?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // Bumped only on POST /auth/refresh (once per app foreground/launch), not on every
  // authenticated request — an accurate-to-the-minute "last active" isn't worth a write on
  // every single API call.
  @Column({ name: 'last_seen_at', type: 'timestamp' })
  lastSeenAt!: Date;

  // Null while active. Revoked instead of deleted so a session that gets looked up between
  // "user revoked it" and "that device's next request" fails closed with a clear reason,
  // rather than a plain "not found" that's indistinguishable from a bad/forged jti.
  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt?: Date | null;
}
