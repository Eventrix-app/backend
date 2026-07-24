import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserSessions1784889098466 implements MigrationInterface {
  name = 'AddUserSessions1784889098466';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "device_label" varchar,
        "user_agent" varchar,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "last_seen_at" timestamp NOT NULL DEFAULT now(),
        "revoked_at" timestamp,
        CONSTRAINT "PK_user_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_user_id" ON "user_sessions" ("user_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "user_sessions" ADD CONSTRAINT "FK_user_sessions_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `).catch(() => {});
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_sessions" DROP CONSTRAINT IF EXISTS "FK_user_sessions_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_sessions_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_sessions"`);
  }
}
