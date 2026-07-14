import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserOnboardingCompleted1670000000012 implements MigrationInterface {
  name = 'AddUserOnboardingCompleted1670000000012';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "has_completed_onboarding" boolean NOT NULL DEFAULT false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "has_completed_onboarding"`);
  }
}
