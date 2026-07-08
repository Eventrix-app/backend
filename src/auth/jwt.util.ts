export interface JwtPayload {
  id: string;
  email: string;
  roles: string[];
  full_name: string;
}
