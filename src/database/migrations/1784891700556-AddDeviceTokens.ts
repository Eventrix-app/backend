import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceTokens1784891700556 implements MigrationInterface {
  name = 'AddDeviceTokens1784891700556';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "device_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "token" varchar NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "last_used_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_device_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_device_tokens_token" UNIQUE ("token")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_device_tokens_user_id" ON "device_tokens" ("user_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "device_tokens" ADD CONSTRAINT "FK_device_tokens_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `).catch(() => {});

    // Backfill: carry forward whatever's already registered in the old single-slot column
    // so an already-logged-in user doesn't silently stop receiving push notifications
    // until they next re-register (app relaunch/login).
    await queryRunner.query(`
      INSERT INTO "device_tokens" ("user_id", "token", "created_at", "last_used_at")
      SELECT "id", "push_token", now(), now() FROM "users"
      WHERE "push_token" IS NOT NULL
      ON CONFLICT ("token") DO NOTHING
    `);

    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "push_token"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "push_token" varchar`);
    await queryRunner.query(`
      UPDATE "users" u SET "push_token" = dt."token"
      FROM (
        SELECT DISTINCT ON ("user_id") "user_id", "token"
        FROM "device_tokens"
        ORDER BY "user_id", "last_used_at" DESC
      ) dt
      WHERE u."id" = dt."user_id"
    `);
    await queryRunner.query(`ALTER TABLE "device_tokens" DROP CONSTRAINT IF EXISTS "FK_device_tokens_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_tokens_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_tokens"`);
  }
}
