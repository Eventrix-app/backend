import { Redis } from '@upstash/redis';
import { ThrottlerStorage } from '@nestjs/throttler';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

// Vercel's serverless model runs each request in a potentially-separate container, so
// @nestjs/throttler's default in-memory ThrottlerStorageService only tracks hits within
// one warm container — a client's requests can be split across several, each individually
// under the limit, defeating the configured global cap. Upstash's REST-based client (no
// persistent TCP connection, unlike ioredis) is the standard fit for sharing counters
// across serverless invocations.
//
// Not a single atomic Lua script — a read-then-write race on the block key is possible
// under heavy concurrent load, same tradeoff most community Redis-throttler packages make.
// Good enough to make the configured limit real across containers; not a hard guarantee
// under adversarial concurrent bursts.
export class RedisThrottlerStorageService implements ThrottlerStorage {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const hitKey = `throttle:hits:${throttlerName}:${key}`;
    const blockKey = `throttle:block:${throttlerName}:${key}`;

    const blockExpiresAt = await this.redis.get<number>(blockKey);
    if (blockExpiresAt && blockExpiresAt > now) {
      const msRemaining = blockExpiresAt - now;
      return {
        totalHits: limit + 1,
        timeToExpire: Math.ceil(msRemaining / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil(msRemaining / 1000),
      };
    }

    const totalHits = await this.redis.incr(hitKey);
    if (totalHits === 1) {
      await this.redis.pexpire(hitKey, ttl);
    }
    const pttl = await this.redis.pttl(hitKey);
    const timeToExpire = Math.ceil((pttl > 0 ? pttl : ttl) / 1000);

    if (totalHits <= limit) {
      return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
    }

    const newBlockExpiresAt = now + blockDuration;
    await this.redis.set(blockKey, newBlockExpiresAt, { px: blockDuration });
    return {
      totalHits,
      timeToExpire,
      isBlocked: true,
      timeToBlockExpire: Math.ceil(blockDuration / 1000),
    };
  }
}
