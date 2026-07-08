import { IsBoolean } from 'class-validator';

export class UpdateNotificationPrefsDto {
  @IsBoolean()
  eventReminders!: boolean;

  @IsBoolean()
  nearbyEvents!: boolean;

  @IsBoolean()
  reelsAndCommunity!: boolean;

  @IsBoolean()
  specialOffers!: boolean;
}
