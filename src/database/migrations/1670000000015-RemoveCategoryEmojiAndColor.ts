import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveCategoryEmojiAndColor1670000000015 implements MigrationInterface {
  name = 'RemoveCategoryEmojiAndColor1670000000015';

  async up(queryRunner: QueryRunner): Promise<void> {
    // v_events_with_details (defined in supabase-schema.sql, applied directly to the DB
    // outside this migration system — not queried anywhere in the app) selects ec.emoji,
    // so a plain DROP COLUMN is rejected with "view ... depends on column emoji". CASCADE
    // drops the dependent view along with the column; nothing in the app breaks since
    // nothing reads from that view.
    await queryRunner.query(`ALTER TABLE "event_categories" DROP COLUMN IF EXISTS "emoji" CASCADE`);
    await queryRunner.query(`ALTER TABLE "event_categories" DROP COLUMN IF EXISTS "color_hex" CASCADE`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_categories" ADD COLUMN IF NOT EXISTS "emoji" varchar(10) NULL`);
    await queryRunner.query(`ALTER TABLE "event_categories" ADD COLUMN IF NOT EXISTS "color_hex" varchar(7) NULL`);
  }
}
