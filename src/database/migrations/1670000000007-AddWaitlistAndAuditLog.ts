import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaitlistAndAuditLog1670000000007 implements MigrationInterface {
  name = 'AddWaitlistAndAuditLog1670000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "waitlist_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "ticket_type_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "quantity" int NOT NULL DEFAULT 1,
        "status" varchar(20) NOT NULL DEFAULT 'waiting',
        "promoted_at" timestamp NULL,
        "promoted_enrollment_id" uuid NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_waitlist_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_waitlist_entries_user_ticket_type" UNIQUE ("user_id", "ticket_type_id"),
        CONSTRAINT "FK_waitlist_entries_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_waitlist_entries_ticket_type" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_waitlist_entries_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_waitlist_entries_tt_status_created"
      ON "waitlist_entries" ("ticket_type_id", "status", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_id" uuid NULL,
        "actor_email" varchar(255) NULL,
        "action" varchar(100) NOT NULL,
        "target_type" varchar(100) NULL,
        "target_id" varchar(255) NULL,
        "metadata" jsonb NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_logs_target" ON "audit_logs" ("target_type", "target_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_logs_actor_created" ON "audit_logs" ("actor_id", "created_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_actor_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_target"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_waitlist_entries_tt_status_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "waitlist_entries"`);
  }
}
