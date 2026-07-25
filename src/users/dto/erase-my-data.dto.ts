import { IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ReauthDto {
  @IsIn(['google', 'apple', 'facebook'])
  provider!: 'google' | 'apple' | 'facebook';

  @IsString()
  token!: string;
}

// Identity-verification proof required before UsersService.eraseMyData will act — a
// DPDP Act requirement (the erasure request must come verifiably from the account owner,
// not just from whoever is holding a valid access token). A password account proves this
// with currentPassword (same check as AuthService.changePassword); a social-only account
// (no password set) proves it by re-authenticating with the same provider it originally
// signed up with.
export class EraseMyDataDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReauthDto)
  reauth?: ReauthDto;
}
