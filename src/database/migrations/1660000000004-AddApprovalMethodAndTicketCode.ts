import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApprovalMethodAndTicketCode1660000000004 implements MigrationInterface {
  name = 'AddApprovalMethodAndTicketCode1660000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Section 4: approval_method on events
    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "approval_method" VARCHAR(20) DEFAULT NULL
    `);

    // Section 4: is_paid flag on events
    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "is_paid" BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Section 7: refund policy fields on events
    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "refund_policy_type" VARCHAR(30) NOT NULL DEFAULT 'no_refunds',
      ADD COLUMN IF NOT EXISTS "refund_policy_text" TEXT DEFAULT NULL
    `);

    // Section 5: signed ticket_code on enrollments
    await queryRunner.query(`
      ALTER TABLE "event_bookings"
      ADD COLUMN IF NOT EXISTS "ticket_code" VARCHAR(255) DEFAULT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_event_bookings_ticket_code"
      ON "event_bookings" ("ticket_code")
      WHERE "ticket_code" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_event_bookings_ticket_code"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN IF EXISTS "ticket_code"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "refund_policy_text"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "refund_policy_type"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "is_paid"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "approval_method"`);
  }
}
