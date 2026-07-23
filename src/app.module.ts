import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PreviewModule } from './preview/preview.module';
import { CrudModule } from './crud/crud.module';
import { EventsModule } from './events/events.module';
import { PaymentsModule } from './payments/payments.module';
import { UploadsModule } from './uploads/uploads.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AuditLogModule } from './common/audit-log/audit-log.module';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { NotificationModule } from './notifications/notification.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { RedisThrottlerStorageService } from './common/throttler/redis-throttler-storage.service';
import { HttpOnlyThrottlerGuard } from './common/throttler/http-only-throttler.guard';
import { CacheModule } from './common/cache/cache.module';
import { EmailModule } from './email/email.module';
import { PushModule } from './push/push.module';
import { ChatModule } from './chat/chat.module';
import { EventContentModule } from './event-content/event-content.module';
import { GeocodeModule } from './geocode/geocode.module';
import { ShortsModule } from './shorts/shorts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            // Default: 20 requests / 10s per client. Enrollment/auth endpoints tighten
            // this further via @Throttle() to blunt scripted mass-enrollment/scalping.
            ttl: 10000,
            limit: 20,
          },
        ],
        // The default in-memory storage only tracks hits within one warm serverless
        // container — on Vercel, a client's requests can land on several different
        // containers, each under the limit, defeating the cap entirely. If Upstash's
        // env vars are present, share counters across containers via Redis instead;
        // otherwise fall back to the in-memory default (correct for a single
        // long-lived process, e.g. local dev / `npm run start:dev`).
        storage: (() => {
          const url = configService.get<string>('UPSTASH_REDIS_REST_URL');
          const token = configService.get<string>('UPSTASH_REDIS_REST_TOKEN');
          return url && token ? new RedisThrottlerStorageService(url, token) : undefined;
        })(),
      }),
    }),
    CacheModule,
    EmailModule,
    PushModule,
    DatabaseModule,
    AuditLogModule,
    NotificationModule,
    AuthModule,
    UsersModule,
    PreviewModule,
    CrudModule,
    EventsModule,
    PaymentsModule,
    UploadsModule,
    ChatModule,
    EventContentModule,
    GeocodeModule,
    ShortsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    HttpExceptionFilter,
    // Throttler runs FIRST, before auth — Nest evaluates global guards in registration
    // order and stops at the first one that rejects, so if JwtAuthGuard ran first (as it
    // used to), any request with a missing/expired/garbage bearer token would 401 out of
    // that guard before ever reaching the throttler, exempting unauthenticated-token abuse
    // (e.g. hammering a protected endpoint with junk tokens) from rate limiting entirely.
    // Safe to run first: HttpOnlyThrottlerGuard's default tracker keys off req.ip, not
    // req.user, so it has no dependency on JwtAuthGuard having run yet.
    { provide: APP_GUARD, useClass: HttpOnlyThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
