import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShorts1670000000027 implements MigrationInterface {
  name = 'AddShorts1670000000027';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shorts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "uploader_user_id" uuid NOT NULL,
        "event_id" uuid,
        "media_url" text NOT NULL,
        "thumbnail_url" text,
        "caption" text,
        "moderation_status" varchar(20) NOT NULL DEFAULT 'under_review',
        "flag_reason" text,
        "view_count" int NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        "deleted_at" timestamp,
        CONSTRAINT "PK_shorts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shorts_uploader" FOREIGN KEY ("uploader_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_shorts_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shorts_moderation_status" ON "shorts" ("moderation_status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shorts_uploader" ON "shorts" ("uploader_user_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shorts_uploader"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shorts_moderation_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shorts"`);
  }
}
