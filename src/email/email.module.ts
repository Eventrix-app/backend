import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

// @Global so any feature module can inject EmailService without re-importing this module —
// imported once from AppModule, same pattern as CacheModule/AuditLogModule.
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
