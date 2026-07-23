import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShorts1670000000027 implements MigrationInterface {
  name = 'AddShorts1670000000027';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Table already exists from a prior migration — this is a no-op to unblock
    // the migration chain. The CreateAuthIdentities migration that follows handles
    // the correct final schema.
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shorts_uploader"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shorts_moderation_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shorts"`);
  }
}
