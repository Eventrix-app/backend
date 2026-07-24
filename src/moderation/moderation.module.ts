import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Report } from '../entities/report.entity';
import { Block } from '../entities/block.entity';
import { User } from '../entities/user.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { EventReview } from '../entities/event-review.entity';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { BlocksService } from './blocks.service';
import { BlocksController } from './blocks.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Report, Block, User, ChatMessage, EventReview])],
  controllers: [ReportsController, BlocksController],
  providers: [ReportsService, BlocksService],
  // BlocksService is consumed by ChatModule (filters a blocker's chat history) — exported
  // rather than duplicating block-lookup logic there.
  exports: [BlocksService],
})
export class ModerationModule {}
