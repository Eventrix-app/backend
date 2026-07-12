import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRefunds1670000000003 implements MigrationInterface {
  name = 'AddRefunds1670000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "refunds" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "enrollment_id" uuid NOT NULL,
        "requested_by" uuid NOT NULL,
        "reason" text NULL,
        "status" varchar(20) NOT NULL DEFAULT 'requested',
        "amount" numeric(10,2) NOT NULL,
        "gateway_refund_id" varchar(255) NULL,
        "requested_at" timestamp NOT NULL DEFAULT now(),
        "processed_at" timestamp NULL,
        CONSTRAINT "PK_refunds" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refunds_enrollment" FOREIGN KEY ("enrollment_id") REFERENCES "event_bookings"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_refunds_enrollment_id" ON "refunds" ("enrollment_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_refunds_status" ON "refunds" ("status")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refunds_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refunds_enrollment_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refunds"`);
  }
}
