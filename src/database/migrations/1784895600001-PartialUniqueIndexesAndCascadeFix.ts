import { MigrationInterface, QueryRunner } from 'typeorm';

// Drops whatever unique/foreign-key constraint currently exists on the given columns,
// regardless of its name — the live DB's constraint names are a mix of Postgres's default
// `<table>_<col>_fkey` naming (from the original supabase-schema.sql, which used unnamed
// inline REFERENCES/UNIQUE clauses) and TypeORM's own generated names from later
// migrations, so a single hardcoded name can't be trusted to match every environment this
// runs against. Matches by conrelid + contype + exact column-set instead.
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

export class PartialUniqueIndexesAndCascadeFix1784895600001 implements MigrationInterface {
  name = 'PartialUniqueIndexesAndCascadeFix1784895600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- Re-enrollment after cancellation was permanently blocked: the DB-level unique
    // constraint on (user_id, event_id) was unconditional, so a cancelled booking left a
    // row that made every future enroll() attempt for that event 409 forever. Scope
    // uniqueness to non-cancelled bookings only.
    await dropConstraintByColumns(queryRunner, 'event_bookings', ['user_id', 'event_id'], 'u');
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_event_bookings_user_event_active"
      ON "event_bookings" ("user_id", "event_id")
      WHERE "booking_status" != 'cancelled'
    `);

    // --- Same bug on the waitlist: once a promoted/expired/cancelled entry existed, the
    // user could never rejoin the waitlist for that ticket type again. Scope to 'waiting'.
    await queryRunner.query(`ALTER TABLE "waitlist_entries" DROP CONSTRAINT IF EXISTS "UQ_waitlist_entries_user_ticket_type"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_waitlist_entries_user_ticket_type_waiting"
      ON "waitlist_entries" ("user_id", "ticket_type_id")
      WHERE "status" = 'waiting'
    `);

    // --- Cascade-delete inconsistency: every other financially-sensitive relation in this
    // schema (Enrollment.user/event, Payment/Refund/Payout.*) is ON DELETE RESTRICT, but
    // Organizer.user and Event.organizer were left as CASCADE — a hard DELETE of a user row
    // (a future GDPR-erasure path, an admin cleanup script) would silently cascade-delete
    // their Organizer profile and, in turn, every Event they own, instead of failing safely
    // like the rest of the schema does.
    await dropConstraintByColumns(queryRunner, 'organizers', ['user_id'], 'f');
    await queryRunner.query(`
      ALTER TABLE "organizers" ADD CONSTRAINT "FK_organizers_user"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
    `);

    await dropConstraintByColumns(queryRunner, 'events', ['organizer_id'], 'f');
    await queryRunner.query(`
      ALTER TABLE "events" ADD CONSTRAINT "FK_events_organizer"
      FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT
    `);

    // --- Hard-delete-my-data feature: marks a user row as pseudonymized (PII scrubbed,
    // financially-retained records left untouched via their FK to this same row) rather
    // than physically removed, so statutorily-retained bookings/payments/refunds/payouts
    // keep a valid owner reference. Distinct from `deleted_at` (soft deactivation).
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_erased" boolean NOT NULL DEFAULT false`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "is_erased"`);

    await queryRunner.query(`ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "FK_events_organizer"`);
    await queryRunner.query(`
      ALTER TABLE "events" ADD CONSTRAINT "FK_events_organizer"
      FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`ALTER TABLE "organizers" DROP CONSTRAINT IF EXISTS "FK_organizers_user"`);
    await queryRunner.query(`
      ALTER TABLE "organizers" ADD CONSTRAINT "FK_organizers_user"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_waitlist_entries_user_ticket_type_waiting"`);
    await queryRunner.query(`
      ALTER TABLE "waitlist_entries" ADD CONSTRAINT "UQ_waitlist_entries_user_ticket_type"
      UNIQUE ("user_id", "ticket_type_id")
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_event_bookings_user_event_active"`);
    await queryRunner.query(`
      ALTER TABLE "event_bookings" ADD CONSTRAINT "UQ_event_bookings_user_event"
      UNIQUE ("user_id", "event_id")
    `);
  }
}
