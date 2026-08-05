import { MigrationInterface, QueryRunner } from 'typeorm';

// Supplier GSTIN for tax invoices (Organizer.gstin, printed by
// PaymentsService.getTaxInvoice). Hand-written rather than generated: the generated
// diff for this schema drops and recreates every foreign key, which is far more churn
// than one nullable column warrants.
//
// Nullable with no default and no backfill — organizers below the GST registration
// threshold genuinely have none, and inventing a placeholder would put a fake
// registration number on a statutory document.
export class AddGstinToOrganizer1785600000000 implements MigrationInterface {
  name = 'AddGstinToOrganizer1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" ADD COLUMN IF NOT EXISTS "gstin" character varying(15)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" DROP COLUMN IF EXISTS "gstin"`);
  }
}
