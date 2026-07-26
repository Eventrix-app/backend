import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Short } from '../entities/short.entity';
import { ShortLike } from '../entities/short-like.entity';
import { Event } from '../entities/event.entity';
import { ShortsController } from './shorts.controller';
import { ShortsService } from './shorts.service';

@Module({
  imports: [TypeOrmModule.forFeature([Short, ShortLike, Event])],
  controllers: [ShortsController],
  providers: [ShortsService],
})
export class ShortsModule {}
