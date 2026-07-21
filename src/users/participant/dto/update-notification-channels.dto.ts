import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationChannelsDto {
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}
