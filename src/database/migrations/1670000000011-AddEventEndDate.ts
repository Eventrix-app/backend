import { MigrationInterface, QueryRunner } from 'typeorm';

// See loophole.md — additive, nullable column so this is a low-risk migration with no
// backfill: existing single-day events default to eventEndDate = eventDate at the
// application level (src/events/utils/event-dates.util.ts), never in the DB.
export class AddEventEndDate1670000000011 implements MigrationInterface {
  name = 'AddEventEndDate1670000000011';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "event_end_date" date NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "events"
      ADD CONSTRAINT "CHK_events_end_date_after_start"
      CHECK ("event_end_date" IS NULL OR "event_end_date" >= "event_date")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "CHK_events_end_date_after_start"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "event_end_date"`);
  }
}
