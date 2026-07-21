import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventScheduleItem } from '../entities/event-schedule.entity';
import { EventAnnouncement } from '../entities/event-announcement.entity';
import { EventReview } from '../entities/event-review.entity';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { ChatModule } from '../chat/chat.module';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([EventScheduleItem, EventAnnouncement, EventReview, Event, Enrollment]),
    ChatModule,
  ],
  controllers: [ScheduleController, AnnouncementsController, ReviewsController],
  providers: [ScheduleService, AnnouncementsService, ReviewsService],
})
export class EventContentModule {}
