import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { OrganizerModule } from './organizer/organizer.module';
import { ParticipantModule } from './participant/participant.module';

@Module({
  imports: [AdminModule, OrganizerModule, ParticipantModule],
  exports: [AdminModule, OrganizerModule, ParticipantModule],
})
export class UsersModule {}
