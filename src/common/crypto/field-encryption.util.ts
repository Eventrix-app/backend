import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Authenticated field-level encryption for the small number of columns that hold money-
// movement secrets (organizer bank account numbers, PAN). Everything else in this schema is
// stored plainly and deliberately — this is not general-purpose "encrypt the database".
//
// AES-256-GCM, not CBC: GCM is authenticated, so a tampered ciphertext fails to decrypt
// rather than silently yielding attacker-influenced plaintext. That matters here because the
// decrypted value is fed straight to a payout API — an unauthenticated cipher would let
// anyone with write access to the DB redirect transfers by flipping bits in a column.
//
// The key lives in BANK_ENCRYPTION_KEY and nowhere else. It is intentionally NOT derived
// from JWT_SECRET or PASSWORD_PEPPER: rotating a signing key should never be able to make
// bank details undecryptable, and compromising one should not expose the other.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — the GCM standard nonce length
const VERSION = 'v1';

export class FieldEncryptionError extends Error {}

// Fail closed. A missing/short key must stop the operation, never fall back to storing
// plaintext or to a hardcoded default — either would produce a database that LOOKS encrypted
// while being trivially readable, which is worse than an honest outage.
function loadKey(): Buffer {
  const raw = process.env.BANK_ENCRYPTION_KEY;
  if (!raw) {
    throw new FieldEncryptionError(
      'BANK_ENCRYPTION_KEY is not set. Bank account details cannot be stored or read without it. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new FieldEncryptionError(
      `BANK_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). It must be base64 of 32 random bytes.`,
    );
  }
  return key;
}

export function isFieldEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

// Returns `v1:<iv>:<authTag>:<ciphertext>`, all base64. The version prefix exists so a future
// key rotation or algorithm change can decrypt old values while writing new ones — without
// it, rotation means an unreadable table.
export function encryptField(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptField(encoded: string): string {
  const key = loadKey();
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new FieldEncryptionError(`Unrecognised encrypted field format (expected ${VERSION}:iv:tag:ct)`);
  }
  const [, ivB64, tagB64, ctB64] = parts;
  // createDecipheriv and setAuthTag are INSIDE the try on purpose. Both throw a raw
  // TypeError on a malformed IV or auth tag ("Invalid authentication tag length: 5"), and a
  // corrupted row is exactly the case this function exists to handle — leaving them outside
  // let that escape as an unhandled 500 instead of the FieldEncryptionError every caller
  // is written to catch.
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Tag mismatch, or a structurally invalid envelope. Deliberately not distinguishing
    // which: the caller can do nothing different either way, and the detail is only useful
    // to someone probing the encryption.
    throw new FieldEncryptionError('Failed to decrypt field: ciphertext is corrupt or was encrypted with another key');
  }
}

// A deterministic, non-reversible fingerprint over a value, for equality checks that must
// work WITHOUT decrypting — "is this the same account already registered to someone else?"
//
// HMAC rather than a bare hash: an account number is a low-entropy value (a few billion
// possibilities), so a plain SHA-256 of it is brute-forceable in seconds. Keying it means an
// attacker with the database but not BANK_ENCRYPTION_KEY cannot enumerate.
//
// Not a substitute for encryptField — a fingerprint can be compared, never read back.
export function fingerprintField(value: string): string {
  const key = loadKey();
  return createHmac('sha256', key).update(value).digest('hex');
}

export function fingerprintMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
