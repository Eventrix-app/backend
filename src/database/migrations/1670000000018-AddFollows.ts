import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFollows1670000000018 implements MigrationInterface {
  name = 'AddFollows1670000000018';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "follows" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "organizer_id" uuid NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_follows" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_follows_user_organizer" UNIQUE ("user_id", "organizer_id"),
        CONSTRAINT "FK_follows_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_follows_organizer" FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_follows_user_created" ON "follows" ("user_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_follows_organizer" ON "follows" ("organizer_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_follows_organizer"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_follows_user_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "follows"`);
  }
}
