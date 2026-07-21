import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventContentTables1670000000024 implements MigrationInterface {
  name = 'AddEventContentTables1670000000024';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "highlights" text[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "who_should_attend" text[] NOT NULL DEFAULT '{}'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_schedule_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "time" varchar(100) NOT NULL,
        "title" varchar(255) NOT NULL,
        "order" int NOT NULL DEFAULT 0,
        CONSTRAINT "PK_event_schedule_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_event_schedule_items_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_schedule_items_event" ON "event_schedule_items" ("event_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_announcements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "posted_by_user_id" uuid NOT NULL,
        "title" varchar(255) NOT NULL,
        "body" text NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_announcements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_event_announcements_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_announcements_user" FOREIGN KEY ("posted_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_announcements_event_created" ON "event_announcements" ("event_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_reviews" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "rating" smallint NOT NULL,
        "text" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_reviews_event_user" UNIQUE ("event_id", "user_id"),
        CONSTRAINT "CHK_event_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5),
        CONSTRAINT "FK_event_reviews_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_reviews_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_reviews_event" ON "event_reviews" ("event_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_reviews_event"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_reviews"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_announcements_event_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_announcements"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_schedule_items_event"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_schedule_items"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "who_should_attend"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "highlights"`);
  }
}
