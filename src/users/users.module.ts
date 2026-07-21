import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { OrganizerModule } from './organizer/organizer.module';
import { ParticipantModule } from './participant/participant.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { Follow } from '../entities/follow.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, EventCategory, Follow]), AdminModule, OrganizerModule, ParticipantModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [AdminModule, OrganizerModule, ParticipantModule],
})
export class UsersModule {}
