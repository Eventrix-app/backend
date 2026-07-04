export class AuthResponseDto {
  accessToken!: string;
  id!: string;
  email!: string;
  full_name!: string;
  role!: string;
  expiresIn?: number;
}
