import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmailVerificationOtps1784865894390 implements MigrationInterface {
  name = 'AddEmailVerificationOtps1784865894390';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_verification_otps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar NOT NULL,
        "otp_hash" varchar NOT NULL,
        "expires_at" timestamp NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_verification_otps" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verification_otps_email" ON "email_verification_otps" ("email")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_email_verification_otps_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_verification_otps"`);
  }
}
