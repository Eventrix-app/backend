import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written, not generated: migration:generate diffs the whole schema and would fold
// unrelated drift into this file.
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
