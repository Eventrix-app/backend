import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Event } from './entities/event.entity';
import { Organizer } from './entities/organizer.entity';
import { Enrollment } from './entities/enrollment.entity';
import { EventCategory } from './entities/category.entity';
import { AuthIdentity } from './entities/auth-identity.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Payment } from './entities/payment.entity';
import { Commission } from './entities/commission.entity';
import { Refund } from './entities/refund.entity';
import { WaitlistEntry } from './entities/waitlist-entry.entity';
import { AuditLog } from './entities/audit-log.entity';
import { Payout } from './entities/payout.entity';
import { NotificationJob } from './entities/notification-job.entity';
import { EventMedia } from './entities/event-media.entity';
import { PasswordResetOtp } from './entities/password-reset-otp.entity';
import { EmailVerificationOtp } from './entities/email-verification-otp.entity';
import { Favorite } from './entities/favorite.entity';
import { Follow } from './entities/follow.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { EventScheduleItem } from './entities/event-schedule.entity';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventReview } from './entities/event-review.entity';
import { Short } from './entities/short.entity';
import { ShortLike } from './entities/short-like.entity';
import { ShortComment } from './entities/short-comment.entity';
import { ShortView } from './entities/short-view.entity';
import { UserSession } from './entities/user-session.entity';
import { DeviceToken } from './entities/device-token.entity';
import { Report } from './entities/report.entity';
import { Block } from './entities/block.entity';

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
  EventMedia,
  PasswordResetOtp,
  EmailVerificationOtp,
  Favorite,
  Follow,
  ChatMessage,
  EventScheduleItem,
  EventAnnouncement,
  EventReview,
  Short,
  ShortLike,
  ShortComment,
  ShortView,
  UserSession,
  DeviceToken,
  Report,
  Block,
];

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities,
  synchronize: false,
  ssl: process.env.DATABASE_URL?.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
  migrations: [
    __dirname + '/database/migrations/*.{ts,js}',
  ],
});
