import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which hashing scheme each stored password was written with, so the pepper can be
 * introduced without invalidating a single existing account.
 *
 * DEFAULT 1 is the load-bearing part: every row that exists when this runs was hashed as
 * bcrypt(password) with no pepper, and must keep verifying that way. New and changed
 * passwords are written as version 2 (peppered), and a version 1 row is transparently
 * upgraded the next time its owner logs in — the only moment the plaintext is available to
 * re-hash from. See auth/password.util.ts.
 *
 * Deliberately not backfilled to 2: there is no way to convert a v1 hash to v2 without the
 * plaintext, so claiming otherwise would lock every existing user out.
 */
export class AddPasswordHashVersion1785310000000 implements MigrationInterface {
  name = 'AddPasswordHashVersion1785310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "password_hash_version" smallint NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping this column strands any v2 (peppered) hash written while it existed: without
    // the version marker those rows would be verified as v1 and every affected user would be
    // unable to log in. Rolling back past this migration therefore also requires those users
    // to reset their passwords.
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash_version"`);
  }
}
