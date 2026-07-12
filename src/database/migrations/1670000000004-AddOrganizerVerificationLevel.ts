import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrganizerVerificationLevel1670000000004 implements MigrationInterface {
  name = 'AddOrganizerVerificationLevel1670000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizers"
      ADD COLUMN IF NOT EXISTS "verification_level" varchar(20) NOT NULL DEFAULT 'unverified'
    `);

    // Backfill from the existing boolean flag (kept, not dropped, for rollback safety).
    await queryRunner.query(`
      UPDATE "organizers" SET "verification_level" = 'document_verified' WHERE "verified" = true
    `);

    await queryRunner.query(`
      ALTER TABLE "organizers"
      ADD COLUMN IF NOT EXISTS "auto_approve_events" boolean NOT NULL DEFAULT false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "auto_approve_events"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "verification_level"`);
  }
}
