import {
  IsOptional,
  IsString,
  MinLength,
  IsUrl,
} from 'class-validator';
import { IsAdult } from '../../../common/validators/is-adult.validator';

export class UpdateParticipantDto {
  @IsOptional()
  @IsString()
  username!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password!: string;

  // Required alongside `password` — proves the caller actually knows the current
  // password rather than just holding a valid access token, matching the dedicated
  // change-password flow (AuthService.changePassword). Checked in ParticipantService.update.
  @IsOptional()
  @IsString()
  currentPassword!: string;

  @IsOptional()
  @IsString()
  firstName!: string;

  @IsOptional()
  @IsString()
  lastName!: string;

  @IsOptional()
  @IsString()
  gender!: string;

  @IsOptional()
  @IsString()
  @IsAdult(18)
  dateOfBirth!: string;

  @IsOptional()
  @IsString()
  phone!: string;

  @IsOptional()
  @IsUrl()
  profileImageUrl!: string;

  @IsOptional()
  @IsString()
  addressType!: string;

  @IsOptional()
  @IsString()
  addressLine!: string;

  @IsOptional()
  @IsString()
  city!: string;

  @IsOptional()
  @IsString()
  state!: string;

  @IsOptional()
  @IsString()
  country!: string;

  @IsOptional()
  @IsString()
  pincode!: string;
}
