#!/usr/bin/env node
'use strict';

/**
 * Applies pending migrations as part of a deploy.
 *
 * Exists because pushing only ever shipped code — the schema was a separate manual step that
 * was easy to forget, and forgetting it produced 500s on a live endpoint rather than a
 * failed deploy. Running here means a migration that cannot be applied fails the build
 * loudly, before the code that depends on it serves a single request.
 *
 * Runs from the compiled dist/ output rather than through ts-node. typeorm is a production
 * dependency with its own binary; ts-node is a devDependency, and a build that installs
 * production dependencies only would not have it. Depending on it here would make deploys
 * fail for a reason unrelated to the migrations themselves.
 *
 * Ordering note: this runs after `nest build`, so a compile error fails without ever opening
 * a database connection. Migrations must stay backward-compatible (additive) — between this
 * step and the new code going live, the previous version is still serving traffic against
 * the new schema.
 */

const { spawnSync } = require('child_process');

// Hides the password when logging which database is being migrated. The URL is worth
// printing — knowing *which* database a deploy touched matters when something goes wrong —
// but the credential in it is not.
function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

const vercelEnv = process.env.VERCEL_ENV;

// Preview and development builds must never migrate. On Vercel a preview inherits the same
// environment variables as production unless they are scoped otherwise, so without this a
// branch containing a new migration would apply it to the production database the moment
// anyone opened a pull request.
if (vercelEnv && vercelEnv !== 'production') {
  console.log(`[migrate] VERCEL_ENV=${vercelEnv} — skipping migrations (production only).`);
  process.exit(0);
}

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error(
    '[migrate] No MIGRATION_DATABASE_URL or DATABASE_URL is set for this build.\n' +
      '[migrate] Refusing to continue: a deploy that silently skips migrations is exactly\n' +
      '[migrate] the failure this script exists to prevent.',
  );
  process.exit(1);
}

const usingDedicated = !!process.env.MIGRATION_DATABASE_URL;
console.log(`[migrate] Target: ${redact(url)}`);
console.log(`[migrate] Source: ${usingDedicated ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'}`);

const result = spawnSync(
  'node',
  ['node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/data-source.js'],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
);

if (result.error) {
  console.error('[migrate] Could not start the TypeORM CLI:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  // Supabase's direct host (db.<ref>.supabase.co) resolves to IPv6 only, and CI builders
  // frequently have no IPv6 route - the connection then fails with ENETUNREACH against an
  // address the logs show but never explain. The fix is not a credential or a firewall
  // rule, it is a different host, so it is worth naming here rather than leaving the next
  // person to derive it from a raw errno.
  if (/db\.[a-z0-9]+\.supabase\.co/.test(url)) {
    console.error('');
    console.error('[migrate] Hint: this is the *direct* Supabase host, which is IPv6-only.');
    console.error('[migrate] Build machines commonly have no IPv6 route, which surfaces as');
    console.error('[migrate] ENETUNREACH against an address the log shows but never explains.');
    console.error('[migrate] Use the SESSION pooler instead: aws-0-<region>.pooler.supabase.com');
    console.error('[migrate] on port 5432. It is IPv4, and holds one backend session per');
    console.error('[migrate] connection so DDL behaves normally.');
    console.error('[migrate] Do NOT use the transaction pooler on 6543 - statements there can');
    console.error('[migrate] land on different sessions, which breaks migrations.');
  }

  console.error(
    `[migrate] Migrations failed (exit ${result.status}). Failing the build on purpose —\n` +
      '[migrate] deploying code whose schema was not applied is how a live endpoint starts\n' +
      '[migrate] returning 500s.',
  );
  process.exit(result.status ?? 1);
}

console.log('[migrate] Schema is up to date.');
