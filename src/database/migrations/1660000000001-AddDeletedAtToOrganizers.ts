import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeletedAtToOrganizers1660000000001 implements MigrationInterface {
  name = 'AddDeletedAtToOrganizers1660000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizers"
      ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizers"
      DROP COLUMN IF EXISTS "deleted_at";
    `);
  }
}
