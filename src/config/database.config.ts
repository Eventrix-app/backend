import { ConfigService } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';
import { User } from '../entities/user.entity';
import { Event } from '../entities/event.entity';
import { Organizer } from '../entities/organizer.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { EventCategory } from '../entities/category.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';

const entities = [User, Organizer, Event, Enrollment, EventCategory, AuthIdentity];

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
