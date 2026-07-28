import { MigrationInterface, QueryRunner } from 'typeorm';

// Brings the live "shorts" table in line with the Short entity.
//
// The table was never created by this migration chain — AddShorts1670000000027 is an
// explicit no-op stub, and AddShortLikesAndRequiredEventId only *reconciled* what a
// baseline schema had already created: it renamed creator_id/video_url/status, added
// flag_reason and like_count, and dropped title/description/duration_seconds/category/tags.
//
// Nothing ever added `caption`. The entity has always declared it, so every INSERT and every
// SELECT on this table failed with `column "caption" does not exist` — which is why creating
// a reel and loading the feed both returned 500 even with storage working correctly. The old
// table's `description` was the nearest equivalent and that migration dropped it without a
// replacement.
//
// view_count and thumbnail_url are in the same position: declared by the entity, never
// created by a migration. They are included here because their presence depends entirely on
// what the out-of-band baseline happened to contain, which cannot be assumed. Postgres only
// ever reports the first missing column in a statement, so fixing them one 500 at a time
// would take as many deploys as there are gaps.
//
// Every statement is ADD COLUMN IF NOT EXISTS, so this is safe on a database that already
// has some or all of them, and safe to run more than once.
export class ReconcileShortsColumns1785000000002 implements MigrationInterface {
  name = 'ReconcileShortsColumns1785000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "caption" text`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "thumbnail_url" text`);
    await queryRunner.query(
      `ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "view_count" integer NOT NULL DEFAULT 0`,
    );

    // Timestamps: TypeORM writes created_at/updated_at on every save and filters deleted_at
    // on every read, so a table missing any of them fails exactly as caption did.
    await queryRunner.query(
      `ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP`);
  }

  // Deliberately empty. Dropping these would destroy real reel data, and the columns are
  // required by the entity — reverting to a state the application cannot run against is not
  // a useful thing for a down migration to do. The two migrations either side of this one
  // drop only what they themselves added.
  public async down(): Promise<void> {
    // no-op
  }
}
