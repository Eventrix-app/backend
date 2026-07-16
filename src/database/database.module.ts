import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { getDatabaseConfig } from '../config/database.config';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // NestJS's TypeORM integration defaults to 10 retries at 3s apart (~30s) on connection
      // failure. On a serverless host that's well past the function timeout, so a genuine
      // outage burns the whole request hanging instead of failing back to the client quickly.
      useFactory: (configService: ConfigService) => ({
        ...getDatabaseConfig(configService),
        retryAttempts: 3,
        retryDelay: 1000,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
