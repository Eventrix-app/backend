import { MigrationInterface, QueryRunner } from 'typeorm';

// Payouts previously defaulted to status 'paid' with paid_at set the moment the T+3 sweep
// computed them — but nothing in this codebase transfers money. Every payout row therefore
// claimed settlement that had not happened, which is the dangerous direction to be wrong in:
// it overstates what has been paid out.
//
// Splits the two facts apart:
//   processed_at — when the sweep computed the obligation (always set)
//   paid_at      — when a transfer actually confirmed (NULL until it does)
//
// Backfill: existing rows are moved to 'pending' and their paid_at copied into processed_at,
// then cleared. Those rows record obligations that were computed but never transferred, so
// 'pending' is the accurate description of every one of them. If any historical payout WAS
// settled out of band, set it back to 'paid' with a real paid_at afterwards.
export class PayoutPendingUntilTransferred1785700000000 implements MigrationInterface {
  name = 'PayoutPendingUntilTransferred1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "processed_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'pending'`);

    await queryRunner.query(
      `UPDATE "payouts" SET "processed_at" = COALESCE("paid_at", "created_at") WHERE "processed_at" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "payouts" SET "status" = 'pending', "paid_at" = NULL WHERE "status" = 'paid'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "payouts" SET "paid_at" = COALESCE("paid_at", "processed_at"), "status" = 'paid' WHERE "status" = 'pending'`,
    );
    await queryRunner.query(`ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'paid'`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN IF EXISTS "processed_at"`);
  }
}
