import { MigrationInterface, QueryRunner } from 'typeorm';

// Payout destinations. Until this table existed the schema held only `upi_id` and
// `pan_or_aadhaar_url` (a document IMAGE), so there was nowhere to send money and no PAN
// NUMBER to withhold TDS against — automated payout was blocked on missing data, not on a
// missing integration.
//
// Its own table, not columns on `organizers`, because: the encrypted columns should not be
// loaded on every organizer read; an account has a verification lifecycle independent of
// KYC; and rows are deactivated rather than overwritten when an organizer changes bank, so
// a historical payout stays traceable to the account it actually went to.
//
// Account number, holder name and PAN are AES-256-GCM ciphertext (field-encryption.util.ts),
// which is why they are `text` rather than sized varchars — the ciphertext envelope is
// version + IV + auth tag + payload, all base64, and much longer than the plaintext.
export class AddOrganizerBankAccounts1785700000002 implements MigrationInterface {
  name = 'AddOrganizerBankAccounts1785700000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organizer_bank_accounts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizer_id" uuid NOT NULL,
        "account_number_encrypted" text NOT NULL,
        "account_holder_name_encrypted" text NOT NULL,
        "pan_number_encrypted" text,
        "account_fingerprint" varchar(64) NOT NULL,
        "account_number_last4" varchar(4) NOT NULL,
        "ifsc_code" varchar(11) NOT NULL,
        "bank_name" varchar(100) NOT NULL,
        "branch_name" varchar(100),
        "account_type" varchar(20) NOT NULL DEFAULT 'savings',
        "status" varchar(30) NOT NULL DEFAULT 'pending',
        "rejection_reason" text,
        "verified_at" TIMESTAMP,
        "verified_by_admin_id" uuid,
        "penny_drop_reference" varchar(100),
        "penny_drop_at" TIMESTAMP,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_organizer_bank_accounts_organizer"
          FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_organizer_bank_accounts_organizer_active"
        ON "organizer_bank_accounts" ("organizer_id", "is_active")
    `);

    // One ACTIVE account per organizer, enforced by the database. Two active accounts is not
    // a state any code here can resolve — a payout would have to pick one, and picking wrong
    // sends money to the wrong bank. A partial index (rather than a plain UNIQUE) is what
    // lets the deactivated history rows coexist.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_organizer_bank_accounts_one_active"
        ON "organizer_bank_accounts" ("organizer_id")
        WHERE "is_active" = true
    `);

    // Detects the same real-world account registered under two organizers. Not unique: the
    // same account legitimately appears across this organizer's own superseded history rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_organizer_bank_accounts_fingerprint"
        ON "organizer_bank_accounts" ("account_fingerprint")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "organizer_bank_accounts"`);
  }
}
