import { MigrationInterface, QueryRunner } from 'typeorm';

// The text a creator positioned over their reel on the edit screen — its content, colour,
// font, size and placement. See ShortOverlayDto for the shape.
//
// jsonb rather than a set of columns: it is a single presentation blob, always read and
// written whole, and nothing queries or sorts by its parts. Nullable with no backfill —
// most reels have no overlay, and every existing row predates the feature.
export class AddShortOverlay1785000000001 implements MigrationInterface {
  name = 'AddShortOverlay1785000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS so re-running against an environment where this was already applied is
    // a no-op rather than a hard failure.
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "overlay" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "overlay"`);
  }
}
