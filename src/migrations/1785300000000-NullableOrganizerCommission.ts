import { MigrationInterface, QueryRunner } from 'typeorm';

// Makes organizers.commission_rate / commission_flat_fee nullable so NULL can mean "no
// negotiated rate — apply the platform default" (config `platform.commissionPercent`),
// while an explicit value, including an explicit 0, remains a real override.
//
// The backfill is the consequential part: every existing row sits at 0 purely because that
// was the column default, not because anyone negotiated a commission-free deal — the
// platform has never charged commission at all. Those 0s are therefore "unset" and are
// converted to NULL, which means every existing organizer picks up the platform default
// (5%) on their next transaction. Anyone who genuinely should stay at 0% must be set back
// to an explicit 0 after this runs.
//
// down() restores NOT NULL DEFAULT 0, coalescing NULLs back to 0 first so the constraint
// can be re-applied.
export class NullableOrganizerCommission1785300000000 implements MigrationInterface {
  name = 'NullableOrganizerCommission1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_rate" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_rate" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_flat_fee" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_flat_fee" DROP DEFAULT`);

    // Treat the pre-existing default-0 rows as unconfigured, not as negotiated zero.
    await queryRunner.query(`UPDATE "organizers" SET "commission_rate" = NULL WHERE "commission_rate" = 0`);
    await queryRunner.query(`UPDATE "organizers" SET "commission_flat_fee" = NULL WHERE "commission_flat_fee" = 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "organizers" SET "commission_rate" = 0 WHERE "commission_rate" IS NULL`);
    await queryRunner.query(`UPDATE "organizers" SET "commission_flat_fee" = 0 WHERE "commission_flat_fee" IS NULL`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_rate" SET DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_rate" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_flat_fee" SET DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "organizers" ALTER COLUMN "commission_flat_fee" SET NOT NULL`);
  }
}
