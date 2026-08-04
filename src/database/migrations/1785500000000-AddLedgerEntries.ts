import { MigrationInterface, QueryRunner } from 'typeorm';

// Backs the new LedgerEntry entity — recordPaymentLedger/recordRefundLedger/recordPayoutLedger
// (PaymentsService's handleWebhook/processGatewayRefund/settleEventPayout) already write to
// this table today, inside the very same transaction that confirms a payment/refund/payout.
// Without this migration, "ledger_entries" doesn't exist in any real database (synchronize is
// false — see database.config.ts), so every one of those inserts throws, rolling back the
// enclosing transaction along with it: a successful gateway payment would fail to ever mark
// the enrollment paid, a refund would fail to process, a payout would fail to be created. Unit
// tests never caught this because they mock the EntityManager instead of hitting Postgres.
export class AddLedgerEntries1785500000000 implements MigrationInterface {
  name = 'AddLedgerEntries1785500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ledger_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "transaction_id" varchar NOT NULL,
        "debit_account" varchar NOT NULL,
        "credit_account" varchar NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "currency" varchar NOT NULL DEFAULT 'INR',
        "entry_type" varchar NOT NULL,
        "reference_id" varchar NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_entries" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ledger_entries_transaction_id" ON "ledger_entries" ("transaction_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ledger_entries_reference_id" ON "ledger_entries" ("reference_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ledger_entries_reference_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ledger_entries_transaction_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ledger_entries"`);
  }
}
