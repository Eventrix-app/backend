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
import { Favorite } from '../entities/favorite.entity';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { UserSession } from '../entities/user-session.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { Organizer } from '../entities/organizer.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      EventCategory,
      Follow,
      Favorite,
      WaitlistEntry,
      UserSession,
      AuthIdentity,
      EmailVerificationOtp,
      PasswordResetOtp,
      Organizer,
      DeviceToken,
    ]),
    AdminModule,
    OrganizerModule,
    ParticipantModule,
    AuthModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [AdminModule, OrganizerModule, ParticipantModule],
})
export class UsersModule {}
