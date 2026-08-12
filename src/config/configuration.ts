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
    // No fallback: Joi requires JWT_SECRET at boot, and a hardcoded one here would be a
    // landmine for anyone reading this nested key instead of the flat JWT_SECRET.
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '3600s',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:19006',
  googleMaps: {
    // Server-side only — proxied via GeocodeService rather than shipped in the bundle.
    // Restrict this one to the Geocoding API; the app-embedded key is a separate one.
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
  },
  razorpay: {
    // Unset until a real Razorpay account exists, so the service fails fast with a 503.
    // keyId is the public half; keySecret/webhookSecret never leave the server.
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  payu: {
    // Same fail-fast as razorpay above, so a hash never comes out wrong silently.
    // merchantKey is the public half; merchantSalt never leaves the server.
    merchantKey: process.env.PAYU_MERCHANT_KEY,
    merchantSalt: process.env.PAYU_MERCHANT_SALT,
    // The single test/production switch. The two overrides below exist so an operator never
    // has to infer which host a deployment talks to.
    baseUrl: process.env.PAYU_BASE_URL || 'https://test.payu.in',
    // Checkout and the refund API live on different production hosts and only coincide in
    // test mode, so one value cannot express both. Unset means derive from baseUrl.
    checkoutUrl: process.env.PAYU_CHECKOUT_URL,
    apiUrl: process.env.PAYU_API_URL,
  },
  tax: {
    // GST on the platform's COMMISSION, not the ticket price. Defaults to 0 so a deployment
    // without a GSTIN never starts collecting it; who funds it depends on event.feePayer.
    gstRate: Number(process.env.TAX_GST_RATE) || 0,
  },
  platform: {
    // Applies only when the organizer has no rate of their own. That column is nullable so
    // "never set" stays distinguishable from "negotiated at zero".
    commissionPercent: Number(process.env.PLATFORM_COMMISSION_PERCENT) || 5,

    // Free-event fee accrues as a platform receivable rather than being netted out of a
    // payment. NOTE: nothing collects it yet — recorded, not invoiced.
    freeEventFee: Number(process.env.PLATFORM_FREE_EVENT_FEE ?? 12.5),
  },
  gatewayFee: {
    // Blended default approximating the gateways' published rates. Estimates and settlement
    // read this same value so they cannot drift.
    percent: Number(process.env.GATEWAY_FEE_PERCENT) || 2,
    flat: Number(process.env.GATEWAY_FEE_FLAT) || 3,
  },
  refund: {
    windowHoursBeforeStart: Number(process.env.REFUND_WINDOW_HOURS) || 48,
  },
  payout: {
    delayDaysAfterEventEnd: Number(process.env.PAYOUT_DELAY_DAYS) || 3,
  },
  admin: {
    // Defence in depth over bootstrap()'s zero-admin check, which alone would reopen the
    // @Public() endpoint if every admin were removed. Unset means always reject.
    bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
  },
  cron: {
    // Verifies Vercel Cron's bearer header — @Cron() never fires on serverless, which has
    // no long-lived process to run it.
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
