import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { User } from '../../entities/user.entity';
import { Organizer } from '../../entities/organizer.entity';
import { Event } from '../../entities/event.entity';
import { Follow } from '../../entities/follow.entity';
import { UserSession } from '../../entities/user-session.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { OrganizerBankAccount } from '../../entities/organizer-bank-account.entity';
import { UploadsModule } from '../../uploads/uploads.module';
import { BankAccountController } from './bank-account.controller';
import { BankAccountService } from './bank-account.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Organizer, Event, Follow, UserSession, Enrollment, OrganizerBankAccount]),
    UploadsModule,
  ],
  // BankAccountController is declared BEFORE OrganizerController: Nest matches routes in
  // registration order, and OrganizerController's bare `GET /organizers/:id` would otherwise
  // swallow `GET /organizers/bank-account/pending` (and 400 it on ParseUUIDPipe).
  controllers: [BankAccountController, OrganizerController],
  providers: [OrganizerService, BankAccountService],
  // Exported so the payout path can resolve a destination through getDecryptedForPayout()
  // rather than reaching for the entity and reimplementing the payout-ready gate.
  exports: [OrganizerService, BankAccountService],
})
export class OrganizerModule {}
