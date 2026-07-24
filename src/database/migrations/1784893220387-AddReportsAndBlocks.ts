import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReportsAndBlocks1784893220387 implements MigrationInterface {
  name = 'AddReportsAndBlocks1784893220387';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reporter_id" uuid NOT NULL,
        "target_type" varchar(20) NOT NULL,
        "target_id" uuid NOT NULL,
        "reason" text NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "reviewed_by" uuid,
        "reviewed_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_reports_status_created_at" ON "reports" ("status", "created_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_reporter_id"
      FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `).catch(() => {});

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "blocks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "blocker_id" uuid NOT NULL,
        "blocked_id" uuid NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_blocks_blocker_blocked" UNIQUE ("blocker_id", "blocked_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_blocks_blocker_id" ON "blocks" ("blocker_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "blocks" ADD CONSTRAINT "FK_blocks_blocker_id"
      FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `).catch(() => {});
    await queryRunner.query(`
      ALTER TABLE "blocks" ADD CONSTRAINT "FK_blocks_blocked_id"
      FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `).catch(() => {});
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "blocks" DROP CONSTRAINT IF EXISTS "FK_blocks_blocked_id"`);
    await queryRunner.query(`ALTER TABLE "blocks" DROP CONSTRAINT IF EXISTS "FK_blocks_blocker_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blocks_blocker_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "blocks"`);

    await queryRunner.query(`ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "FK_reports_reporter_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_reports_status_created_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reports"`);
  }
}
