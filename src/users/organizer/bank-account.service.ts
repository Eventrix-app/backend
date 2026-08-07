import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import {
  BankAccountStatus,
  BankAccountType,
  OrganizerBankAccount,
} from '../../entities/organizer-bank-account.entity';
import { Organizer } from '../../entities/organizer.entity';
import {
  FieldEncryptionError,
  decryptField,
  encryptField,
  fingerprintField,
  isFieldEncryptionConfigured,
} from '../../common/crypto/field-encryption.util';
import { SubmitBankAccountDto } from './dto/bank-account.dto';

// What an organizer (or an admin reviewing a list) may see. Deliberately carries NO
// decryptable material: the account number is reduced to its last four and the holder name
// is omitted entirely. Anything that needs the real values goes through
// getDecryptedForPayout(), which is separately gated and logged.
export interface BankAccountSummary {
  id: string;
  accountNumberLast4: string;
  ifscCode: string;
  bankName: string;
  branchName?: string | null;
  accountType: BankAccountType;
  status: BankAccountStatus;
  rejectionReason?: string | null;
  verifiedAt?: string | null;
  pennyDropAt?: string | null;
  isPayoutReady: boolean;
  createdAt: string;
}

// The full payout destination. Produced ONLY by getDecryptedForPayout().
export interface DecryptedBankAccount {
  accountNumber: string;
  accountHolderName: string;
  ifscCode: string;
  bankName: string;
  accountType: BankAccountType;
  panNumber?: string;
}

@Injectable()
export class BankAccountService {
  private readonly logger = new Logger(BankAccountService.name);

  constructor(
    @InjectRepository(OrganizerBankAccount)
    private readonly bankAccountsRepository: Repository<OrganizerBankAccount>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
    private readonly dataSource: DataSource,
  ) {}

  // An account is payable to only when BOTH checks have passed. They prove different things:
  // admin verification says the details match the KYC documents; a penny drop says the
  // account exists and accepts money. Neither implies the other, and sending a real payout
  // on the strength of just one is how money reaches a plausible-looking wrong account.
  private isPayoutReady(account: OrganizerBankAccount): boolean {
    return account.isActive && account.status === BankAccountStatus.PENNY_DROP_VERIFIED;
  }

  private toSummary(account: OrganizerBankAccount): BankAccountSummary {
    return {
      id: account.id,
      accountNumberLast4: account.accountNumberLast4,
      ifscCode: account.ifscCode,
      bankName: account.bankName,
      branchName: account.branchName,
      accountType: account.accountType,
      status: account.status,
      rejectionReason: account.rejectionReason,
      verifiedAt: account.verifiedAt?.toISOString() ?? null,
      pennyDropAt: account.pennyDropAt?.toISOString() ?? null,
      isPayoutReady: this.isPayoutReady(account),
      createdAt: account.createdAt.toISOString(),
    };
  }

