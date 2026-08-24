import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CacheService } from '../common/cache/cache.service';

// Uptime monitors and Vercel cannot authenticate, so this has to be public. It reports only
// whether a dependency answered — never a version, a hostname, or an error body.
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly cache: CacheService,
  ) {}

  // Liveness: is the process up. Deliberately touches nothing else, so a database blip can
  // never make a platform restart or redeploy an otherwise healthy instance.
  @Public()
  @Get()
  live(): { status: string } {
    return { status: 'ok' };
  }

  // Readiness: can it actually serve. Budget measured, not guessed — a cold connection to the
  // cross-region database costs ~1.8s in TLS handshake alone, against ~320ms once warm, and
  // serverless pays that handshake on every cold start. A tighter budget reports "down" for a
  // database that is merely far away, which is worse than no check at all.
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('ready')
  @HealthCheck()
  ready() {
    const timeout = Number(process.env.HEALTH_DB_TIMEOUT_MS) || 5000;
    return this.health.check([
      () => this.db.pingCheck('database', { timeout }),
      // Reported, never failed on: the app is fully functional without Redis, just slower, so
      // a cache outage must not take the deployment out of rotation — hence status is always
      // 'up' and the real answer is in `backend`. This exists because an absent cache is
      // otherwise invisible: 'redis' vs 'none' is the difference between "caching is working"
      // and "every request is hitting Postgres".
      () => ({ cache: { status: 'up' as const, backend: this.cache.isEnabled ? 'redis' : 'none' } }),
    ]);
  }
}
