import * as Joi from 'joi';

export const validateEnv = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    PORT: Joi.number().optional(),
    DATABASE_URL: Joi.string().optional(),
    DATABASE_URL_POOLER: Joi.string().optional(),
    DATABASE_HOST: Joi.string().optional(),
    DATABASE_PORT: Joi.number().optional(),
    DATABASE_USER: Joi.string().optional(),
    DATABASE_PASSWORD: Joi.string().optional(),
    DATABASE_NAME: Joi.string().optional(),
    // Required, not optional-with-a-fallback: configuration.ts used to default this to the
    // literal string 'change-this-secret' when unset, which is a guessable-secret landmine
    // (JwtAuthGuard itself already fails closed on a missing secret — the app should fail
    // the same way at boot, not silently hand out tokens signable/forgeable by anyone who
    // knows the source).
    JWT_SECRET: Joi.string().min(32).required(),
    JWT_EXPIRES_IN: Joi.string().optional(),
    // Secret mixed into every password hash (auth/password.util.ts). Required for the same
    // reason JWT_SECRET above is: an optional-with-a-fallback pepper is the worst of both
    // worlds — hashes that look protected but aren't, which then all stop verifying the
    // moment someone does set the variable. Failing at boot is the honest outcome.
    //
    // Generate with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    //
    // Treat it like a signing key: never commit it, never log it, and never change it once
    // accounts exist — rotating it invalidates every peppered hash, so a rotation has to be
    // staged as a new hash version rather than an edit to this value.
    PASSWORD_PEPPER: Joi.string().min(32).required(),
    // Opt-in only — enables the "123456" forgot-password OTP bypass in AuthService for
    // local testing without email configured. Must be explicitly set to the string
    // 'true'; anything else (including unset) keeps the bypass off. Never set this in a
    // real deployment.
    ALLOW_DEV_OTP_BYPASS: Joi.string().optional(),
    // Opt-in only — allows any http(s)://localhost[:port] origin through CORS, for Expo's
    // web dev server (which bumps ports on restart). Must be explicitly 'true'; unset keeps
    // it off, same fail-closed posture as ALLOW_DEV_OTP_BYPASS above.
    ALLOW_LOCALHOST_CORS: Joi.string().optional(),
    FRONTEND_URL: Joi.string().optional(),
    // Optional — until these are set, RazorpayService fails fast with a 503 rather than
    // the SDK erroring on the actual gateway calls. keyId is the public half of the pair.
    RAZORPAY_KEY_ID: Joi.string().optional(),
    RAZORPAY_KEY_SECRET: Joi.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
    // Optional — same fail-fast posture as RAZORPAY_* above: PayUService throws a clear 503
    // until these are set rather than silently producing a hash PayU will always reject.
    // PAYU_BASE_URL doubles as the test/production switch (see PayUService.isTestMode) —
    // anything containing "test" keeps checkout AND the refund API on their sandbox hosts.
    PAYU_MERCHANT_KEY: Joi.string().optional(),
    PAYU_MERCHANT_SALT: Joi.string().optional(),
    PAYU_BASE_URL: Joi.string().optional(),
    // Optional explicit host pins. Unset means "derive from PAYU_BASE_URL" (the default).
    // Origins only — PayUService appends the protocol paths itself.
    PAYU_CHECKOUT_URL: Joi.string().uri().optional(),
    PAYU_API_URL: Joi.string().uri().optional(),
    // GST rate (percent) applied to the platform's commission. Unset/0 keeps the entire GST
    // path inert — see configuration.ts's `tax.gstRate` comment for why that is the default
    // rather than 18.
    TAX_GST_RATE: Joi.number().min(0).max(100).optional(),
    GATEWAY_FEE_PERCENT: Joi.number().optional(),
    GATEWAY_FEE_FLAT: Joi.number().optional(),
    REFUND_WINDOW_HOURS: Joi.number().optional(),
    PAYOUT_DELAY_DAYS: Joi.number().optional(),
    SUPABASE_URL: Joi.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: Joi.string().optional(),
    CRON_SECRET: Joi.string().optional(),
    // Optional — see configuration.ts's `admin.bootstrapSecret` comment. Unset means the
    // bootstrap-the-first-admin endpoint always rejects rather than falling back to
    // "any unauthenticated caller may create an admin whenever the admin count is 0".
    ADMIN_BOOTSTRAP_SECRET: Joi.string().optional(),
    RESEND_API_KEY: Joi.string().optional(),
    EMAIL_FROM: Joi.string().optional(),
    // SMTP fallback transport (Nodemailer) — used only when Resend is unconfigured or a
    // send through it fails. All optional; unset means the fallback is simply unavailable.
    SMTP_HOST: Joi.string().optional(),
    SMTP_PORT: Joi.number().optional(),
    SMTP_SECURE: Joi.string().optional(),
    SMTP_USER: Joi.string().optional(),
    SMTP_PASS: Joi.string().optional(),
    SMTP_FROM: Joi.string().optional(),
    // Server-side only — powers GET /geocode/reverse (GeocodeService). Distinct from the
    // client-embedded key in Frontend/app.config.js, which authenticates native Maps SDK
    // tile rendering and is restricted differently (app package + SHA-1, not by API).
    GOOGLE_MAPS_API_KEY: Joi.string().optional(),
    EXPO_ACCESS_TOKEN: Joi.string().optional(),
    // Optional — only needed to make rate limiting work correctly across Vercel's
    // serverless containers (see RedisThrottlerStorageService). Falls back to in-memory
    // storage (correct for a single long-lived process) if unset.
    UPSTASH_REDIS_REST_URL: Joi.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: Joi.string().optional(),
    // Optional — error/crash reporting (see config/sentry.ts). Unset means Sentry's SDK
    // simply never sends anything, the same graceful-degradation pattern as every other
    // optional integration in this app (EmailService, UploadsService, PushService).
    SENTRY_DSN: Joi.string().optional(),
    SENTRY_ENVIRONMENT: Joi.string().optional(),
  }).unknown(true);

  const { error, value } = schema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });

  if (error) {
    throw new Error(`Config validation error: ${error.message}`);
  }

  return value as Record<string, unknown>;
};
