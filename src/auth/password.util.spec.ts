import * as bcrypt from 'bcryptjs';
import {
  CURRENT_PASSWORD_HASH_VERSION,
  PASSWORD_HASH_V1_PLAIN_BCRYPT,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.util';

const PEPPER = 'test-pepper-at-least-32-chars-long-aaaaaa';

describe('password.util', () => {
  const originalPepper = process.env.PASSWORD_PEPPER;

  beforeEach(() => {
    process.env.PASSWORD_PEPPER = PEPPER;
  });

  afterAll(() => {
    if (originalPepper === undefined) delete process.env.PASSWORD_PEPPER;
    else process.env.PASSWORD_PEPPER = originalPepper;
  });

  describe('hashing', () => {
    it('round-trips a password it just hashed', async () => {
      // The regression this exists for: hashPassword returns { hash, version } and both must
      // be stored. Persisting the hash while letting the version fall back to the column
      // default marks a peppered hash as unpeppered, and the account can never log in.
      const { hash, version } = await hashPassword('correct horse battery staple');

      expect(version).toBe(CURRENT_PASSWORD_HASH_VERSION);
      await expect(
        verifyPassword('correct horse battery staple', hash, version),
      ).resolves.toBe(true);
    });

    it('rejects a wrong password', async () => {
      const { hash, version } = await hashPassword('right-password');
      await expect(verifyPassword('wrong-password', hash, version)).resolves.toBe(false);
    });

    it('salts: the same password hashed twice produces different hashes', async () => {
      const a = await hashPassword('same-password');
      const b = await hashPassword('same-password');

      expect(a.hash).not.toBe(b.hash);
      // ...and both still verify, because bcrypt carries its salt inside the hash string.
      await expect(verifyPassword('same-password', a.hash, a.version)).resolves.toBe(true);
      await expect(verifyPassword('same-password', b.hash, b.version)).resolves.toBe(true);
    });
  });

  describe('pepper', () => {
    it('will not verify a hash made under a different pepper', async () => {
      // The property the whole feature rests on: a stolen database is useless without the
      // pepper, which lives only in the environment. If this ever passes, the pepper is not
      // actually participating in the hash.
      const { hash, version } = await hashPassword('user-password');

      process.env.PASSWORD_PEPPER = 'a-completely-different-pepper-32-chars-xx';

      await expect(verifyPassword('user-password', hash, version)).resolves.toBe(false);
    });

    it('refuses to hash when no pepper is configured', async () => {
      // Failing loudly beats silently producing hashes that look protected and then all stop
      // verifying the moment someone sets the variable.
      delete process.env.PASSWORD_PEPPER;
      await expect(hashPassword('anything')).rejects.toThrow(/PASSWORD_PEPPER/);
    });

    it('is not defeated by bcrypt truncating input at 72 bytes', async () => {
      // Concatenating `password + pepper` would push the pepper outside bcrypt's 72-byte
      // window here, and would make these two passwords — identical for 80 characters —
      // hash to the same value. Pre-hashing with HMAC collapses any length to 44 base64
      // chars, so both problems disappear.
      const base = 'x'.repeat(80);
      const { hash, version } = await hashPassword(`${base}AAAA`);

      await expect(verifyPassword(`${base}BBBB`, hash, version)).resolves.toBe(false);
      await expect(verifyPassword(`${base}AAAA`, hash, version)).resolves.toBe(true);
    });
  });

  describe('versioning and upgrade', () => {
    it('still verifies pre-pepper (v1) hashes', async () => {
      // Existing accounts must keep working after the pepper ships — there is no way to
      // convert their hashes without the plaintext, so v1 verification cannot be dropped.
      const legacyHash = await bcrypt.hash('legacy-password', 10);

      await expect(
        verifyPassword('legacy-password', legacyHash, PASSWORD_HASH_V1_PLAIN_BCRYPT),
      ).resolves.toBe(true);
    });

    it('treats a null version as v1, for rows written before the column existed', async () => {
      const legacyHash = await bcrypt.hash('legacy-password', 10);

      await expect(verifyPassword('legacy-password', legacyHash, null)).resolves.toBe(true);
    });

    it('flags v1 for rehash and the current version as settled', () => {
      expect(needsRehash(PASSWORD_HASH_V1_PLAIN_BCRYPT)).toBe(true);
      expect(needsRehash(null)).toBe(true);
      expect(needsRehash(CURRENT_PASSWORD_HASH_VERSION)).toBe(false);
    });

    it('does not verify a v1 hash when it is mislabelled as v2', async () => {
      // Guards the failure mode the entity/create() bug produced: a version that disagrees
      // with how the hash was actually produced means nobody can log in.
      const legacyHash = await bcrypt.hash('legacy-password', 10);

      await expect(
        verifyPassword('legacy-password', legacyHash, CURRENT_PASSWORD_HASH_VERSION),
      ).resolves.toBe(false);
    });
  });
});
