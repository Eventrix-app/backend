import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written, not generated: migration:generate diffs the whole schema and would fold
// unrelated drift into this file.
//
// Separate from the existing `reason` column, which holds what the *participant* wrote when
// asking for the refund. The decision the organizer/admin gives back is a different fact and
// overwriting the request's reason with it would destroy the record of why it was asked for.
export class AddRefundRejectionReason1786500000000 implements MigrationInterface {
  name = 'AddRefundRejectionReason1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "rejection_reason" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refunds" DROP COLUMN IF EXISTS "rejection_reason"`,
    );
  }
}
