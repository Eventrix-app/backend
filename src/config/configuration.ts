export default () => ({
  port: Number(process.env.PORT) || 3000,
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT) || 5432,
    username: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'eventrix',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-this-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '3600s',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:19006',
  gatewayFee: {
    // Blended default approximating Razorpay/PayU's published rates (2% + flat ₹3/txn).
    // Organizer-facing "live payout estimate" and actual payment settlement both read
    // from this single config so the estimate never drifts from what's charged.
    percent: Number(process.env.GATEWAY_FEE_PERCENT) || 2,
    flat: Number(process.env.GATEWAY_FEE_FLAT) || 3,
  },
  refund: {
    windowHoursBeforeStart: Number(process.env.REFUND_WINDOW_HOURS) || 48,
  },
  payout: {
    delayDaysAfterEventEnd: Number(process.env.PAYOUT_DELAY_DAYS) || 3,
  },
  cron: {
    // Verifies Vercel Cron Jobs' `Authorization: Bearer <CRON_SECRET>` header (see
    // PaymentsController.triggerPayoutSweep + vercel.json's `crons` entry) — the
    // @Cron() decorator in PaymentsService never fires on Vercel's serverless model,
    // which has no long-lived process for it to run inside.
    secret: process.env.CRON_SECRET,
  },
  email: {
    // EmailService treats a missing key as "not configured" and no-ops (logs instead of
    // throwing) — same graceful-degradation pattern as CacheService/UploadsService, so a
    // local dev environment without a Resend key doesn't break auth/notifications entirely.
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
  },
});
