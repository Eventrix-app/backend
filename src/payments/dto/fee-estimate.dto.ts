import { IsEnum, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { FeePayer } from '../../entities/event.entity';

export class FeeEstimateDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'ticketPrice must be a valid number' })
  @Min(0, { message: 'ticketPrice cannot be negative' })
  ticketPrice!: number;

  @IsOptional()
  @IsEnum(FeePayer, { message: 'Invalid fee payer' })
  feePayer?: FeePayer;

  // Defaults to the requesting user's own organizer profile when omitted.
  @IsOptional()
  @IsUUID()
  organizerId?: string;
}
