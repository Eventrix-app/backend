import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Event } from './event.entity';
import { User } from './user.entity';

export enum VerificationLevel {
  UNVERIFIED = 'unverified',
  EMAIL_VERIFIED = 'email_verified',
  PHONE_VERIFIED = 'phone_verified',
  DOCUMENT_VERIFIED = 'document_verified',
}

@Entity('organizers')
export class Organizer {
  @OneToMany(() => Event, (event) => event.organizer)
  events!: Event[];

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  // RESTRICT, not CASCADE — matches every other financially-sensitive relation in this
  // schema (Enrollment.user/event, Payment/Refund/Payout.*). A hard DELETE of a user row
  // should fail loudly rather than silently cascade-deleting their Organizer profile (and,
  // in turn, every Event they own via Event.organizer below) — nothing in this app hard-
  // deletes users today (see UsersService.deleteMe/eraseMyData, both soft/pseudonymizing),
  // but a future ops script or GDPR-erasure path must not be able to destroy event data
  // this way. See migration PartialUniqueIndexesAndCascadeFix.
  @ManyToOne(() => User, (user) => user.organizers, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'company_name', type: 'varchar' })
  companyName!: string;

  @Column({ name: 'company_description', type: 'varchar', nullable: true })
  companyDescription!: string;

  @Column({ name: 'company_website', type: 'varchar', nullable: true })
  companyWebsite!: string;

  @Column({ name: 'company_logo_url', type: 'varchar', nullable: true })
  companyLogoUrl!: string;

  // --- KYC verification (see #7: an unverified user must not be able to organize events) ---

  @Column({ name: 'full_name', type: 'varchar', nullable: true })
  fullName!: string;

  @Column({ name: 'identity_proof_url', type: 'varchar', nullable: true })
  identityProofUrl!: string;

  @Column({ name: 'address_proof_url', type: 'varchar', nullable: true })
  addressProofUrl!: string;

  // Either a PAN card or Aadhaar card image — one combined field since the app only
  // requires one of the two as government ID, not both.
  @Column({ name: 'pan_or_aadhaar_url', type: 'varchar', nullable: true })
  panOrAadhaarUrl!: string;

  @Column({ name: 'upi_id', type: 'varchar', nullable: true })
  upiId!: string;

  // Set when the organizer (re)submits their KYC documents for review, cleared on
  // rejection so `submittedForReviewAt == null` unambiguously means "nothing pending" —
  // distinct from verificationLevel, which only flips once an admin actually approves.
  @Column({ name: 'submitted_for_review_at', type: 'timestamp', nullable: true })
  submittedForReviewAt!: Date;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string;

  /** @deprecated superseded by verificationLevel; kept for backward compat / rollback safety. */
  @Column({ default: false })
  verified!: boolean;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt!: Date;

  @Column({
    name: 'verification_level',
    type: 'varchar',
    length: 20,
    enum: VerificationLevel,
    default: VerificationLevel.UNVERIFIED,
  })
  verificationLevel!: VerificationLevel;

  @Column({ name: 'auto_approve_events', type: 'boolean', default: false })
  autoApproveEvents!: boolean;

  @Column({ name: 'commission_rate', type: 'decimal', precision: 5, scale: 2, default: 0 })
  commissionRate!: number;

  @Column({ name: 'commission_flat_fee', type: 'decimal', precision: 10, scale: 2, default: 0 })
  commissionFlatFee!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;
}
