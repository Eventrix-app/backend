import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrganizerVerificationFields1670000000025 implements MigrationInterface {
  name = 'AddOrganizerVerificationFields1670000000025';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "full_name" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "identity_proof_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "address_proof_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "pan_or_aadhaar_url" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "upi_id" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "submitted_for_review_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "rejection_reason" text`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "rejection_reason"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "submitted_for_review_at"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "upi_id"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "pan_or_aadhaar_url"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "address_proof_url"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "identity_proof_url"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "full_name"`);
  }
}
