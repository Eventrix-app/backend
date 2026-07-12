import { MigrationInterface, QueryRunner } from 'typeorm';

// Pre-existing bug found while verifying Phase 0's enrollment flow: signed ticket_code JWTs
// (~260+ chars) don't fit in varchar(255), so every enrollment on a confirmed booking failed.
// Unrelated to the Phase 0 schema work itself, but it blocked verifying the new atomic
// enroll() path end-to-end, so it's fixed here rather than left broken.
export class WidenTicketCodeColumn1670000000005 implements MigrationInterface {
  name = 'WidenTicketCodeColumn1670000000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_bookings" ALTER COLUMN "ticket_code" TYPE text`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_bookings" ALTER COLUMN "ticket_code" TYPE varchar(255)`);
  }
}
