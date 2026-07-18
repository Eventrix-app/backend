import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationJob } from '../entities/notification-job.entity';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationJob])],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
