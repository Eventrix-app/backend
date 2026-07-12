import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { FeeCalculationService } from './fee-calculation.service';
import { Payment } from '../entities/payment.entity';
import { Commission } from '../entities/commission.entity';
import { Refund } from '../entities/refund.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Event } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { Payout } from '../entities/payout.entity';
import { WaitlistModule } from '../waitlist/waitlist.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Commission, Refund, Enrollment, Event, Organizer, Payout]),
    WaitlistModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, FeeCalculationService],
  exports: [PaymentsService, FeeCalculationService],
})
export class PaymentsModule {}
