import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BankAccountType } from '../../../entities/organizer-bank-account.entity';

// Submitted by the organizer. Validated hard at the edge because a typo here does not
// produce an error — it produces a transfer to a stranger, and bank transfers are not
// reversible on request.
export class SubmitBankAccountDto {
  // Indian account numbers run 9–18 digits depending on the bank; there is no checksum to
  // verify against, which is exactly why a penny drop is required before automated payout.
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^\d{9,18}$/, { message: 'Account number must be 9 to 18 digits' })
  accountNumber!: string;

  // Confirmation field — the standard defence against a mistyped account number, since
  // nothing else can catch one. Compared server-side, never trusted to the client.
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @IsNotEmpty()
  confirmAccountNumber!: string;

  // Must match the name on the KYC document; the admin review step checks that.
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  accountHolderName!: string;

  // RBI format: 4 letters (bank), '0' (reserved), 6 alphanumerics (branch). Uppercased so a
  // lowercase submission does not produce a lookup miss later.
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'IFSC must be 11 characters: 4 letters, then 0, then 6 alphanumerics (e.g. SBIN0000001)',
  })
  ifscCode!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  bankName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  branchName?: string;

  @IsOptional()
  @IsEnum(BankAccountType)
  accountType?: BankAccountType;

  // The PAN NUMBER, not a scan of the card — Organizer.panOrAadhaarUrl already holds the
  // image, and an image cannot be filed against. Optional until TDS withholding ships;
  // requiring it now would block onboarding for a feature that does not exist yet.
  //
  // Format: 5 letters, 4 digits, 1 letter. The 4th letter encodes holder type ('P' for an
  // individual, 'C' company, 'H' HUF, ...), which is not validated here — a firm's PAN is
  // as legitimate as an individual's.
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{5}\d{4}[A-Z]$/, { message: 'PAN must be 10 characters: 5 letters, 4 digits, 1 letter' })
  panNumber?: string;
}

export class RejectBankAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

// Recorded by an admin after a ₹1 test transfer is confirmed received. The reference is the
// bank's UTR — the only durable evidence the transfer actually happened.
export class ConfirmPennyDropDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  reference!: string;
}
