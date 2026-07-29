import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives each check-in scan an identity, so the server can tell a device retrying its own
 * scan apart from a second device scanning the same ticket.
 *
 * Before this, both cases came back as the same "already checked in" 409 and the client had
 * to guess — it guessed "benign retry" for both, which meant a genuine double-entry at two
 * offline gates was silently discarded during sync.
 *
 * `check_in_key` is text rather than uuid on purpose: it is produced on the scanning device,
 * which has no uuid generator available without pulling in an extra native dependency, and
 * the value only ever needs to be compared for equality — never parsed, sorted or joined on.
 */
export class AddCheckInIdempotency1785300000000 implements MigrationInterface {
  name = 'AddCheckInIdempotency1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_bookings" ADD "check_in_key" text`);
    await queryRunner.query(`ALTER TABLE "event_bookings" ADD "checked_in_by" uuid`);
    // ON DELETE SET NULL: losing the record of *who* scanned must never block deleting a
    // user account, and it must never cascade into deleting the booking itself.
    await queryRunner.query(
      `ALTER TABLE "event_bookings" ADD CONSTRAINT "FK_event_bookings_checked_in_by" ` +
        `FOREIGN KEY ("checked_in_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_bookings" DROP CONSTRAINT "FK_event_bookings_checked_in_by"`,
    );
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN "checked_in_by"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN "check_in_key"`);
  }
}
