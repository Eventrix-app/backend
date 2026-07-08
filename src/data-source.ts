import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Event } from './entities/event.entity';
import { Organizer } from './entities/organizer.entity';
import { Enrollment } from './entities/enrollment.entity';
import { EventCategory } from './entities/category.entity';
import { AuthIdentity } from './entities/auth-identity.entity';
import { AddOnboardingFields1660000000003 } from './database/migrations/1660000000003-AddOnboardingFields';

const entities = [User, Organizer, Event, Enrollment, EventCategory, AuthIdentity];

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
