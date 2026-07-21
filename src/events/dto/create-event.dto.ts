import {
  IsNotEmpty,
  IsString,
  IsUUID,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsDateString,
  Min,
  Max,
  IsUrl,
  IsEnum,
  IsInt,
  ValidateIf,
  Matches,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EventApprovalStatus, EventStatus, FeePayer } from '../../entities/event.entity';
import { CreateTicketTypeDto } from './create-ticket-type.dto';

export class CreateEventDto {
  @IsOptional()
  @IsUUID()
  organizerId?: string;

  @IsNotEmpty({ message: 'Event title is required' })
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  highlights?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  whoShouldAttend?: string[];

  @IsNotEmpty({ message: 'Category is required' })
  @IsUUID('4', { message: 'Invalid category ID format' })
  categoryId!: string;

  @IsNotEmpty({ message: 'Venue name is required' })
  @IsString()
  venueName!: string;

  @IsNotEmpty({ message: 'Venue address is required' })
  @IsString()
  venueAddress!: string;

  @IsOptional()
  @IsNumber({}, { message: 'Latitude must be a valid number' })
  @Min(-90, { message: 'Latitude must be between -90 and 90' })
  @Max(90, { message: 'Latitude must be between -90 and 90' })
  latitude?: number;

  @IsOptional()
  @IsNumber({}, { message: 'Longitude must be a valid number' })
  @Min(-180, { message: 'Longitude must be between -180 and 180' })
  @Max(180, { message: 'Longitude must be between -180 and 180' })
  longitude?: number;

  @IsNotEmpty({ message: 'Event date is required' })
  @IsDateString({}, { message: 'Invalid date format. Use YYYY-MM-DD' })
  eventDate!: string;

  // Nullable/omitted = single-day event (end defaults to eventDate). Multi-day events
  // (fests, conferences) set this explicitly. Must be >= eventDate — enforced in
  // EventsService alongside the other cross-field checks, not here. See loophole.md.
  @IsOptional()
  @IsDateString({}, { message: 'Invalid end date format. Use YYYY-MM-DD' })
  eventEndDate?: string;

  @IsNotEmpty({ message: 'Start time is required' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/, {
    message: 'Start time must be in HH:MM or HH:MM:SS format',
  })
  startTime!: string;

  @IsOptional()
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/, {
    message: 'End time must be in HH:MM or HH:MM:SS format',
  })
  endTime?: string;

  @IsOptional()
  @IsNumber({}, { message: 'Price must be a valid number' })
  @Min(0, { message: 'Price cannot be negative' })
  @Max(1000000, { message: 'Price cannot exceed 1,000,000' })
  pricePerTicket?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt({ message: 'Total capacity must be an integer' })
  @Min(1, { message: 'Total capacity must be at least 1' })
  @Max(1000000, { message: 'Total capacity cannot exceed 1,000,000' })
  totalCapacity?: number;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsBoolean()
  isOnline?: boolean;

  @ValidateIf((o) => o.isOnline === true)
  @IsNotEmpty({ message: 'Meeting link is required for online events' })
  @IsUrl({}, { message: 'Meeting link must be a valid URL' })
  meetingLink?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Image URL must be valid' })
  imageUrl?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Cover image URL must be valid' })
  coverImageUrl?: string;

  @IsOptional()
  @IsEnum(EventStatus, { message: 'Invalid event status' })
  status?: EventStatus;

  @IsOptional()
  @IsEnum(EventApprovalStatus, { message: 'Invalid approval status' })
  approvalStatus?: EventApprovalStatus;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ValidateIf((o) => o.pricePerTicket !== undefined && Number(o.pricePerTicket) > 0)
  @IsNotEmpty({ message: 'Refund policy type is required for paid events' })
  @IsString()
  refundPolicyType?: string;

  @IsOptional()
  @IsString()
  refundPolicyText?: string;

  @IsOptional()
  @IsInt({ message: 'Capacity must be an integer' })
  @Min(1, { message: 'Capacity must be at least 1' })
  capacity?: number;

  @IsOptional()
  @IsEnum(FeePayer, { message: 'Invalid fee payer' })
  feePayer?: FeePayer;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one ticket type is required when provided' })
  @ValidateNested({ each: true })
  @Type(() => CreateTicketTypeDto)
  ticketTypes?: CreateTicketTypeDto[];
}
