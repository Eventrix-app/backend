import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { User } from '../../entities/user.entity';
import { Organizer } from '../../entities/organizer.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Organizer])],
  controllers: [OrganizerController],
  providers: [OrganizerService],
  exports: [OrganizerService],
})
export class OrganizerModule {}
