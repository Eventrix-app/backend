import { IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsNotEmpty()
  @IsString()
  @Length(6, 6)
  otp!: string;
}
