import { IsOptional, IsString } from 'class-validator';

export class RemoveShortDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
