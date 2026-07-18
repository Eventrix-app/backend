import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFavorites1670000000013 implements MigrationInterface {
  name = 'AddFavorites1670000000013';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "favorites" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_favorites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_favorites_user_event" UNIQUE ("user_id", "event_id"),
        CONSTRAINT "FK_favorites_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_favorites_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_favorites_user_created" ON "favorites" ("user_id", "created_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_favorites_user_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "favorites"`);
  }
}
