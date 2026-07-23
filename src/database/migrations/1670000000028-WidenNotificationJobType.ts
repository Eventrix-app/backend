import { MigrationInterface, QueryRunner } from 'typeorm';

// 'organizer_verification_approved' / 'organizer_verification_rejected' are 32 chars —
// the original varchar(30) column rejected every insert of either value at the DB level,
// and since NotificationService.enqueue() is always fired via `void` (fire-and-forget),
// that failure surfaced as an unhandled promise rejection that crashed the whole process
// (Node's default: unhandled rejections are fatal), not just a swallowed error. Discovered
// by actually exercising POST /organizers/:id/verification/approve end-to-end.
export class WidenNotificationJobType1670000000028 implements MigrationInterface {
  name = 'WidenNotificationJobType1670000000028';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_jobs" ALTER COLUMN "type" TYPE varchar(40)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_jobs" ALTER COLUMN "type" TYPE varchar(30)`);
  }
}
