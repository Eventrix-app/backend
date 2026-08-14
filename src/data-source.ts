import 'dotenv/config';
import type { TlsOptions } from 'tls';
import { DataSource } from 'typeorm';
import { buildSslOptions } from './config/database.config';
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
import { LedgerEntry } from './entities/ledger-entry.entity';
import { OrganizerBankAccount } from './entities/organizer-bank-account.entity';

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
  LedgerEntry,
  OrganizerBankAccount,
];

// MIGRATION_DATABASE_URL takes precedence so migrations can run over a *direct* connection
// while the app itself keeps using the pooled one. DDL through a transaction-mode pooler
// (Supabase's port 6543) is unreliable — statements can land on different backend sessions.
// Falls back to DATABASE_URL when they are the same connection, which is the common case.
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

// Derived from whichever URL is actually in use, not from DATABASE_URL specifically — the
// previous check read the wrong variable the moment MIGRATION_DATABASE_URL was set, which
// would have silently disabled TLS against a remote database. Any non-local host gets SSL,
// matching config/database.config.ts.
// Delegates to the app's own builder rather than repeating the rule: migrations run against
// the same database, so a weaker setting here would be the hole the app no longer has.
function resolveSsl(url: string | undefined): TlsOptions | false {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    if (!hostname || ['localhost', '127.0.0.1'].includes(hostname)) return false;
    return buildSslOptions(hostname);
  } catch {
    return false;
  }
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: migrationDatabaseUrl,
  entities,
  synchronize: false,
  ssl: resolveSsl(migrationDatabaseUrl),
  // Both extensions: .ts when driven by ts-node locally, .js when run from dist/ on a
  // deploy. __dirname resolves to src/ or dist/ accordingly, so one glob covers both.
  migrations: [
    __dirname + '/database/migrations/*.{ts,js}',
  ],
});
