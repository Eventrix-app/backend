import { createHmac } from 'crypto';
import * as bcrypt from 'bcryptjs';

/**
 * Password hashing for the whole app. Every hash/verify goes through here so the scheme,
 * the cost factor and the pepper cannot drift between AuthService, AdminService,
 * OrganizerService and ParticipantService — all four previously declared their own
 * BCRYPT_ROUNDS constant.
 *
 * The scheme is: bcrypt( base64( HMAC-SHA256(password, pepper) ) )
 *
 * Three layers, each doing a different job:
 *
 *  - **Salt** — bcrypt generates a fresh 128-bit random salt per password and embeds it in
 *    the output string. This was already correct; nothing here changes it. It is what stops
 *    one rainbow table from covering every user, and stops two users with the same password
 *    having the same hash.
 *
 *  - **Cost** — bcrypt's work factor, tuned so a single guess is expensive.
 *
 *  - **Pepper** — a secret that lives in the environment, never in the database. It is what
 *    the salt cannot do: a salt is stored *next to* the hash, so an attacker holding a
 *    database dump has it. The pepper is not in the dump, so a dump alone (leaked backup,
 *    SQL injection, a stolen read replica) cannot be cracked offline at all — not slowly,
 *    not with a wordlist, not ever, without also compromising the application environment.
 *    It buys nothing against an attacker who already owns the app server; it is specifically
 *    a defence against database-only compromise, which is the common breach shape.
 */

// HMAC first, rather than the more obvious `password + pepper` concatenation, for a reason
// that bites in practice: **bcrypt silently truncates its input at 72 bytes**. Concatenating
// would push the pepper partly or entirely outside that window for long passwords, quietly
// disabling it for exactly the users with the strongest passwords, and would make every
// password sharing its first 72 bytes hash identically. HMAC-SHA256 collapses any input to
// a fixed 32 bytes (44 base64 chars), so the pepper always participates and the truncation
// limit stops mattering at all.
//
// base64 rather than hex keeps it to 44 chars instead of 64 — still far under the limit,
// and neither encoding can produce the NUL byte that some bcrypt implementations treat as a
// string terminator.
function pepperPassword(plain: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plain, 'utf8').digest('base64');
}

/**
 * Hash schemes, tracked per user in `users.password_hash_version` so an existing row can be
 * verified under the scheme it was written with and upgraded in place on next login.
 *
 * 1 — bcrypt(password). Everything written before the pepper existed.
 * 2 — bcrypt(base64(HMAC-SHA256(password, pepper))). Current.
 */
export const PASSWORD_HASH_V1_PLAIN_BCRYPT = 1;
export const PASSWORD_HASH_V2_PEPPERED = 2;
export const CURRENT_PASSWORD_HASH_VERSION = PASSWORD_HASH_V2_PEPPERED;

// Unchanged from the four call sites this replaces. Deliberately not raised as part of
// introducing the pepper: bcryptjs is the pure-JS implementation and is several times
// slower than the native binding at the same cost factor, so a bump here costs real login
// latency on serverless and is a separate decision to make with measurements in hand.
const BCRYPT_ROUNDS = 10;

/**
 * Read lazily rather than at import time: ConfigModule populates process.env during Nest
 * bootstrap, which happens after this module is first imported. Reading at module scope
 * would capture `undefined` regardless of configuration.
 *
 * Throws rather than falling back to an empty/default pepper. A silently-absent pepper is
 * worse than no pepper at all — it produces hashes that look protected, and that all break
 * the moment someone does set the variable. This mirrors how JWT_SECRET is treated in
 * config/env.validation.ts, which is required for the same reason.
 */
function getPepper(): string {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) {
    throw new Error(
      'PASSWORD_PEPPER is not configured. Generate one with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"` ' +
        'and set it in the environment. It must never change once accounts exist — see ' +
        'password.util.ts for the rotation procedure.',
    );
  }
  return pepper;
}

export interface HashedPassword {
  hash: string;
  version: number;
}

/** Hashes a new or changed password under the current scheme. */
export async function hashPassword(plain: string): Promise<HashedPassword> {
  const prepared = pepperPassword(plain, getPepper());
  return {
    hash: await bcrypt.hash(prepared, BCRYPT_ROUNDS),
    version: CURRENT_PASSWORD_HASH_VERSION,
  };
}

/**
 * Verifies a password against a stored hash written under `version`.
 *
 * Always performs exactly one bcrypt comparison regardless of version, so verification cost
 * — and therefore response timing — does not reveal which scheme a given account is on.
 */
export async function verifyPassword(
  plain: string,
  storedHash: string,
  version: number | null | undefined,
): Promise<boolean> {
  // Rows predating the version column read as null; they are v1 by definition.
  if ((version ?? PASSWORD_HASH_V1_PLAIN_BCRYPT) === PASSWORD_HASH_V1_PLAIN_BCRYPT) {
    return bcrypt.compare(plain, storedHash);
  }
  return bcrypt.compare(pepperPassword(plain, getPepper()), storedHash);
}

/**
 * Whether a successful login should transparently re-hash under the current scheme.
 *
 * Upgrading can only happen at login, because it is the only moment the plaintext exists —
 * a v1 hash cannot be converted into a v2 hash without it. Accounts that never log in stay
 * on v1 indefinitely, which is why this returns a flag the caller acts on rather than
 * something a background job could ever do.
 */
export function needsRehash(version: number | null | undefined): boolean {
  return (version ?? PASSWORD_HASH_V1_PLAIN_BCRYPT) !== CURRENT_PASSWORD_HASH_VERSION;
}

/**
 * Burns roughly the same CPU as a real verification, for the "email does not exist" path.
 *
 * Kept here alongside the real comparison so the two can never drift in cost: the whole
 * point is that a caller cannot tell the difference from response latency.
 */
export async function burnPasswordCompare(plain: string, dummyHash: string): Promise<void> {
  // Pepper the input the same way a v2 verification would, so this path does the identical
  // HMAC + bcrypt work rather than skipping the HMAC. Falls back to a raw compare if the
  // pepper is unset, so a misconfiguration surfaces on the real login path (with a clear
  // error) rather than here on a path whose failure is silently swallowed.
  try {
    await bcrypt.compare(pepperPassword(plain, getPepper()), dummyHash);
  } catch {
    await bcrypt.compare(plain, dummyHash);
  }
}
