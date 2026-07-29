import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  ManyToMany,
  JoinTable,
} from 'typeorm';
import { Organizer } from './organizer.entity';
import { Enrollment } from './enrollment.entity';
import { AuthIdentity } from './auth-identity.entity';
import { EventCategory } from './category.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: 'full_name', type: 'varchar', nullable: true })
  fullName!: string;

  @Column({ name: 'phone_number', type: 'varchar', nullable: true })
  phoneNumber!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', nullable: true })
  passwordHash!: string;

  // Which scheme passwordHash was written with — 1 = bcrypt(password), 2 = bcrypt of the
  // peppered HMAC. Kept per row rather than assumed globally so introducing the pepper did
  // not require re-hashing (impossible without plaintext) or locking anyone out; a v1 row is
  // upgraded in place on its owner's next successful login. See auth/password.util.ts.
  @Column({ name: 'password_hash_version', type: 'smallint', default: 1 })
  passwordHashVersion!: number;

  // Set on every successful password change/reset — JwtAuthGuard compares this against the
  // token's `iat` claim so a still-valid access token minted before the most recent
  // password change stops working immediately, instead of remaining usable for its full
  // ~2-day TTL after the account owner (or an attacker) changes the password.
  @Column({ name: 'password_changed_at', type: 'timestamp', nullable: true })
  passwordChangedAt?: Date | null;

  @Column({ name: 'profile_picture_url', type: 'varchar', nullable: true })
  profilePictureUrl!: string;

  @Column({ type: 'varchar', nullable: true })
  bio!: string;

  @Column({ type: 'varchar', nullable: true })
  location!: string;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  latitude!: number;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  longitude!: number;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth!: string;

  @Column({ type: 'varchar', nullable: true })
  gender!: string;

  @Column({ type: 'jsonb', default: ['user'] })
  roles!: string[];

  @Column({ name: 'is_email_verified', default: false })
  isEmailVerified!: boolean;

  @Column({ name: 'is_banned', default: false })
  isBanned!: boolean;

  // Set once the pre-auth onboarding chain (carousel + interest selection + location +
  // notification prefs) has been completed for this account — reaching Register in the
  // app's current flow already implies this, so it's set unconditionally at register
  // time. Persisted server-side (not just on-device) so it never re-shows for this
  // account on any device, per product decision — only resets if the account itself is
  // deleted and recreated.
  @Column({ name: 'has_completed_onboarding', default: false })
  hasCompletedOnboarding!: boolean;

  @Column({ name: 'banned_reason', type: 'text', nullable: true })
  bannedReason?: string;

  // Master on/off switches surfaced by SettingsScreen's "Push Notifications"/"Email
  // Notifications" toggles — distinct from notificationPrefs below, which is a set of
  // onboarding content categories. These gate every transactional notification
  // (event_changed/waitlist_promoted/refund_status) regardless of type; see
  // NotificationService.sendPushForJob/sendEmailForJob.
  @Column({ name: 'push_enabled', type: 'boolean', default: true })
  pushEnabled!: boolean;

  @Column({ name: 'email_enabled', type: 'boolean', default: true })
  emailEnabled!: boolean;

  @Column({
    name: 'notification_prefs',
    type: 'jsonb',
    nullable: true,
    default: () => `'{"eventReminders":true,"nearbyEvents":true,"reelsAndCommunity":true,"specialOffers":true}'`,
  })
  notificationPrefs!: {
    eventReminders: boolean;
    nearbyEvents: boolean;
    reelsAndCommunity: boolean;
    specialOffers: boolean;
  } | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;

  // Set by UsersService.eraseMyData (Settings → Delete My Data) — distinct from deletedAt
  // (soft deactivation, reversible in principle). true means this row's directly-personal
  // columns (name/email/phone/etc.) have been scrubbed/pseudonymized; the row itself is
  // kept because statutorily-retained records (bookings/payments/refunds/payouts) still
  // hold a live FK to it. See DPDP Act erasure policy in project memory.
  @Column({ name: 'is_erased', type: 'boolean', default: false })
  isErased!: boolean;

  @OneToMany(() => Organizer, (organizer) => organizer.user)
  organizers!: Organizer[];

  @OneToMany(() => Enrollment, (enrollment) => enrollment.user)
  enrollments!: Enrollment[];

  @OneToMany(() => AuthIdentity, (identity) => identity.user)
  authIdentities!: AuthIdentity[];

  @ManyToMany(() => EventCategory)
  @JoinTable({
    name: 'user_interests',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  interests!: EventCategory[];
}
