import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { TicketType } from '../entities/ticket-type.entity';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Event, Enrollment, Organizer, User, EventCategory, TicketType]),
    WaitlistModule,
    UploadsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [EventsController, CategoryController],
  providers: [EventsService, CategoryService],
  exports: [EventsService, CategoryService],
})
export class EventsModule {}
