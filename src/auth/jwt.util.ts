export interface JwtPayload {
  id: string;
  email: string;
  roles: string[];
  full_name: string;
  // Standard JWT claim, added automatically by jwtService.sign()/verifyAsync() (seconds
  // since epoch) — never set explicitly when signing, only read back after verification
  // (see JwtAuthGuard's passwordChangedAt check).
  iat?: number;
}

// The user's session lasts as long as they keep using the app: POST /auth/refresh
// re-issues a token with a fresh 2-day expiry on every app foreground/launch (see
// AppStateSync in Frontend/App.tsx). If they don't reopen the app for 2+ days, nothing
// refreshes the old token, it expires server-side, and the next request 401s — which the
// frontend's global error handling turns into an automatic logout.
export const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 2;
