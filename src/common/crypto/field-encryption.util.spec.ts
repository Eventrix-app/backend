import {
  FieldEncryptionError,
  decryptField,
  encryptField,
  fingerprintField,
  fingerprintMatches,
  isFieldEncryptionConfigured,
} from './field-encryption.util';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('field encryption', () => {
  const original = process.env.BANK_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.BANK_ENCRYPTION_KEY = VALID_KEY;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.BANK_ENCRYPTION_KEY;
    else process.env.BANK_ENCRYPTION_KEY = original;
  });

  it('round-trips a value', () => {
    expect(decryptField(encryptField('50100123456789'))).toBe('50100123456789');
  });

  // A deterministic ciphertext would leak equality: anyone reading the table could tell which
  // organizers share an account without decrypting anything.
  it('produces different ciphertext for the same plaintext each time', () => {
    const a = encryptField('50100123456789');
    const b = encryptField('50100123456789');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(decryptField(b));
  });

  // The reason for GCM over CBC. A tampered ciphertext must fail loudly, because the
  // decrypted value is a payout destination — silently yielding attacker-influenced
  // plaintext would let anyone with DB write access redirect transfers.
  it('refuses to decrypt a tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptField('50100123456789').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptField([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow(FieldEncryptionError);
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptField('50100123456789');
    process.env.BANK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptField(encrypted)).toThrow(FieldEncryptionError);
  });

  it('rejects an unrecognised envelope format', () => {
    expect(() => decryptField('not-encrypted-at-all')).toThrow(FieldEncryptionError);
  });

  // Fail closed. A missing or wrong-length key must stop the operation — never fall through
  // to storing plaintext, which would produce a table that LOOKS encrypted but is not.
  it('fails closed when the key is missing', () => {
    delete process.env.BANK_ENCRYPTION_KEY;
    expect(isFieldEncryptionConfigured()).toBe(false);
    expect(() => encryptField('x')).toThrow(/BANK_ENCRYPTION_KEY is not set/);
  });

  it('fails closed when the key is the wrong length', () => {
    process.env.BANK_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(isFieldEncryptionConfigured()).toBe(false);
    expect(() => encryptField('x')).toThrow(/32 bytes/);
  });

  describe('fingerprint', () => {
    it('is stable for the same input and differs for a different one', () => {
      expect(fingerprintField('50100123456789:SBIN0000001')).toBe(fingerprintField('50100123456789:SBIN0000001'));
      expect(fingerprintField('50100123456789:SBIN0000001')).not.toBe(
        fingerprintField('50100123456780:SBIN0000001'),
      );
    });

    // Keyed, not a bare digest. An account number has only a few billion possibilities, so an
    // unkeyed SHA-256 of one is brute-forceable in seconds by anyone holding the table.
    it('changes entirely when the key changes', () => {
      const withKeyA = fingerprintField('50100123456789:SBIN0000001');
      process.env.BANK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
      expect(fingerprintField('50100123456789:SBIN0000001')).not.toBe(withKeyA);
    });

    it('compares equal fingerprints without a length-based false positive', () => {
      const fp = fingerprintField('50100123456789:SBIN0000001');
      expect(fingerprintMatches(fp, fp)).toBe(true);
      expect(fingerprintMatches(fp, fp.slice(0, -1))).toBe(false);
      expect(fingerprintMatches(fp, fingerprintField('other:IFSC000000'))).toBe(false);
    });
  });
});
