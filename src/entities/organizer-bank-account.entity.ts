import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Organizer } from './organizer.entity';

export enum BankAccountStatus {
  // Submitted by the organizer, awaiting admin review. The only status a self-service
  // submission can produce — an organizer can never mark their own account verified.
  PENDING = 'pending',
  // An admin checked the details against the organizer's KYC documents. Necessary but NOT
  // sufficient to pay out to: see PENNY_DROP below.
  VERIFIED = 'verified',
  // A ₹1 test transfer landed and was confirmed. THE gate for automated payouts — an admin
  // reading an account number off a form catches typos in the name but cannot tell whether
  // the account exists, is open, or belongs to the person claiming it.
  PENNY_DROP_VERIFIED = 'penny_drop_verified',
  // Admin rejected it (mismatch with KYC, unreadable, wrong holder). rejectionReason says why.
  REJECTED = 'rejected',
}

export enum BankAccountType {
  SAVINGS = 'savings',
  CURRENT = 'current',
}

// Where an organizer's payouts are sent.
//
// Modelled as its own table rather than columns on `organizers` for three reasons: the
// encrypted columns should not be loaded on every organizer read; an account has its own
// verification lifecycle independent of KYC; and history matters — when an organizer changes
// bank, the old row is deactivated rather than overwritten, so a past payout can always be
// traced to the account it actually went to.
@Entity('organizer_bank_accounts')
@Index(['organizerId', 'isActive'])
// One active account per organizer, enforced in the database rather than by application
// logic. Two active accounts is not a state any code here knows how to resolve — a payout
// would have to pick one, and picking wrong sends money to the wrong bank.
@Index(['organizerId'], { unique: true, where: `"is_active" = true` })
export class OrganizerBankAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organizer_id', type: 'uuid' })
  organizerId!: string;

  // RESTRICT, matching every other financially-sensitive relation in this schema. Payout
  // destinations must not vanish because a parent row was deleted.
  @ManyToOne(() => Organizer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organizer_id' })
  organizer!: Organizer;

  // --- Encrypted at rest (AES-256-GCM, see field-encryption.util.ts) ---
  //
  // `select: false` on all three: they are excluded from every findOne/find unless a query
  // explicitly asks for them, so an ordinary organizer lookup cannot accidentally serialise
  // an account number into an API response or a log line. The encryption protects the data
  // at rest in Supabase; this protects it from the application's own carelessness.

  @Column({ name: 'account_number_encrypted', type: 'text', select: false })
  accountNumberEncrypted!: string;

  @Column({ name: 'account_holder_name_encrypted', type: 'text', select: false })
  accountHolderNameEncrypted!: string;

  // The organizer's PAN NUMBER — distinct from Organizer.panOrAadhaarUrl, which is a scan.
  // An image cannot be submitted to a TDS filing; this can. Nullable because TDS withholding
  // is not implemented yet and requiring it now would block every organizer from onboarding.
  @Column({ name: 'pan_number_encrypted', type: 'text', nullable: true, select: false })
  panNumberEncrypted?: string | null;

  // --- Searchable / displayable derivatives ---

  // HMAC of (accountNumber + ifsc), for answering "is this same account already registered
  // to a different organizer?" without decrypting anything. Keyed, not a bare hash: an
  // account number has too little entropy to survive an unkeyed digest.
  @Column({ name: 'account_fingerprint', type: 'varchar', length: 64 })
  @Index()
  accountFingerprint!: string;

  // Stored in the clear on purpose — every bank and payment app displays the last four, and
  // masking them would make the UI unable to show an organizer which account is on file.
  @Column({ name: 'account_number_last4', type: 'varchar', length: 4 })
  accountNumberLast4!: string;

  // Public routing information, not a secret: IFSC codes are published by RBI and map to a
  // branch, not to a person. Kept plain so it can be validated and displayed directly.
  @Column({ name: 'ifsc_code', type: 'varchar', length: 11 })
  ifscCode!: string;

  @Column({ name: 'bank_name', type: 'varchar', length: 100 })
  bankName!: string;

  @Column({ name: 'branch_name', type: 'varchar', length: 100, nullable: true })
  branchName?: string | null;

  @Column({
    name: 'account_type',
    type: 'varchar',
    length: 20,
    enum: BankAccountType,
    default: BankAccountType.SAVINGS,
  })
  accountType!: BankAccountType;

  // --- Verification lifecycle ---

  @Column({
    name: 'status',
    type: 'varchar',
    length: 30,
    enum: BankAccountStatus,
    default: BankAccountStatus.PENDING,
  })
  status!: BankAccountStatus;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null;

  @Column({ name: 'verified_at', type: 'timestamp', nullable: true })
  verifiedAt?: Date | null;

  @Column({ name: 'verified_by_admin_id', type: 'uuid', nullable: true })
  verifiedByAdminId?: string | null;

  // --- Penny-drop (₹1 test transfer) ---
  //
  // Recorded separately from admin verification because they prove different things: an
  // admin proves the details match the KYC documents; a penny drop proves the account
  // actually exists and accepts money. Automated payout must require both.

  @Column({ name: 'penny_drop_reference', type: 'varchar', length: 100, nullable: true })
  pennyDropReference?: string | null;

  @Column({ name: 'penny_drop_at', type: 'timestamp', nullable: true })
  pennyDropAt?: Date | null;

  // False once superseded by a newer account. Rows are never deleted — a payout made months
  // ago has to remain traceable to the account it was actually sent to.
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
