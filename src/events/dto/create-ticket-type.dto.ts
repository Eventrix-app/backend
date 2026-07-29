import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Min,
  Max,
} from 'class-validator';
import { TicketCategory } from '../../entities/ticket-type.entity';

export class CreateTicketTypeDto {
  // No `name` field — the whole point of this enum is that a ticket type's label is not
  // organizer-chosen text. events.service.ts derives the stored name from `category` via
  // TICKET_CATEGORY_LABELS, so there is nothing here for a client to override it with.
  @IsEnum(TicketCategory, {
    message: `Ticket category must be one of: ${Object.values(TicketCategory).join(', ')}`,
  })
  category!: TicketCategory;

  @IsNumber({}, { message: 'Price must be a valid number' })
  @Min(0, { message: 'Price cannot be negative' })
  @Max(1000000, { message: 'Price cannot exceed 1,000,000' })
  price!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt({ message: 'Quantity total must be an integer' })
  @Min(1, { message: 'Quantity total must be at least 1' })
  quantityTotal?: number;

  // Bullet points on the ticket card. Capped at 6 — unlike About-tab lists (highlights,
  // whoShouldAttend), this renders on a fixed-height card alongside price/availability, and
  // an unbounded list would run the card off the bottom of its own container.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6, { message: 'A ticket type can list at most 6 benefits' })
  @IsString({ each: true })
  benefits?: string[];

  @IsOptional()
  @IsDateString()
  salesStartAt?: string;

  @IsOptional()
  @IsDateString()
  salesEndAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minPerOrder?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerOrder?: number;

  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;

  @IsOptional()
  @IsString()
  accessPassword?: string;
}
