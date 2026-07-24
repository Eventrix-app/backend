import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpdatedAtToReviewsAndAnnouncements1784895600000 implements MigrationInterface {
  name = 'AddUpdatedAtToReviewsAndAnnouncements1784895600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "event_reviews" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      ALTER TABLE "event_announcements" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_announcements" DROP COLUMN IF EXISTS "updated_at"`);
    await queryRunner.query(`ALTER TABLE "event_reviews" DROP COLUMN IF EXISTS "updated_at"`);
  }
}
