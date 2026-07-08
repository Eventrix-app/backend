import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParticipantController } from './participant.controller';
import { ParticipantService } from './participant.service';
import { User } from '../../entities/user.entity';
import { EventCategory } from '../../entities/category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, EventCategory])],
  controllers: [ParticipantController],
  providers: [ParticipantService],
  exports: [ParticipantService],
})
export class ParticipantModule {}
