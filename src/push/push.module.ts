import { Global, Module } from '@nestjs/common';
import { PushService } from './push.service';

// @Global so any feature module can inject PushService without re-importing this module —
// imported once from AppModule, same pattern as EmailModule/CacheModule.
@Global()
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
