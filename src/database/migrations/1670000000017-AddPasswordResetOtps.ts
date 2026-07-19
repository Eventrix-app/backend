import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPasswordResetOtps1670000000017 implements MigrationInterface {
  name = 'AddPasswordResetOtps1670000000017';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "password_reset_otps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar NOT NULL,
        "otp_hash" varchar NOT NULL,
        "expires_at" timestamp NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_password_reset_otps" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_password_reset_otps_email" ON "password_reset_otps" ("email")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_password_reset_otps_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_otps"`);
  }
}
