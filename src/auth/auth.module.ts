import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { User } from '../entities/user.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import { AdminModule } from '../users/admin/admin.module';
import { ParticipantModule } from '../users/participant/participant.module';
import { OrganizerModule } from '../users/organizer/organizer.module';
import { SESSION_TOKEN_TTL_SECONDS } from './jwt.util';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, PasswordResetOtp, EmailVerificationOtp, AuthIdentity]),
    AdminModule,
    ParticipantModule,
    OrganizerModule,
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: SESSION_TOKEN_TTL_SECONDS,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  // TypeOrmModule re-exported so JwtAuthGuard (registered globally in AppModule, which
  // imports this module) can inject the User repository for its live ban check.
  exports: [AuthService, TypeOrmModule],
})
export class AuthModule {}
