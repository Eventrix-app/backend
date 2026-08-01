import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { setupSwagger } from './crud/swagger-helper';
import { initSentry } from './config/sentry';

// Last-resort net for any promise rejection that escapes its own try/catch (e.g. a
// fire-and-forget `void someAsyncCall()` at a call site that assumed the callee could
// never reject). Without this, Node's default behavior is to crash the whole process on
// an unhandled rejection — logging and surviving is strictly better for a long-running
// API server than taking down every in-flight request over one such bug.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection:', reason);
});

// Builds and configures the Nest app without binding a port, so the same setup can be
// reused by both the traditional long-running server (main.ts) and the Vercel serverless
// entrypoint (api/index.ts), which must never call app.listen().
export async function createApp(): Promise<NestExpressApplication> {
  // Before anything else — captures boot-time failures too (e.g. a bad provider), not
  // just request-time ones.
  initSentry();

  // rawBody: true exposes req.rawBody (the exact bytes received) alongside the normal
  // parsed req.body — needed by PaymentsController's webhook endpoint, which must verify
  // Razorpay's HMAC signature against the raw bytes it actually signed, not a
  // JSON.stringify(req.body) re-serialization that isn't guaranteed to match byte-for-byte.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Deployed serverless behind Vercel's edge proxy — without this, Express's req.ip
  // reflects the proxy's own socket rather than the real client, collapsing every user
  // onto one apparent IP and defeating per-IP throttling (login, OTP, enroll, etc.).
  // Trusting exactly one hop matches Vercel's single-proxy topology.
  app.set('trust proxy', 1);

  // Sets the standard hardening headers (X-Content-Type-Options, X-Frame-Options, HSTS,
  // etc.) that were previously entirely absent. CSP is left off: this app is primarily a
  // JSON API but does serve Swagger UI (/api/docs), which relies on inline scripts/styles
  // that helmet's default CSP blocks — enabling it would require hand-tuning a policy for
  // a page this app doesn't treat as security-sensitive today.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(app.get(HttpExceptionFilter));

  // Enable view engine
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.setViewEngine('hbs');

  app.setGlobalPrefix('api');

  // Enable CORS for frontend. Expo's web dev server doesn't run on a fixed port — it
  // bumps to the next free one (8082, 8083, ...) whenever 8081 is already taken by
  // another Metro instance, so a hardcoded single-port allowlist breaks on every restart
  // that happens to land on a different port. Any localhost/127.0.0.1 origin is allowed
  // for that reason, gated behind an explicit opt-in (not NODE_ENV — this app never
  // requires NODE_ENV to be set, per env.validation.ts, so inferring "dev" from its
  // absence would leave this silently live on any deployment that just never set it,
  // same reasoning as ALLOW_DEV_OTP_BYPASS above). FRONTEND_URL covers a deployed
  // (non-localhost) web build, e.g. in production, unconditionally.
  const allowLocalhostCors = process.env.ALLOW_LOCALHOST_CORS === 'true';
  const isLocalhostOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || (allowLocalhostCors && isLocalhostOrigin(origin)) || origin === process.env.FRONTEND_URL) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
    credentials: true,
  });

  // Setup Swagger API Documentation
  setupSwagger(app);

  return app;
}
