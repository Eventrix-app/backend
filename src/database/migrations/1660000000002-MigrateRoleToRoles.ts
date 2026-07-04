import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Root cause:
 *   The users.roles JSONB column exists but some rows contain a badly-formed
 *   array whose first element is itself a JSON-encoded string, e.g.:
 *     roles = '["[\"admin\"]"]'  or  roles = '["[admin]"]'
 *   This makes user.roles[0] return '["admin"]' (a string starting with '[')
 *   instead of 'admin', so the JWT role becomes "[" and the RolesGuard rejects it.
 *
 *   Additionally, some rows may have roles = '[]' (empty array) because they were
 *   created before this column existed and got the default value.
 *
 * Fix:
 *   1. For rows where every element of roles is itself a valid JSON array string
 *      (i.e. starts with '['), re-parse the first element as a JSONB array.
 *   2. For rows where roles is empty, assign ["user"] as a safe default.
 */
export class MigrateRoleToRoles1660000000002 implements MigrationInterface {
  name = 'MigrateRoleToRoles1660000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix rows where the stored first element is itself a JSON array string
    // e.g. roles = '["[\"admin\"]"]' → should be '["admin"]'
    await queryRunner.query(`
      UPDATE "users"
      SET "roles" = ("roles"->>0)::jsonb
      WHERE
        jsonb_typeof("roles") = 'array'
        AND jsonb_array_length("roles") > 0
        AND ("roles"->>0) LIKE '[%';
    `);

    // Fix rows where roles is an empty array — assign ["user"] as safe default
    await queryRunner.query(`
      UPDATE "users"
      SET "roles" = '["user"]'::jsonb
      WHERE
        jsonb_typeof("roles") = 'array'
        AND jsonb_array_length("roles") = 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No reliable rollback for data normalisation
  }
}
