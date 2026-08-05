import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Event } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { WaitlistService } from './waitlist.service';
import { FeeCalculationService } from '../payments/fee-calculation.service';
import { LedgerService } from '../payments/ledger.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([WaitlistEntry, Enrollment, Event, Organizer]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [WaitlistService, FeeCalculationService, LedgerService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
