import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventMedia1670000000016 implements MigrationInterface {
  name = 'AddEventMedia1670000000016';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_media" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "type" varchar(10) NOT NULL,
        "url" text NOT NULL,
        "position" int NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_media" PRIMARY KEY ("id"),
        CONSTRAINT "FK_event_media_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_media_event_id" ON "event_media" ("event_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_media_event_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_media"`);
  }
}
