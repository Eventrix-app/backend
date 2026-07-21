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
  googleMaps: {
    // Server-side only — GeocodeService proxies reverse-geocode requests through this key
    // rather than shipping it in the app bundle (see geocode.service.ts). A separate,
    // app-embedded key covers the native Maps SDK tile rendering itself (app.config.js),
    // which Google's own model requires to be client-side; that one should be restricted
    // to the app's package name + SHA-1 fingerprint in Google Cloud Console. This one
    // should be restricted by API (Geocoding API only) and, where possible, server IP.
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
  },
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
    // SMTP (Nodemailer) is a fallback transport, not a replacement — used only when Resend
    // is unconfigured or a send through it fails. All optional; EmailService treats a
    // missing/incomplete SMTP config the same way it treats a missing Resend key.
    smtp: {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'onboarding@resend.dev',
    },
  },
  push: {
    // Optional — Expo's push API works without one; only needed for enhanced push
    // security / higher rate limits (see PushService).
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
  },
});
