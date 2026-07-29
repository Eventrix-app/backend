import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Constrains ticket-type "name" to a fixed vocabulary (EARLY_BIRD / GENERAL / VIP) instead of
 * organizer-typed free text, and adds the benefits list shown on the ticket card.
 *
 * `category` is NOT NULL DEFAULT 'GENERAL' rather than nullable: every existing row predates
 * this column and none of them can be reliably reclassified from their old free-text `name`
 * (an organizer's "Standard", "Regular", "Tier 1" could mean anything), so GENERAL is the
 * honest fallback rather than leaving the column optional and pushing that ambiguity onto
 * every future reader. Existing rows keep their original `name` — this does not touch it —
 * so nothing already sold or displayed changes; only ticket types created or edited after
 * this migration go through the category vocabulary (see TICKET_CATEGORY_LABELS in
 * ticket-type.entity.ts, applied in events.service.ts).
 */
export class AddTicketTypeCategoryAndBenefits1785320000000 implements MigrationInterface {
  name = 'AddTicketTypeCategoryAndBenefits1785320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."ticket_types_category_enum" AS ENUM('EARLY_BIRD', 'GENERAL', 'VIP')`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_types" ADD "category" "public"."ticket_types_category_enum" NOT NULL DEFAULT 'GENERAL'`,
    );
    await queryRunner.query(`ALTER TABLE "ticket_types" ADD "benefits" text array`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ticket_types" DROP COLUMN "benefits"`);
    await queryRunner.query(`ALTER TABLE "ticket_types" DROP COLUMN "category"`);
    await queryRunner.query(`DROP TYPE "public"."ticket_types_category_enum"`);
  }
}
