import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationReadAt1670000000014 implements MigrationInterface {
  name = 'AddNotificationReadAt1670000000014';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_jobs" ADD COLUMN IF NOT EXISTS "read_at" timestamp NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_jobs" DROP COLUMN IF EXISTS "read_at"`);
  }
}
