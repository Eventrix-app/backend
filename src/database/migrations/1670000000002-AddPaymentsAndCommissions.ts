import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentsAndCommissions1670000000002 implements MigrationInterface {
  name = 'AddPaymentsAndCommissions1670000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    // A pre-existing, empty "payments" table (booking_id/user_id/metadata shape) predates this
    // codebase's entities and is referenced by no application code — safe to replace with the
    // shape this migration defines (confirmed empty and unreferenced before dropping).
    await queryRunner.query(`DROP TABLE IF EXISTS "payments" CASCADE`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "enrollment_id" uuid NOT NULL,
        "gateway" varchar(20) NOT NULL,
        "gateway_payment_id" varchar(255) NULL,
        "gateway_event_id" varchar(255) NULL,
        "amount" numeric(10,2) NOT NULL,
        "currency" varchar(10) NOT NULL DEFAULT 'INR',
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payments_enrollment" FOREIGN KEY ("enrollment_id") REFERENCES "event_bookings"("id") ON DELETE RESTRICT
      )
    `);

    // Webhook idempotency key: dedupe PayU/Razorpay retries before processing.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_gateway_event_id"
      ON "payments" ("gateway_event_id")
      WHERE "gateway_event_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_enrollment_id" ON "payments" ("enrollment_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "commissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "payment_id" uuid NOT NULL,
        "platform_commission_amount" numeric(10,2) NOT NULL DEFAULT 0,
        "gateway_fee_amount" numeric(10,2) NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_commissions_payment_id" UNIQUE ("payment_id"),
        CONSTRAINT "FK_commissions_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "organizers"
      ADD COLUMN IF NOT EXISTS "commission_rate" numeric(5,2) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "organizers"
      ADD COLUMN IF NOT EXISTS "commission_flat_fee" numeric(10,2) NOT NULL DEFAULT 0
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "commission_flat_fee"`);
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "commission_rate"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "commissions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_enrollment_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payments_gateway_event_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
  }
}
