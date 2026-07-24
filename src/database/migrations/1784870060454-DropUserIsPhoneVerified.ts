import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropUserIsPhoneVerified1784870060454 implements MigrationInterface {
  name = 'DropUserIsPhoneVerified1784870060454';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "is_phone_verified"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "is_phone_verified" boolean NOT NULL DEFAULT false`);
  }
}
