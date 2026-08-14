import { buildSslOptions } from './database.config';
import { SUPABASE_ROOT_CA } from './supabase-ca';

// This previously returned { rejectUnauthorized: false } for every remote host, leaving the
// connection encrypted but unauthenticated. These assert it cannot silently regress to that.
describe('buildSslOptions', () => {
  const originalCa = process.env.DATABASE_CA_CERT;

  afterEach(() => {
    if (originalCa === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = originalCa;
  });

  beforeEach(() => {
    delete process.env.DATABASE_CA_CERT;
  });

  it('always verifies the certificate', () => {
    for (const host of ['aws-1-ap-southeast-2.pooler.supabase.com', 'db.example.com', 'rds.amazonaws.com']) {
      expect(buildSslOptions(host).rejectUnauthorized).toBe(true);
    }
  });

  // Supabase signs its Postgres endpoints with a root no public CA store carries, so strict
  // verification against the system store fails with SELF_SIGNED_CERT_IN_CHAIN.
  it('pins the Supabase root for Supabase hosts', () => {
    for (const host of ['aws-1-ap-southeast-2.pooler.supabase.com', 'db.abcdefgh.supabase.co']) {
      expect(buildSslOptions(host).ca).toBe(SUPABASE_ROOT_CA);
    }
  });

  it('leaves other hosts on the system CA store', () => {
    expect(buildSslOptions('db.example.com').ca).toBeUndefined();
  });

  it('prefers DATABASE_CA_CERT over the pinned root, so a rotation needs no code change', () => {
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\nROTATED\n-----END CERTIFICATE-----';

    const options = buildSslOptions('aws-1-ap-southeast-2.pooler.supabase.com');

    expect(options.ca).toContain('ROTATED');
    expect(options.rejectUnauthorized).toBe(true);
  });

  // Env vars carry the escape sequence rather than real newlines, and PEM only parses with
  // actual line breaks — without this the override silently fails verification.
  it('turns escaped newlines in DATABASE_CA_CERT into real ones', () => {
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----';

    expect(buildSslOptions('db.example.com').ca).toBe(
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
    );
  });

  it('ships a Supabase root that is a parseable certificate', () => {
    expect(SUPABASE_ROOT_CA).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(SUPABASE_ROOT_CA).toMatch(/\n-----END CERTIFICATE-----$/);
  });
});
