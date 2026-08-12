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
import { numericTransformer } from '../common/database/numeric.transformer';
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

  // Supplier GSTIN printed on the tax invoice (PaymentsService.getTaxInvoice). Nullable
  // because plenty of organizers are below the registration threshold and legitimately have
  // none — the invoice simply omits the line rather than showing a blank field.
  //
  // Exactly 15 characters by the statutory format: 2-digit state code, 10-char PAN,
  // 1-char entity number, 'Z', 1-char checksum. Stored uppercase (see UpdateOrganizerDto's
  // transform) so the printed value matches the registration certificate.
  @Column({ name: 'gstin', type: 'varchar', length: 15, nullable: true })
  gstin?: string;

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

  // NULL means "no negotiated rate — use the platform default" (config `platform.
  // commissionPercent`, currently 5%). An explicit value always wins, INCLUDING an explicit 0
  // for a commission-free partner. That distinction is the whole reason these are nullable
  // rather than `default: 0`: with a non-null default, "never configured" and "negotiated at
  // zero" are the same value and a platform default can never be applied to the former
  // without also overriding the latter.
  @Column({ name: 'commission_rate', type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: numericTransformer })
  commissionRate?: number | null;

  @Column({ name: 'commission_flat_fee', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: numericTransformer })
  commissionFlatFee?: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;
}
