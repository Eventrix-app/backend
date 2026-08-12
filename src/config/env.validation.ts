import * as Joi from 'joi';

export const validateEnv = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    // Declared (not just allowed through by .unknown) because CRON_SECRET's conditional
    // requirement below references it — Joi resolves sibling refs against schema keys.
    NODE_ENV: Joi.string().optional(),
    PORT: Joi.number().optional(),
    DATABASE_URL: Joi.string().optional(),
    DATABASE_URL_POOLER: Joi.string().optional(),
    DATABASE_HOST: Joi.string().optional(),
    DATABASE_PORT: Joi.number().optional(),
    DATABASE_USER: Joi.string().optional(),
    DATABASE_PASSWORD: Joi.string().optional(),
    DATABASE_NAME: Joi.string().optional(),
    // Required, not optional-with-a-fallback: this used to default to a literal string,
    // making every token forgeable by anyone who read the source.
    JWT_SECRET: Joi.string().min(32).required(),
    JWT_EXPIRES_IN: Joi.string().optional(),
    // Secret mixed into every password hash. Required for the same reason as JWT_SECRET, and
    // never rotate it once accounts exist — that invalidates every peppered hash.
    PASSWORD_PEPPER: Joi.string().min(32).required(),
    // Opt-in only: enables the "123456" forgot-password bypass for local testing. Must be
    // exactly 'true'; unset keeps it off. Never set in a real deployment.
    ALLOW_DEV_OTP_BYPASS: Joi.string().optional(),
    // Opt-in only: allows any localhost origin through CORS for Expo's web dev server.
    // Fail-closed when unset, same as ALLOW_DEV_OTP_BYPASS.
    ALLOW_LOCALHOST_CORS: Joi.string().optional(),
    FRONTEND_URL: Joi.string().optional(),
    // Optional — until these are set, RazorpayService fails fast with a 503 rather than
    // the SDK erroring on the actual gateway calls. keyId is the public half of the pair.
    RAZORPAY_KEY_ID: Joi.string().optional(),
    RAZORPAY_KEY_SECRET: Joi.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
    // Optional, same fail-fast as RAZORPAY_*: a 503 beats silently producing a hash PayU
    // rejects. PAYU_BASE_URL doubles as the test/production switch.
    PAYU_MERCHANT_KEY: Joi.string().optional(),
    PAYU_MERCHANT_SALT: Joi.string().optional(),
    PAYU_BASE_URL: Joi.string().optional(),
    // Optional explicit host pins. Unset means "derive from PAYU_BASE_URL" (the default).
    // Origins only — PayUService appends the protocol paths itself.
    PAYU_CHECKOUT_URL: Joi.string().uri().optional(),
    PAYU_API_URL: Joi.string().uri().optional(),
    // Unset or 0 keeps the whole GST path inert — see configuration.ts for why that is the
    // default rather than 18.
    TAX_GST_RATE: Joi.number().min(0).max(100).optional(),
    // Platform default commission (percent) for organizers with no negotiated rate, and the
    // flat fee charged per free-event booking. See configuration.ts's `platform` block.
    PLATFORM_COMMISSION_PERCENT: Joi.number().min(0).max(100).optional(),
    PLATFORM_FREE_EVENT_FEE: Joi.number().min(0).optional(),
    GATEWAY_FEE_PERCENT: Joi.number().optional(),
    GATEWAY_FEE_FLAT: Joi.number().optional(),
    REFUND_WINDOW_HOURS: Joi.number().optional(),
    PAYOUT_DELAY_DAYS: Joi.number().optional(),
    SUPABASE_URL: Joi.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: Joi.string().optional(),
    // Required in production: @Cron() never fires on serverless, so the secret-guarded
    // endpoint is the real trigger. Unset meant organizers silently went unpaid.
    CRON_SECRET: Joi.string().when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .required()
        .messages({
          'any.required':
            'CRON_SECRET is required in production — without it the T+3 payout sweep can never run and organizers are never paid. ' +
            'Set it in the Vercel project environment (Vercel attaches it as `Authorization: Bearer <CRON_SECRET>` on cron invocations).',
        }),
      otherwise: Joi.string().optional(),
    }),
    // Unset means the bootstrap-first-admin endpoint always rejects, rather than opening to
    // any caller whenever the admin count is 0.
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
    // Server-side only, for GET /geocode/reverse. Distinct from the client-embedded Maps key,
    // which is restricted by package + SHA-1 instead.
    GOOGLE_MAPS_API_KEY: Joi.string().optional(),
    EXPO_ACCESS_TOKEN: Joi.string().optional(),
    // Only needed for rate limiting across serverless containers; falls back to in-memory
    // storage, which is correct for a single long-lived process.
    UPSTASH_REDIS_REST_URL: Joi.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: Joi.string().optional(),
    // Optional — error/crash reporting (see config/sentry.ts). Unset means Sentry's SDK
    // simply never sends anything, the same graceful-degradation pattern as every other
    // optional integration in this app (EmailService, UploadsService, PushService).
    // AES-256-GCM key for the encrypted organizer bank-account columns (base64 of 32 random
    // bytes). Optional at boot on purpose: the app runs fine without it, and only the bank
    // account endpoints 503. Making it required would take the whole API down over a feature
    // most deploys are not using yet.
    //
    // Deliberately its own key, not derived from JWT_SECRET or PASSWORD_PEPPER: rotating a
    // signing key must never make bank details undecryptable, and a leak of one must not
    // expose the other. Generate with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    //
    // Once accounts exist this value can never change without a re-encryption pass — the
    // ciphertext carries a `v1:` prefix so such a rotation is possible, but nothing
    // implements it yet.
    BANK_ENCRYPTION_KEY: Joi.string().base64().optional(),
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
