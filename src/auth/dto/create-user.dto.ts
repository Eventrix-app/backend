import { IsDateString, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
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

  // See LoginDto.deviceLabel.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceLabel?: string;
}
