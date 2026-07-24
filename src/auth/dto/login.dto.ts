import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @IsString()
  password!: string;

  // Best-effort client-supplied label (e.g. "iPhone 14 Pro · iOS 17.4") shown in
  // Settings → Active Sessions — optional so older app builds that don't send it still work.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceLabel?: string;
}
