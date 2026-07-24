import * as Sentry from '@sentry/node';

// Error/crash reporting. Sentry.init() with dsn: undefined is documented, safe behavior —
// the SDK simply never sends anything, so this needs no manual "is it configured" branch
// the way EmailService/UploadsService do for their own optional integrations; SENTRY_DSN
// being unset just means every captureException() below silently no-ops.
//
// Called at the very top of createApp() (before NestFactory.create), so instrumentation
// is active for the whole app lifecycle in both the traditional server (main.ts) and the
// Vercel serverless entrypoint (api/index.ts) — both share createApp().
export function initSentry(): void {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
}

export { Sentry };
