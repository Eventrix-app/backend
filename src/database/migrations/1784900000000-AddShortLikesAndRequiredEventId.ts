import { MigrationInterface, QueryRunner } from 'typeorm';

// Drops whatever unique/foreign-key constraint currently exists on the given columns,
// regardless of its name — same helper as PartialUniqueIndexesAndCascadeFix, needed
// again here because AddShorts1670000000027 is a no-op stub (the shorts table was
// actually created elsewhere in the baseline schema), so the live FK's constraint name
// on shorts.event_id can't be trusted to match any single hardcoded guess.
async function dropConstraintByColumns(
  queryRunner: QueryRunner,
  table: string,
  columns: string[],
  contype: 'u' | 'f',
): Promise<void> {
  await queryRunner.query(`
    DO $$
    DECLARE
      target_conname text;
      target_attnums int[];
    BEGIN
      SELECT array_agg(attnum) INTO target_attnums
      FROM pg_attribute
      WHERE attrelid = '"${table}"'::regclass AND attname = ANY(ARRAY[${columns.map((c) => `'${c}'`).join(', ')}]);

      SELECT con.conname INTO target_conname
      FROM pg_constraint con
      WHERE con.conrelid = '"${table}"'::regclass
        AND con.contype = '${contype}'
        AND con.conkey::int[] <@ target_attnums
        AND target_attnums <@ con.conkey::int[]
      LIMIT 1;

      IF target_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE "${table}" DROP CONSTRAINT %I', target_conname);
      END IF;
    END $$;
  `);
}

export class AddShortLikesAndRequiredEventId1784900000000 implements MigrationInterface {
  name = 'AddShortLikesAndRequiredEventId1784900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- Schema reconciliation: the live "shorts" table (created outside this migration
    // chain — AddShorts1670000000027 is a no-op stub) never actually matched the Short
    // entity's column names. Real columns were creator_id/video_url/status (default
    // 'published', no flag_reason at all), plus title/description/duration_seconds/
    // category/tags that aren't modeled in the entity anywhere. Confirmed via a live
    // read-only schema+data check before writing this: the table has zero rows, so this
    // is a pure rename/restructure with no data-loss risk, not a data migration.
    await queryRunner.query(`ALTER TABLE "shorts" DROP CONSTRAINT IF EXISTS "shorts_creator_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "creator_id" TO "uploader_user_id"`);
    await queryRunner.query(`
      ALTER TABLE "shorts" ADD CONSTRAINT "FK_shorts_uploader"
      FOREIGN KEY ("uploader_user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "video_url" TO "media_url"`);

    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "status" TO "moderation_status"`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "moderation_status" TYPE varchar(20)`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "moderation_status" SET DEFAULT 'under_review'`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "flag_reason" text`);

    // Not modeled by the Short entity anywhere and confirmed empty above — dropped
    // rather than left as unexplained dead columns.
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "title"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "description"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "duration_seconds"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "category"`);
    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "tags"`);

    // --- Likes: denormalized counter on shorts (kept in sync by ShortsService.like()/
    // unlike() via an atomic UPDATE ... WHERE ... claim, not a live COUNT() per feed row —
    // the feed reads this table directly via the Supabase client with no backend
    // round-trip once this migration's RLS policy below is in place).
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "short_likes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "short_id" uuid NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_short_likes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_short_likes_user_short" UNIQUE ("user_id", "short_id"),
        CONSTRAINT "FK_short_likes_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_short_likes_short" FOREIGN KEY ("short_id") REFERENCES "shorts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_short_likes_short_id" ON "short_likes" ("short_id")`);

    // --- A reel always references an event now (uploads always launch from an event
    // context — see the Reel Upload screen design); event_id was previously nullable
    // with an ON DELETE SET NULL FK. Table is effectively unused today (no creator
    // upload flow has ever existed), so the defensive DELETE below should be a no-op.
    await dropConstraintByColumns(queryRunner, 'shorts', ['event_id'], 'f');
    await queryRunner.query(`DELETE FROM "shorts" WHERE "event_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "event_id" SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "shorts" ADD CONSTRAINT "FK_shorts_event"
      FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
    `);

    // --- RLS for the direct-read path: the Shorts feed reads this table directly via the
    // Supabase client (anon key) with no backend round-trip. Without this policy, that
    // client would see under_review/flagged/removed rows too, not just published ones.
    // The backend's own TypeORM connection uses a privileged Postgres role via
    // DATABASE_URL, which RLS does not restrict by default — confirm against the actual
    // configured DB role before relying on this in production.
    //
    // The EXISTS clause matters: events are only ever soft-deleted (EventsService.remove()
    // calls softRemove(), never a hard DELETE), so the FK's ON DELETE CASCADE above almost
    // never actually fires — a published short whose event gets soft-deleted would
    // otherwise keep passing this policy and stay visible in the direct-read feed forever,
    // pointing at an event that no longer resolves for anyone tapping through to it.
    await queryRunner.query(`ALTER TABLE "shorts" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "shorts_public_read" ON "shorts"
      FOR SELECT USING (
        "moderation_status" = 'published'
        AND EXISTS (SELECT 1 FROM "events" e WHERE e."id" = "shorts"."event_id" AND e."deleted_at" IS NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS "shorts_public_read" ON "shorts"`);
    await queryRunner.query(`ALTER TABLE "shorts" DISABLE ROW LEVEL SECURITY`);

    await queryRunner.query(`ALTER TABLE "shorts" DROP CONSTRAINT IF EXISTS "FK_shorts_event"`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "event_id" DROP NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "shorts" ADD CONSTRAINT "FK_shorts_event"
      FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_short_likes_short_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "short_likes"`);

    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "like_count"`);

    // --- Reverse the schema reconciliation. Best-effort mirror, not data restoration —
    // the table was empty when this migration ran, so there's nothing to recover.
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "title" character varying`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "description" text`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "duration_seconds" integer`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "category" character varying`);
    await queryRunner.query(`ALTER TABLE "shorts" ADD COLUMN IF NOT EXISTS "tags" text[]`);

    await queryRunner.query(`ALTER TABLE "shorts" DROP COLUMN IF EXISTS "flag_reason"`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "moderation_status" SET DEFAULT 'published'`);
    await queryRunner.query(`ALTER TABLE "shorts" ALTER COLUMN "moderation_status" TYPE character varying`);
    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "moderation_status" TO "status"`);

    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "media_url" TO "video_url"`);

    await queryRunner.query(`ALTER TABLE "shorts" DROP CONSTRAINT IF EXISTS "FK_shorts_uploader"`);
    await queryRunner.query(`ALTER TABLE "shorts" RENAME COLUMN "uploader_user_id" TO "creator_id"`);
    await queryRunner.query(`
      ALTER TABLE "shorts" ADD CONSTRAINT "shorts_creator_id_fkey"
      FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }
}
