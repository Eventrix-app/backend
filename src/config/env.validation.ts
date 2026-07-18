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
    JWT_SECRET: Joi.string().optional(),
    JWT_EXPIRES_IN: Joi.string().optional(),
    FRONTEND_URL: Joi.string().optional(),
    GATEWAY_FEE_PERCENT: Joi.number().optional(),
    GATEWAY_FEE_FLAT: Joi.number().optional(),
    REFUND_WINDOW_HOURS: Joi.number().optional(),
    PAYOUT_DELAY_DAYS: Joi.number().optional(),
    SUPABASE_URL: Joi.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: Joi.string().optional(),
    CRON_SECRET: Joi.string().optional(),
    // Optional — only needed to make rate limiting work correctly across Vercel's
    // serverless containers (see RedisThrottlerStorageService). Falls back to in-memory
    // storage (correct for a single long-lived process) if unset.
    UPSTASH_REDIS_REST_URL: Joi.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: Joi.string().optional(),
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
