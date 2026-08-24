import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';

// Generic read-through cache backed by the same Upstash Redis REST client used for rate
// limiting (see RedisThrottlerStorageService) — chosen for the same reason: a REST-based
// client works fine across Vercel's per-request serverless containers, unlike a persistent
// TCP client (e.g. ioredis). When UPSTASH_REDIS_REST_URL/TOKEN aren't configured, every
// method becomes a no-op (always a miss on read, no-op on write) — callers behave exactly
// as if there were no cache, so this is safe to inject everywhere regardless of whether
// Redis has been provisioned in a given environment.
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis | null;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('UPSTASH_REDIS_REST_URL');
    const token = configService.get<string>('UPSTASH_REDIS_REST_TOKEN');
    this.redis = url && token ? new Redis({ url, token }) : null;

    // Said out loud at boot because the failure mode is silence. Both env vars are optional
    // (config/env.validation.ts), so a deployment missing them starts cleanly, serves every
    // request from the database, and reports nothing — the throttler degrades the same way,
    // losing its shared counters across serverless containers. Neither shows up as an error;
    // the only symptom is load. A one-line log makes "is the cache on?" answerable from the
    // deployment log instead of by inference.
    if (this.redis) {
      this.logger.log('Redis cache enabled (Upstash REST)');
    } else {
      this.logger.warn(
        'Redis cache DISABLED — UPSTASH_REDIS_REST_URL/TOKEN not set. ' +
          'All reads fall through to the database and rate limiting is per-container only.',
      );
    }
  }

  /** Whether a Redis backend is configured. Surfaced by the health endpoint. */
  get isEnabled(): boolean {
    return this.redis !== null;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const value = await this.redis.get<T>(key);
      return value ?? null;
    } catch (err) {
      this.logger.warn(`cache get failed for "${key}": ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, value, { ex: ttlSeconds });
    } catch (err) {
      this.logger.warn(`cache set failed for "${key}": ${(err as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.redis || keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(`cache del failed for [${keys.join(', ')}]: ${(err as Error).message}`);
    }
  }

  // Cache-key versioning for parameterized list caches (many category/page/limit
  // combinations can each be cached separately). Bumping the version instantly
  // invalidates every existing list-cache entry on the next read without needing to
  // enumerate or SCAN for each filter combination — the old entries simply expire off
  // their TTL and are never looked up again since the key includes the new version.
  async getVersion(versionKey: string): Promise<number> {
    if (!this.redis) return 0;
    try {
      const v = await this.redis.get<number>(versionKey);
      return v ?? 1;
    } catch {
      return 1;
    }
  }

  async bumpVersion(versionKey: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.incr(versionKey);
    } catch (err) {
      this.logger.warn(`cache version bump failed for "${versionKey}": ${(err as Error).message}`);
    }
  }
}
