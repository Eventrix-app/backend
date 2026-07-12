import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationJobs1670000000009 implements MigrationInterface {
  name = 'AddNotificationJobs1670000000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "type" varchar(30) NOT NULL,
        "payload" jsonb NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "sent_at" timestamp NULL,
        CONSTRAINT "PK_notification_jobs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notification_jobs_user_status" ON "notification_jobs" ("user_id", "status")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notification_jobs_user_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_jobs"`);
  }
}
