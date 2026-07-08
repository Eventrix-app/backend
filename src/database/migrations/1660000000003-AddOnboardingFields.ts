import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOnboardingFields1660000000003 implements MigrationInterface {
  name = 'AddOnboardingFields1660000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    // notification_prefs jsonb column on users
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "notification_prefs" jsonb
      DEFAULT '{"eventReminders":true,"nearbyEvents":true,"reelsAndCommunity":true,"specialOffers":true}'
    `);

    // user_interests join table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_interests" (
        "user_id"     uuid NOT NULL,
        "category_id" uuid NOT NULL,
        CONSTRAINT "PK_user_interests" PRIMARY KEY ("user_id", "category_id"),
        CONSTRAINT "FK_user_interests_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_interests_category"
          FOREIGN KEY ("category_id") REFERENCES "event_categories"("id") ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_interests"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "notification_prefs"`);
  }
}
