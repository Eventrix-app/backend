import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { User } from '../../entities/user.entity';
import { Organizer } from '../../entities/organizer.entity';
import { Event } from '../../entities/event.entity';
import { Follow } from '../../entities/follow.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Organizer, Event, Follow])],
  controllers: [OrganizerController],
  providers: [OrganizerService],
  exports: [OrganizerService],
})
export class OrganizerModule {}
