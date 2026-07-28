import { MigrationInterface, QueryRunner } from 'typeorm';

// Capture location for a reel, chosen by the uploader on the share screen (seeded from
// their device position, re-pinnable on a map). Deliberately not derived from the event's
// venue coordinates — a reel is frequently shot somewhere other than the venue pin, and
// the event's own location is already reachable through shorts.event_id.
//
// All three columns are nullable with no backfill: existing rows genuinely have no
// location (they predate the field), and a user who declines the location permission must
// still be able to post. Precision/scale match events.latitude/longitude so the two are
// directly comparable in a query.
export class AddShortLocation1785000000000 implements MigrationInterface {
  name = 'AddShortLocation1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS so re-running against an environment where these were added by hand
    // (or by a partially-applied earlier run) is a no-op rather than a hard failure.
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "location_name" text`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "latitude" numeric(10,8)`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "longitude" numeric(11,8)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "longitude"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "latitude"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "location_name"`);
  }
}
