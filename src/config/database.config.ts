import { ConfigService } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';
import { User } from '../entities/user.entity';
import { Event } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { EventCategory } from '../entities/category.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import { TicketType } from '../entities/ticket-type.entity';
import { Payment } from '../entities/payment.entity';
import { Commission } from '../entities/commission.entity';
import { Refund } from '../entities/refund.entity';
import { WaitlistEntry } from '../entities/waitlist-entry.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { Payout } from '../entities/payout.entity';
import { NotificationJob } from '../entities/notification-job.entity';
import { Favorite } from '../entities/favorite.entity';
import { Follow } from '../entities/follow.entity';
import { EventMedia } from '../entities/event-media.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { EventScheduleItem } from '../entities/event-schedule.entity';
import { EventAnnouncement } from '../entities/event-announcement.entity';
import { EventReview } from '../entities/event-review.entity';
import { Short } from '../entities/short.entity';
import { ShortLike } from '../entities/short-like.entity';
import { UserSession } from '../entities/user-session.entity';
import { DeviceToken } from '../entities/device-token.entity';
import { Report } from '../entities/report.entity';
import { Block } from '../entities/block.entity';

const entities = [
  User,
  Organizer,
  Event,
  Enrollment,
  EventCategory,
  AuthIdentity,
  TicketType,
  Payment,
  Commission,
  Refund,
  WaitlistEntry,
  AuditLog,
  Payout,
  NotificationJob,
  Favorite,
  Follow,
  EventMedia,
  PasswordResetOtp,
  EmailVerificationOtp,
  ChatMessage,
  EventScheduleItem,
  EventAnnouncement,
  EventReview,
  Short,
  ShortLike,
  UserSession,
  DeviceToken,
  Report,
  Block,
];

export const getDatabaseConfig = (
  configService: ConfigService,
): DataSourceOptions => {
  const databaseUrl =
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_POOLER ||
    configService.get<string>('DATABASE_URL') ||
    configService.get<string>('DATABASE_URL_POOLER');

  if (databaseUrl) {
    let ssl: true | false | { rejectUnauthorized: boolean } = false;
    try {
      const parsed = new URL(databaseUrl);
      const hostname = parsed.hostname;
      if (hostname && !['localhost', '127.0.0.1'].includes(hostname)) {
        ssl = { rejectUnauthorized: false };
      }
    } catch {
      ssl = false;
    }

    return {
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: false,
      ssl,
    };
  }

  return {
    type: 'postgres',
    host: configService.get<string>('database.host', 'localhost'),
    port: configService.get<number>('database.port', 5432),
    username: configService.get<string>('database.username', 'postgres'),
    password: configService.get<string>('database.password', 'postgres'),
    database: configService.get<string>('database.database', 'eventrix'),
    entities,
    synchronize: false,
    ssl: false,
  };
};
