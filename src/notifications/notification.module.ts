import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationJob } from '../entities/notification-job.entity';
import { NotificationService } from './notification.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationJob])],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