  private async resolveOrganizerForUser(userId: string): Promise<Organizer> {
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) throw new NotFoundException('You do not have an organizer profile');
    return organizer;
  }

  /**
   * Submit (or replace) the organizer's payout bank account.
   *
   * Replacing does NOT overwrite: the previous row is deactivated and a new one inserted, so
   * a payout made last month remains traceable to the account it actually went to. The
   * partial unique index on (organizer_id) WHERE is_active enforces that exactly one is live.
   *
   * Every submission starts at PENDING regardless of what the previous account had achieved.
   * Carrying a verified status across a change would let an organizer get one account
   * approved and then quietly swap in another — which is the whole attack this guards.
   */
  async submit(userId: string, dto: SubmitBankAccountDto): Promise<BankAccountSummary> {
    if (!isFieldEncryptionConfigured()) {
      // 503, not 500: this is a deployment configuration gap, and the organizer can retry
      // once it is fixed. Storing the account unencrypted "for now" is never the fallback.
      throw new ServiceUnavailableException(
        'Bank account storage is not configured on this server (BANK_ENCRYPTION_KEY missing). No details were saved.',
      );
    }

    // Compared server-side. The client cannot be trusted to have done it, and this is the
    // only defence that exists against a mistyped account number — there is no checksum in
    // an Indian account number to validate against.
    if (dto.accountNumber !== dto.confirmAccountNumber) {
      throw new BadRequestException('Account number and confirmation do not match');
    }

    const organizer = await this.resolveOrganizerForUser(userId);
    const fingerprint = fingerprintField(`${dto.accountNumber}:${dto.ifscCode}`);

    // The same real-world account active under a DIFFERENT organizer. Legitimate reasons
    // exist (one person running two organizer profiles), so this is a conflict an admin
    // resolves rather than a hard security failure — but it must not pass silently, since
    // it is also what payout fraud looks like.
    const foreignActive = await this.bankAccountsRepository.findOne({
      where: { accountFingerprint: fingerprint, isActive: true, organizerId: Not(organizer.id) },
    });
    if (foreignActive) {
      this.logger.warn(
        `Organizer ${organizer.id} submitted a bank account already active for organizer ${foreignActive.organizerId}`,
      );
      throw new ConflictException(
        'This bank account is already registered to another organizer. Contact support if this is your account.',
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      // Deactivate first: the partial unique index rejects a second active row, so the
      // insert below would fail if this did not run in the same transaction.
      await manager.update(
        OrganizerBankAccount,
        { organizerId: organizer.id, isActive: true },
        { isActive: false },
      );

      const account = manager.create(OrganizerBankAccount, {
        organizerId: organizer.id,
        accountNumberEncrypted: encryptField(dto.accountNumber),
        accountHolderNameEncrypted: encryptField(dto.accountHolderName),
        panNumberEncrypted: dto.panNumber ? encryptField(dto.panNumber) : null,
        accountFingerprint: fingerprint,
        accountNumberLast4: dto.accountNumber.slice(-4),
        ifscCode: dto.ifscCode,
        bankName: dto.bankName,
        branchName: dto.branchName ?? null,
        accountType: dto.accountType ?? BankAccountType.SAVINGS,
        status: BankAccountStatus.PENDING,
        isActive: true,
      });
      return await manager.save(OrganizerBankAccount, account);
    });

    // Never log the account number, the holder name, or the fingerprint — the fingerprint is
    // keyed, but a log line pairing it with an organizer id rebuilds the lookup table an
    // attacker would otherwise need the key for.
    this.logger.log(`Organizer ${organizer.id} submitted bank account ${saved.id} (…${saved.accountNumberLast4})`);
    return this.toSummary(saved);
  }

  async getMine(userId: string): Promise<BankAccountSummary | null> {
    const organizer = await this.resolveOrganizerForUser(userId);
    const account = await this.bankAccountsRepository.findOne({
      where: { organizerId: organizer.id, isActive: true },
    });
    return account ? this.toSummary(account) : null;
  }

  // Admin review queue. Only PENDING accounts — verified and rejected ones are not awaiting
  // anything, and including them would make the queue never empty.
  async getPendingReview(): Promise<(BankAccountSummary & { organizerId: string; companyName: string })[]> {
    const accounts = await this.bankAccountsRepository.find({
      where: { status: BankAccountStatus.PENDING, isActive: true },
      relations: ['organizer'],
      order: { createdAt: 'ASC' },
    });
    return accounts.map((a) => ({
      ...this.toSummary(a),
      organizerId: a.organizerId,
      companyName: a.organizer?.companyName ?? 'Unknown',
    }));
  }

  /**
   * Admin review detail — includes the DECRYPTED holder name and full account number,
   * because an admin cannot check details against a KYC document without seeing them.
   *
   * This is the only read path besides payout that decrypts, and it is logged with the
   * reviewing admin's id. That log line is the audit trail: it is the difference between
   * "an admin looked at this account" being knowable and not.
   */
  async getForReview(adminUserId: string, accountId: string) {
    const account = await this.bankAccountsRepository.findOne({
      where: { id: accountId },
      relations: ['organizer'],
      select: {
        id: true,
        organizerId: true,
        accountNumberEncrypted: true,
        accountHolderNameEncrypted: true,
        panNumberEncrypted: true,
        accountNumberLast4: true,
        ifscCode: true,
        bankName: true,
        branchName: true,
        accountType: true,
        status: true,
        rejectionReason: true,
        verifiedAt: true,
        pennyDropAt: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    this.logger.log(`Admin ${adminUserId} viewed full bank details for account ${accountId}`);

    const decrypted = this.decryptOrThrow(account);
    return {
      ...this.toSummary(account),
      organizerId: account.organizerId,
      companyName: account.organizer?.companyName,
      accountNumber: decrypted.accountNumber,
      accountHolderName: decrypted.accountHolderName,
      panNumber: decrypted.panNumber,
    };
  }

  async approve(adminUserId: string, accountId: string): Promise<BankAccountSummary> {
    const account = await this.loadForStatusChange(accountId);
    if (account.status === BankAccountStatus.PENNY_DROP_VERIFIED) {
      // Already past this step — approving again would move it backwards.
      return this.toSummary(account);
    }
    if (account.status !== BankAccountStatus.PENDING) {
      throw new BadRequestException(`Bank account is ${account.status} and is not awaiting review`);
    }

    account.status = BankAccountStatus.VERIFIED;
    account.verifiedAt = new Date();
    account.verifiedByAdminId = adminUserId;
    account.rejectionReason = null;
    const saved = await this.bankAccountsRepository.save(account);
    this.logger.log(`Admin ${adminUserId} approved bank account ${accountId}; penny drop still required before payout`);
    return this.toSummary(saved);
  }

  async reject(adminUserId: string, accountId: string, reason: string): Promise<BankAccountSummary> {
    const account = await this.loadForStatusChange(accountId);
    account.status = BankAccountStatus.REJECTED;
    account.rejectionReason = reason;
    account.verifiedAt = null;
    account.verifiedByAdminId = adminUserId;
    // Deliberately left active. A rejected account is still the organizer's current
    // submission — it has to stay visible to them, with its reason, so they can correct it.
    // Payout is gated on status, not on isActive, so this is not payable.
    const saved = await this.bankAccountsRepository.save(account);
    this.logger.log(`Admin ${adminUserId} rejected bank account ${accountId}: ${reason}`);
    return this.toSummary(saved);
  }

  /**
   * Records that a ₹1 test transfer reached the account.
   *
   * The transfer itself is manual today — there is no disbursement integration to send it
   * with. This endpoint records a human's confirmation of a real UTR, which is honest: the
   * status says a penny drop happened, and one did.
   *
   * Requires VERIFIED first. Confirming a penny drop on an unreviewed account would let the
   * admin-review step be skipped entirely by going straight to the stronger-sounding status.
   */
  async confirmPennyDrop(adminUserId: string, accountId: string, reference: string): Promise<BankAccountSummary> {
    const account = await this.loadForStatusChange(accountId);
    if (account.status === BankAccountStatus.PENNY_DROP_VERIFIED) {
      return this.toSummary(account); // idempotent — a re-confirmation must not restamp
    }
    if (account.status !== BankAccountStatus.VERIFIED) {
      throw new BadRequestException(
        `Bank account must be admin-verified before a penny drop can be recorded (currently ${account.status})`,
      );
    }

    account.status = BankAccountStatus.PENNY_DROP_VERIFIED;
    account.pennyDropReference = reference;
    account.pennyDropAt = new Date();
    const saved = await this.bankAccountsRepository.save(account);
    this.logger.log(`Admin ${adminUserId} confirmed penny drop for account ${accountId} (ref ${reference})`);
    return this.toSummary(saved);
  }

  /**
   * THE payout read path. Returns the full destination, or throws with a reason it cannot.
   *
   * Everything a disbursement integration needs comes from here and nowhere else, so the
   * "is this account actually payable" question has exactly one answer in the codebase. It
   * is not wired to anything yet — no transfer integration exists — but building payout on
   * top of this rather than on raw entity access is what keeps the gating from being
   * reimplemented (differently) at the call site later.
   */
  async getDecryptedForPayout(organizerId: string): Promise<DecryptedBankAccount> {
    const account = await this.bankAccountsRepository.findOne({
      where: { organizerId, isActive: true },
      select: {
        id: true,
        organizerId: true,
        accountNumberEncrypted: true,
        accountHolderNameEncrypted: true,
        panNumberEncrypted: true,
        accountNumberLast4: true,
        ifscCode: true,
        bankName: true,
        accountType: true,
        status: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!account) {
      throw new BadRequestException(`Organizer ${organizerId} has no bank account on file`);
    }
    if (!this.isPayoutReady(account)) {
      throw new BadRequestException(
        `Organizer ${organizerId}'s bank account is ${account.status} — payout requires a completed penny drop`,
      );
    }

    this.logger.log(`Decrypted bank details for payout to organizer ${organizerId} (account …${account.accountNumberLast4})`);
    return {
      ...this.decryptOrThrow(account),
      ifscCode: account.ifscCode,
      bankName: account.bankName,
      accountType: account.accountType,
    };
  }

  private decryptOrThrow(account: OrganizerBankAccount): {
    accountNumber: string;
    accountHolderName: string;
    panNumber?: string;
  } {
    try {
      return {
        accountNumber: decryptField(account.accountNumberEncrypted),
        accountHolderName: decryptField(account.accountHolderNameEncrypted),
        panNumber: account.panNumberEncrypted ? decryptField(account.panNumberEncrypted) : undefined,
      };
    } catch (err) {
      if (err instanceof FieldEncryptionError) {
        // Either BANK_ENCRYPTION_KEY is missing/wrong, or the row was tampered with. Both
        // must stop the operation loudly — a payout path that swallows this would fall
        // through to sending money somewhere undefined.
        this.logger.error(`Cannot decrypt bank account ${account.id}: ${err.message}`);
        throw new ServiceUnavailableException('Bank account details could not be decrypted on this server');
      }
      throw err;
    }
  }

  private async loadForStatusChange(accountId: string): Promise<OrganizerBankAccount> {
    const account = await this.bankAccountsRepository.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Bank account not found');
    if (!account.isActive) {
      throw new ForbiddenException('This bank account has been superseded and can no longer be reviewed');
    }
    return account;
  }
}
