import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

// @Global so any feature module can inject CacheService without re-importing this module —
// imported once from AppModule, same pattern as other cross-cutting infra in this app.
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
