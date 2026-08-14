import { IsDateString, IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsAdult } from '../../common/validators/is-adult.validator';

export class CreateUserDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  password!: string;

  @IsNotEmpty()
  @IsString()
  firstName!: string;

  @IsNotEmpty()
  @IsString()
  lastName!: string;

  @IsNotEmpty()
  @IsDateString()
  @IsAdult(18)
  dateOfBirth!: string;

  // Required at signup so checkout never has to stop and ask: PayU rejects a payment without
  // one, and collecting it mid-purchase sent users back to Edit Profile with a booking pending.
  @IsNotEmpty()
  @IsString()
  @Matches(/^\+?[\d][\d\s-]{8,16}$/, {
    message: 'Enter a valid mobile number',
  })
  phoneNumber!: string;

  // See LoginDto.deviceLabel.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceLabel?: string;
}
