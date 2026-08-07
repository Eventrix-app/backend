import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { BankAccountService } from './bank-account.service';
import { BankAccountStatus, BankAccountType } from '../../entities/organizer-bank-account.entity';
import { decryptField } from '../../common/crypto/field-encryption.util';

const VALID_KEY = Buffer.alloc(32, 3).toString('base64');

const validSubmission = {
  accountNumber: '50100123456789',
  confirmAccountNumber: '50100123456789',
  accountHolderName: 'Asha Rao',
  ifscCode: 'HDFC0000123',
  bankName: 'HDFC Bank',
  accountType: BankAccountType.SAVINGS,
};

describe('BankAccountService', () => {
  let service: BankAccountService;
  let bankRepo: any;
  let organizerRepo: any;
  let manager: any;
  let saved: any;

  const originalKey = process.env.BANK_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.BANK_ENCRYPTION_KEY = VALID_KEY;
    saved = undefined;
    manager = {
      update: jest.fn(),
      create: jest.fn((_e: any, data: any) => data),
      save: jest.fn((_e: any, data: any) => {
        saved = { id: 'acct-1', createdAt: new Date(), ...data };
        return Promise.resolve(saved);
      }),
    };
    bankRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((d: any) => Promise.resolve(d)),
    };
    organizerRepo = { findOne: jest.fn().mockResolvedValue({ id: 'org-1', userId: 'user-1' }) };
    service = new BankAccountService(bankRepo, organizerRepo, {
      transaction: (cb: any) => cb(manager),
    } as any);
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.BANK_ENCRYPTION_KEY;
    else process.env.BANK_ENCRYPTION_KEY = originalKey;
  });

  describe('submit', () => {
    it('encrypts the account number and holder name, storing only the last 4 in the clear', async () => {
      await service.submit('user-1', validSubmission as any);

      expect(saved.accountNumberEncrypted).not.toContain('50100123456789');
      expect(saved.accountHolderNameEncrypted).not.toContain('Asha');
      expect(decryptField(saved.accountNumberEncrypted)).toBe('50100123456789');
      expect(decryptField(saved.accountHolderNameEncrypted)).toBe('Asha Rao');
      expect(saved.accountNumberLast4).toBe('6789');
      // Routing information is public — an IFSC maps to a branch, not to a person.
      expect(saved.ifscCode).toBe('HDFC0000123');
    });

    // The only defence that exists against a mistyped account number: Indian account numbers
    // have no checksum, and a wrong one sends money to a stranger irreversibly.
    it('rejects a mismatched confirmation, server-side', async () => {
      await expect(
        service.submit('user-1', { ...validSubmission, confirmAccountNumber: '50100123456780' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    // Storing bank details unencrypted "for now" is never the fallback — a 503 is.
    it('refuses to store anything when the encryption key is unconfigured', async () => {
      delete process.env.BANK_ENCRYPTION_KEY;
      await expect(service.submit('user-1', validSubmission as any)).rejects.toThrow(ServiceUnavailableException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('rejects an account already active under a different organizer', async () => {
      bankRepo.findOne.mockResolvedValue({ id: 'other', organizerId: 'org-2' });
      await expect(service.submit('user-1', validSubmission as any)).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    // Replacing must deactivate, not overwrite: a payout made last month has to stay
    // traceable to the account it actually went to.
    it('deactivates the previous account in the same transaction as the insert', async () => {
      await service.submit('user-1', validSubmission as any);
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { organizerId: 'org-1', isActive: true },
        { isActive: false },
      );
      expect(saved.isActive).toBe(true);
    });

    // Otherwise an organizer could get one account approved and quietly swap in another.
    it('always starts a new submission at PENDING', async () => {
      await service.submit('user-1', validSubmission as any);
      expect(saved.status).toBe(BankAccountStatus.PENDING);
      expect(service['isPayoutReady'](saved)).toBe(false);
    });

    it('leaves PAN null when not supplied, and encrypts it when it is', async () => {
      await service.submit('user-1', validSubmission as any);
      expect(saved.panNumberEncrypted).toBeNull();

      await service.submit('user-1', { ...validSubmission, panNumber: 'ABCPD1234E' } as any);
      expect(decryptField(saved.panNumberEncrypted)).toBe('ABCPD1234E');
    });
  });

  describe('verification lifecycle', () => {
    const pendingAccount = () => ({
      id: 'acct-1',
      organizerId: 'org-1',
      status: BankAccountStatus.PENDING,
      isActive: true,
      accountNumberLast4: '6789',
      ifscCode: 'HDFC0000123',
      bankName: 'HDFC Bank',
      accountType: BankAccountType.SAVINGS,
      createdAt: new Date(),
    });

    // Admin approval proves the details match the KYC documents. It does NOT prove the
    // account exists or accepts money, so it must not by itself make the account payable.
    it('admin approval alone does not make an account payout-ready', async () => {
      bankRepo.findOne.mockResolvedValue(pendingAccount());
      const result = await service.approve('admin-1', 'acct-1');
      expect(result.status).toBe(BankAccountStatus.VERIFIED);
      expect(result.isPayoutReady).toBe(false);
    });

    it('becomes payout-ready only after the penny drop is confirmed', async () => {
      bankRepo.findOne.mockResolvedValue({ ...pendingAccount(), status: BankAccountStatus.VERIFIED });
      const result = await service.confirmPennyDrop('admin-1', 'acct-1', 'UTR123456');
      expect(result.status).toBe(BankAccountStatus.PENNY_DROP_VERIFIED);
      expect(result.isPayoutReady).toBe(true);
      expect(result.pennyDropAt).toBeTruthy();
    });

    // Otherwise the admin-review step could be skipped by jumping straight to the
    // stronger-sounding status.
    it('refuses a penny drop on an account that was never reviewed', async () => {
      bankRepo.findOne.mockResolvedValue(pendingAccount());
      await expect(service.confirmPennyDrop('admin-1', 'acct-1', 'UTR1')).rejects.toThrow(BadRequestException);
    });

    it('is idempotent — re-confirming a penny drop does not restamp it', async () => {
      const at = new Date('2026-01-01');
      bankRepo.findOne.mockResolvedValue({
        ...pendingAccount(),
        status: BankAccountStatus.PENNY_DROP_VERIFIED,
        pennyDropAt: at,
      });
      const result = await service.confirmPennyDrop('admin-1', 'acct-1', 'UTR-DIFFERENT');
      expect(result.pennyDropAt).toBe(at.toISOString());
      expect(bankRepo.save).not.toHaveBeenCalled();
    });

    it('records the rejection reason and keeps the account visible to the organizer', async () => {
      bankRepo.findOne.mockResolvedValue(pendingAccount());
      const result = await service.reject('admin-1', 'acct-1', 'Name does not match PAN');
      expect(result.status).toBe(BankAccountStatus.REJECTED);
      expect(result.rejectionReason).toBe('Name does not match PAN');
      expect(result.isPayoutReady).toBe(false);
    });
  });

  describe('getDecryptedForPayout', () => {
    it('refuses when the organizer has no account on file', async () => {
      bankRepo.findOne.mockResolvedValue(null);
      await expect(service.getDecryptedForPayout('org-1')).rejects.toThrow(/no bank account on file/);
    });

    // The gate that stops money reaching a plausible-looking but unverified account.
    it('refuses an account that has not completed the penny drop', async () => {
      bankRepo.findOne.mockResolvedValue({
        id: 'acct-1',
        status: BankAccountStatus.VERIFIED,
        isActive: true,
        accountNumberLast4: '6789',
      });
      await expect(service.getDecryptedForPayout('org-1')).rejects.toThrow(/requires a completed penny drop/);
    });

    it('returns the full destination once payout-ready', async () => {
      await service.submit('user-1', { ...validSubmission, panNumber: 'ABCPD1234E' } as any);
      bankRepo.findOne.mockResolvedValue({
        ...saved,
        status: BankAccountStatus.PENNY_DROP_VERIFIED,
        isActive: true,
      });

      const result = await service.getDecryptedForPayout('org-1');

      expect(result).toEqual({
        accountNumber: '50100123456789',
        accountHolderName: 'Asha Rao',
        ifscCode: 'HDFC0000123',
        bankName: 'HDFC Bank',
        accountType: BankAccountType.SAVINGS,
        panNumber: 'ABCPD1234E',
      });
    });

    // A payout path that swallowed a decryption failure would fall through to sending money
    // somewhere undefined.
    it('fails loudly rather than returning a partial destination when decryption breaks', async () => {
      await service.submit('user-1', validSubmission as any);
      bankRepo.findOne.mockResolvedValue({
        ...saved,
        status: BankAccountStatus.PENNY_DROP_VERIFIED,
        isActive: true,
        accountNumberEncrypted: 'v1:garbage:garbage:garbage',
      });
      await expect(service.getDecryptedForPayout('org-1')).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('getMine', () => {
    it('never exposes anything decryptable', async () => {
      await service.submit('user-1', validSubmission as any);
      bankRepo.findOne.mockResolvedValue(saved);

      const result = await service.getMine('user-1');

      expect(result).not.toBeNull();
      expect(JSON.stringify(result)).not.toContain('50100123456789');
      expect(JSON.stringify(result)).not.toContain('Asha');
      expect(result!.accountNumberLast4).toBe('6789');
    });

    it('returns null when nothing has been submitted', async () => {
      bankRepo.findOne.mockResolvedValue(null);
      expect(await service.getMine('user-1')).toBeNull();
    });
  });
});
