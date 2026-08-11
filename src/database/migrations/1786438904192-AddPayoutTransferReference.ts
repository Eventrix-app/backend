import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the settlement-evidence columns to `payouts`.
//
// Hand-written rather than generated: `migration:generate` diffs the whole schema against
// the entities and would fold unrelated drift into this file (the one existing migration is
// a full generated baseline). Two additive, nullable columns need two statements.
export class AddPayoutTransferReference1786438904192 implements MigrationInterface {
  name = 'AddPayoutTransferReference1786438904192';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "transfer_reference" character varying(128)`,
    );
    await queryRunner.query(`ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "notes" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN IF EXISTS "notes"`);
    await queryRunner.query(`ALTER TABLE "payouts" DROP COLUMN IF EXISTS "transfer_reference"`);
  }
}
