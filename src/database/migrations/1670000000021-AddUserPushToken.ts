import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPushToken1670000000021 implements MigrationInterface {
  name = 'AddUserPushToken1670000000021';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "push_token" varchar NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "push_token"`);
  }
}
