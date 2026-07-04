import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRolesToUser1660000000000 implements MigrationInterface {
  name = 'AddRolesToUser1660000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "roles" jsonb NOT NULL DEFAULT '[]';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "roles";
    `);
  }
}
