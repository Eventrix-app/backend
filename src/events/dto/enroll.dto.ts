import { IsOptional, IsUUID, IsInt, Min } from 'class-validator';

export class EnrollDto {
  @IsOptional()
  @IsUUID()
  ticketTypeId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
