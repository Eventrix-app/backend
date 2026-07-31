import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCategoryIconUrl1785330000000 implements MigrationInterface {
  name = 'AddCategoryIconUrl1785330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_categories" ADD "icon_url" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_categories" DROP COLUMN "icon_url"`);
  }
}
