import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class MarkPayoutPaidDto {
  // Required: a PAID row with no reference cannot be reconciled against a bank statement
  @IsString()
  @MinLength(3, { message: 'Transfer reference is too short to identify a real transfer' })
  @MaxLength(128)
  transferReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
