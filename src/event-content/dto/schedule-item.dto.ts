import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateScheduleItemDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  time!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsInt()
  order?: number;
}

export class UpdateScheduleItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsInt()
  order?: number;
}
