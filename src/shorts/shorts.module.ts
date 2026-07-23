import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Short } from '../entities/short.entity';
import { ShortsController } from './shorts.controller';
import { ShortsService } from './shorts.service';

@Module({
  imports: [TypeOrmModule.forFeature([Short])],
  controllers: [ShortsController],
  providers: [ShortsService],
})
export class ShortsModule {}
