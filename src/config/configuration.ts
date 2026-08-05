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
    // No fallback here on purpose — env.validation.ts's Joi schema requires JWT_SECRET at
    // boot, so by the time this runs it's always set. A hardcoded fallback previously sat
    // here as a landmine for anyone who later reads `jwt.secret` from this nested config
    // instead of the flat `JWT_SECRET` key everything else reads today.
    secret: process.env.JWT_SECRET,
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
  razorpay: {
    // Unset in any environment that hasn't onboarded a real Razorpay account yet —
    // RazorpayService fails fast with a clear 503 rather than the SDK throwing an opaque
    // 401 mid-request. keyId is safe to hand back to the client (it's the public half of
    // the pair); keySecret/webhookSecret never leave the server.
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  payu: {
    // Same fail-fast philosophy as `razorpay` above — PayUService throws a clear 503 if
    // these are unset rather than letting a hash come out wrong silently. merchantKey is
    // safe to hand back to the client (it's the public half of the pair, required in the
    // form PayU's hosted page expects); merchantSalt never leaves the server.
    merchantKey: process.env.PAYU_MERCHANT_KEY,
    merchantSalt: process.env.PAYU_MERCHANT_SALT,
    // Retained as the single test/production switch (PayUService.isTestMode derives from it,
    // which also sets the native SDK's environment flag). Everything still works with only
    // this set — the two overrides below exist so an operator never has to infer which host
    // a deployment will actually talk to.
    baseUrl: process.env.PAYU_BASE_URL || 'https://test.payu.in',
    // Checkout and the refund/postservice API live on DIFFERENT production hosts
    // (secure.payu.in vs info.payu.in) and only coincide in test mode (test.payu.in serves
    // both), so one value cannot express both. Unset means "derive from baseUrl", which is
    // the documented default; set them to pin a host explicitly.
    //
    // Origins only — the paths (/_payment, /merchant/postservice.php?form=2) stay in
    // PayUService, since they are protocol details rather than deployment configuration.
    checkoutUrl: process.env.PAYU_CHECKOUT_URL,
    apiUrl: process.env.PAYU_API_URL,
  },
  tax: {
    // GST charged on the PLATFORM'S COMMISSION, not on the ticket price — the platform is
    // supplying an intermediary service and owes output tax on its own fee; the organizer
    // remains responsible for any GST on the ticket itself. 18% is the standard Indian rate
    // for this service category.
    //
    // Defaults to 0 (inert) rather than 18 on purpose: a deployment that has not yet
    // registered for GST must not start collecting it, and FeeCalculationService's
    // `gstRate / 100` term collapses the whole GST path to zero when unset. Set
    // TAX_GST_RATE=18 explicitly once the GSTIN is live.
    //
    // Who actually funds this depends on event.feePayer, and LedgerService.
    // recordPaymentLedger() books it from a different account for each case (see its
    // GST comment): PARTICIPANT means the buyer paid it on top and it is remitted out of
    // the buyer's money; ORGANIZER means the platform absorbs it out of its own commission.
    gstRate: Number(process.env.TAX_GST_RATE) || 0,
  },
  platform: {
    // Default commission applied when an organizer has NO negotiated rate of their own
    // (organizers.commission_rate IS NULL). An explicit value on the organizer row — including
    // an explicit 0 for a commission-free partner — always wins, which is why that column is
    // nullable rather than defaulting to 0: "never set" and "negotiated at zero" have to be
    // distinguishable or the platform default can never apply.
    commissionPercent: Number(process.env.PLATFORM_COMMISSION_PERCENT) || 5,

    // Flat fee charged per free-event booking. Free events collect nothing from the attendee,
    // so unlike every other fee this one is NOT netted out of a payment — it accrues against
    // the organizer as a platform receivable (ORGANIZER_PAYABLE goes negative by this amount).
    // The attendee still books at ₹0 with no gateway involved.
    //
    // NOTE: nothing currently COLLECTS that receivable. It is recorded, not invoiced — see
    // the free-event section in PAYMENT_MODEL.md before treating it as revenue.
    freeEventFee: Number(process.env.PLATFORM_FREE_EVENT_FEE ?? 12.5),
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
  admin: {
    // Defense in depth on top of AdminService.bootstrap()'s "only when zero admins exist"
    // check: that check alone means the permanently-@Public() bootstrap endpoint would
    // silently reopen to anyone if every admin account were ever removed post-launch.
    // Unset means bootstrap() always rejects — must be explicitly configured before the
    // very first admin can be created, same fail-closed posture as JWT_SECRET/PASSWORD_PEPPER.
    bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
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
