import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatMessage } from '../entities/chat-message.entity';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { EventsModule } from '../events/events.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ChatService } from './chat.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatController } from './chat.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ChatMessage, Event, Enrollment]), EventsModule, ModerationModule],
  controllers: [ChatController],
  providers: [ChatService, ChatRealtimeService],
  exports: [ChatService, ChatRealtimeService],
})
export class ChatModule {}
