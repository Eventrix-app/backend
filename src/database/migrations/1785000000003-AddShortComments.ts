import { MigrationInterface, QueryRunner } from 'typeorm';

// Comments on reels, plus the denormalised counter the feed renders per row.
//
// Flat rather than threaded — see ShortComment's own note. Soft-deleted, unlike likes:
// a comment is authored text, and moderation needs to be able to read what was said after
// it was taken down.
//
// The composite index matches the only query this table serves ("newest comments for this
// reel"), so the sort is served by the index rather than a heap scan.
export class AddShortComments1785000000003 implements MigrationInterface {
  name = 'AddShortComments1785000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "short_comments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "short_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_short_comments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_short_comments_short" FOREIGN KEY ("short_id")
          REFERENCES "shorts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_short_comments_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_short_comments_short_created"
         ON "short_comments" ("short_id", "created_at")`,
    );

    // Backfilled from the table just created, so it is 0 everywhere — but written as a real
    // count rather than a literal, so re-running this against a database where comments
    // already exist produces a correct number instead of silently zeroing them.
    await queryRunner.query(
      `ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "comment_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      UPDATE "shorts" s
      SET "comment_count" = (
        SELECT COUNT(*) FROM "short_comments" c
        WHERE c."short_id" = s."id" AND c."deleted_at" IS NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "comment_count"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_short_comments_short_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "short_comments"`);
  }
}
