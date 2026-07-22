import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPasswordChangedAt1670000000026 implements MigrationInterface {
  name = 'AddUserPasswordChangedAt1670000000026';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "password_changed_at"`);
  }
}
