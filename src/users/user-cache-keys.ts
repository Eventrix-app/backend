/**
 * Cache-key helpers for the users domain.
 *
 * Kept in a separate file so that modules outside the users domain
 * (e.g. AuthService) can import these constants without pulling in the
 * full UsersService, which would create a circular Node.js module dependency:
 *   auth.service → users.service → auth.service
 */

export const userMeCacheKey = (userId: string): string => `users:me:${userId}`;
