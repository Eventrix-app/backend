import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPayouts1670000000008 implements MigrationInterface {
  name = 'AddPayouts1670000000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payouts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "organizer_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "ticket_count" int NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "currency" varchar(10) NOT NULL DEFAULT 'INR',
        "status" varchar(20) NOT NULL DEFAULT 'paid',
        "paid_at" timestamp NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payouts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payouts_organizer" FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_payouts_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payouts_event_id" ON "payouts" ("event_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payouts_organizer_status" ON "payouts" ("organizer_id", "status")
    `);

    await queryRunner.query(`
      ALTER TABLE "event_bookings"
      ADD COLUMN IF NOT EXISTS "payout_id" uuid NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "event_bookings"
      ADD CONSTRAINT "FK_event_bookings_payout" FOREIGN KEY ("payout_id")
      REFERENCES "payouts"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_bookings_payout_id" ON "event_bookings" ("payout_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_event_bookings_payout_id"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP CONSTRAINT IF EXISTS "FK_event_bookings_payout"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN IF EXISTS "payout_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payouts_organizer_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payouts_event_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payouts"`);
  }
}
