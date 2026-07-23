import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthIdentities1784834416423 implements MigrationInterface {
  name = 'CreateAuthIdentities1784834416423';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_identities_provider_enum') THEN CREATE TYPE "public"."auth_identities_provider_enum" AS ENUM('local', 'google', 'apple', 'facebook', 'github'); END IF; END $$`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "auth_identities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "provider" "public"."auth_identities_provider_enum" NOT NULL, "provider_user_id" character varying(255) NOT NULL, "access_token" text, "refresh_token" text, "token_expires_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_f4e2d640d6834cbc3a473b897fc" UNIQUE ("user_id", "provider"), CONSTRAINT "PK_63a29aebcddd09448dbeee4666b" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_aa609852756e5772a11b73f8d8" ON "auth_identities" ("provider", "provider_user_id")`);
    await queryRunner.query(`ALTER TABLE "auth_identities" ADD CONSTRAINT "FK_c06a980d83c42611d27a294e55c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`).catch(() => {});
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth_identities" DROP CONSTRAINT IF EXISTS "FK_c06a980d83c42611d27a294e55c"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_aa609852756e5772a11b73f8d8"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_identities"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."auth_identities_provider_enum"`);
  }
}
