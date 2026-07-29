// Test-run environment defaults.
//
// PASSWORD_PEPPER is required at runtime (config/env.validation.ts) and password.util.ts
// deliberately throws rather than falling back when it is missing — a silently-absent pepper
// would produce hashes that look protected but aren't. Unit tests construct services
// directly instead of booting the Nest app, so nothing loads .env for them; this supplies
// the value the same way a real deployment's environment would.
//
// A fixed literal, not a random one: hashes must stay verifiable across the whole run, and a
// test that asserts a pepper mismatch (password.util.spec.ts) needs a known starting point.
// It is a test value only and is not the pepper any deployment should use.
process.env.PASSWORD_PEPPER =
  process.env.PASSWORD_PEPPER ?? 'test-only-pepper-not-for-any-real-deployment-0123456789';
