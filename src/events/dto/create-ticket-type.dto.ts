import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsOptional,
  IsInt,
  IsDateString,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';

export class CreateTicketTypeDto {
  @IsNotEmpty({ message: 'Ticket type name is required' })
  @IsString()
  name!: string;

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
