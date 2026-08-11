import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class MarkPayoutPaidDto {
  // Required in practice, and deliberately so: confirming a payout PAID without recording
  // what settled it produces a row that says money moved with nothing to prove it. The one
  // field an organizer will ask for when a credit is missing is exactly this one.
  @IsString()
  @MinLength(3, { message: 'Transfer reference is too short to identify a real transfer' })
  @MaxLength(128)
  transferReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
