import { MigrationInterface, QueryRunner } from 'typeorm';

// One row per account that has watched a reel.
//
// view_count was previously incremented on every play, so relaunching the app and watching
// the same reel again inflated it without limit. The unique (user_id, short_id) constraint
// below is what makes the counter mean "how many people watched this": recording a view is
// an insert that either succeeds or violates the constraint, and only a success moves the
// counter.
//
// Existing view_count values are left as they are rather than being reset to zero. They are
// inflated, but they are not wrong in a way anyone can act on, and zeroing a public counter
// on deploy is a more visible change than leaving it to be corrected by real traffic. There
// is no per-user history to rebuild them from — that is exactly what this table starts
// collecting.
export class AddShortViews1785000000004 implements MigrationInterface {
  name = 'AddShortViews1785000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "short_views" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "short_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_short_views" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_short_views_user_short" UNIQUE ("user_id", "short_id"),
        CONSTRAINT "FK_short_views_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_short_views_short" FOREIGN KEY ("short_id")
          REFERENCES "shorts"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "short_views"`);
  }
}
