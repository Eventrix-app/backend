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

  @Column({ name: 'is_phone_verified', default: false })
  isPhoneVerified!: boolean;

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

  // Single-device Expo push token — re-registered on every app start/login, so the
  // latest device to call PATCH /users/me/push-token simply overwrites it. Multi-device
  // support (a device_tokens table) is a v2 concern, not needed for this rollout.
  @Column({ name: 'push_token', type: 'varchar', nullable: true })
  pushToken?: string | null;

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
