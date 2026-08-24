/**
 * Cache-key helpers for the users domain.
 *
 * Kept in a separate file so that modules outside the users domain
 * (e.g. AuthService) can import these constants without pulling in the
 * full UsersService, which would create a circular Node.js module dependency:
 *   auth.service → users.service → auth.service
 */

/**
 * Bump whenever CurrentUserResponse gains, loses, or renames a field.
 *
 * Without it, a deploy that adds a field keeps serving entries cached under the old shape
 * until they expire, and the client reads the new field as undefined. That is not merely a
 * cosmetic lag: Edit Profile prefills from this response, and PATCH /participants/:id treats
 * an explicitly-sent '' as "clear this field" — so a field missing from a stale entry can be
 * written back as empty. Adding gender/dateOfBirth/address to the response hit exactly this.
 *
 * Changing the version orphans every old entry instantly; they expire on their own TTL and
 * are never read again, since the key no longer matches.
 */
const USER_ME_SCHEMA_VERSION = 2;

export const userMeCacheKey = (userId: string): string =>
  `users:me:v${USER_ME_SCHEMA_VERSION}:${userId}`;
