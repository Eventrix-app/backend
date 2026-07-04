import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  IsUrl,
} from 'class-validator';

export class UpdateParticipantDto {
  @IsOptional()
  @IsString()
  username!: string;

  @IsOptional()
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password!: string;

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

  @IsOptional()
  @IsBoolean()
  isActive!: boolean;
}
