import { MigrationInterface, QueryRunner } from 'typeorm';

// Freezes the fee split onto each booking at settlement time.
//
// Payout, invoicing and refund reversal all used to re-derive the split from
// event_bookings.total_price against the organizer's CURRENT commission_rate and the
// CURRENT platform config (PLATFORM_COMMISSION_PERCENT, GATEWAY_FEE_*, TAX_GST_RATE). That
// made every one of those rates retroactive: editing an organizer from 0% to 5% restated
// what they were owed for tickets already sold, reissued past invoices at totals the buyer
// was never billed, and produced refund reversal legs of a different size than the payment
// legs they were supposed to cancel — permanently unbalancing the ledger.
//
// Every column is NULLABLE and left NULL for existing rows ON PURPOSE. There is deliberately
// no backfill: the only thing available to backfill FROM is today's config, which would
// stamp a guess with the authority of a record. Readers fall back to recomputation when
// fees_frozen_at IS NULL (PaymentsService.resolveBreakdown) and log it, so the pre-freeze
// population stays visible and shrinks to nothing as those bookings settle out.
//
// fees_frozen_at is the presence flag, not any amount column: a frozen 0 (commission-free
// partner, or a free event's organizer payout) and "never frozen" are different facts.
export class FreezeEnrollmentFeeSplit1785700000001 implements MigrationInterface {
  name = 'FreezeEnrollmentFeeSplit1785700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "event_bookings"
        ADD COLUMN IF NOT EXISTS "fee_payer_applied" VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "commission_rate_applied" NUMERIC(5,2),
        ADD COLUMN IF NOT EXISTS "commission_flat_fee_applied" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "ticket_base_amount" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "platform_fee_amount" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "gateway_fee_amount" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "gst_amount" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "organizer_payout_amount" NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "fees_frozen_at" TIMESTAMP
    `);

    // Partial index on the unfrozen-but-payable population. This is the set the payout sweep
    // has to fall back to recomputation for, and the set an operator needs to watch drain.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_bookings_unfrozen_fees"
        ON "event_bookings" ("event_id")
        WHERE "fees_frozen_at" IS NULL AND "payment_status" = 'paid'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_event_bookings_unfrozen_fees"`);
    await queryRunner.query(`
      ALTER TABLE "event_bookings"
        DROP COLUMN IF EXISTS "fee_payer_applied",
        DROP COLUMN IF EXISTS "commission_rate_applied",
        DROP COLUMN IF EXISTS "commission_flat_fee_applied",
        DROP COLUMN IF EXISTS "ticket_base_amount",
        DROP COLUMN IF EXISTS "platform_fee_amount",
        DROP COLUMN IF EXISTS "gateway_fee_amount",
        DROP COLUMN IF EXISTS "gst_amount",
        DROP COLUMN IF EXISTS "organizer_payout_amount",
        DROP COLUMN IF EXISTS "fees_frozen_at"
    `);
  }
}
