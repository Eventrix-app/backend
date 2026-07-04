import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class EnhanceEventEntity1234567890123 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add approval_status if it doesn't exist
    await queryRunner.query(`
      ALTER TABLE events 
      ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'draft';
    `);

    // 2. Add status column if it doesn't exist
    await queryRunner.query(`
      ALTER TABLE events 
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'upcoming';
    `);

    // 3. Add audit trail columns
    await queryRunner.query(`
      ALTER TABLE events
      ADD COLUMN IF NOT EXISTS approved_by UUID,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS rejected_by UUID,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_by UUID;
    `);

    // 4. Set default value for price_per_ticket
    await queryRunner.query(`
      ALTER TABLE events 
      ALTER COLUMN price_per_ticket SET DEFAULT 0;
    `);

    // 5. Add indexes for performance
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_events_event_date_start_time" ON events (event_date, start_time);
      CREATE INDEX IF NOT EXISTS "IDX_events_approval_status_deleted_at" ON events (approval_status, deleted_at);
      CREATE INDEX IF NOT EXISTS "IDX_events_category_id_event_date" ON events (category_id, event_date);
      CREATE INDEX IF NOT EXISTS "IDX_events_title" ON events (title);
    `);

    // 6. Add foreign key constraints for audit fields
    await queryRunner.query(`
      ALTER TABLE events 
      DROP CONSTRAINT IF EXISTS FK_events_approved_by,
      ADD CONSTRAINT FK_events_approved_by 
      FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE events 
      DROP CONSTRAINT IF EXISTS FK_events_rejected_by,
      ADD CONSTRAINT FK_events_rejected_by 
      FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE events 
      DROP CONSTRAINT IF EXISTS FK_events_updated_by,
      ADD CONSTRAINT FK_events_updated_by 
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys
    await queryRunner.query(`ALTER TABLE events DROP CONSTRAINT IF EXISTS FK_events_approved_by`);
    await queryRunner.query(`ALTER TABLE events DROP CONSTRAINT IF EXISTS FK_events_rejected_by`);
    await queryRunner.query(`ALTER TABLE events DROP CONSTRAINT IF EXISTS FK_events_updated_by`);

    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_events_event_date_start_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_events_approval_status_deleted_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_events_category_id_event_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_events_title"`);

    // Drop columns
    await queryRunner.query(`
      ALTER TABLE events
      DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS rejected_by,
      DROP COLUMN IF EXISTS rejected_at,
      DROP COLUMN IF EXISTS updated_by,
      DROP COLUMN IF EXISTS approval_status;
    `);

    // Revert price_per_ticket default
    await queryRunner.query(`
      ALTER TABLE events 
      ALTER COLUMN price_per_ticket DROP DEFAULT
    `);
  }
}
