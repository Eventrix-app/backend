import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTicketTypesAndCapacity1670000000001 implements MigrationInterface {
  name = 'AddTicketTypesAndCapacity1670000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ticket_types" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "price" numeric(10,2) NOT NULL DEFAULT 0,
        "currency" varchar(10) NOT NULL DEFAULT 'INR',
        "quantity_total" int NULL,
        "quantity_sold" int NOT NULL DEFAULT 0,
        "sales_start_at" timestamp NULL,
        "sales_end_at" timestamp NULL,
        "min_per_order" int NOT NULL DEFAULT 1,
        "max_per_order" int NULL,
        "is_hidden" boolean NOT NULL DEFAULT false,
        "access_password" varchar(255) NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ticket_types" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ticket_types_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ticket_types_event_id" ON "ticket_types" ("event_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "capacity" int NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "events"
      ADD COLUMN IF NOT EXISTS "fee_payer" varchar(20) NOT NULL DEFAULT 'participant'
    `);

    await queryRunner.query(`
      ALTER TABLE "event_bookings"
      ADD COLUMN IF NOT EXISTS "ticket_type_id" uuid NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "event_bookings"
      ADD CONSTRAINT "FK_event_bookings_ticket_type" FOREIGN KEY ("ticket_type_id")
      REFERENCES "ticket_types"("id") ON DELETE SET NULL
    `);

    // Backfill: create one "General Admission" ticket type per existing event,
    // carrying over the old flat price/capacity fields.
    await queryRunner.query(`
      INSERT INTO "ticket_types"
        ("event_id", "name", "price", "currency", "quantity_total", "quantity_sold", "sales_start_at", "sales_end_at")
      SELECT
        "id",
        'General Admission',
        COALESCE("price_per_ticket", 0),
        COALESCE("currency", 'INR'),
        "total_capacity",
        CASE
          WHEN "total_capacity" IS NOT NULL AND "available_tickets" IS NOT NULL
            THEN GREATEST("total_capacity" - "available_tickets", 0)
          ELSE 0
        END,
        "ticket_sales_open_date"::timestamp,
        "ticket_sales_close_date"::timestamp
      FROM "events"
    `);

    // Backfill: point every existing booking at the generated ticket type for its event.
    await queryRunner.query(`
      UPDATE "event_bookings" eb
      SET "ticket_type_id" = tt."id"
      FROM "ticket_types" tt
      WHERE tt."event_id" = eb."event_id"
        AND eb."ticket_type_id" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP CONSTRAINT IF EXISTS "FK_event_bookings_ticket_type"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN IF EXISTS "ticket_type_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "fee_payer"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "capacity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ticket_types_event_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_types"`);
  }
}
