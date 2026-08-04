import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPayuTxnIdToEnrollment1785400000000 implements MigrationInterface {
  name = 'AddPayuTxnIdToEnrollment1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_bookings" ADD "payu_txn_id" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_event_bookings_payu_txn_id" ON "event_bookings" ("payu_txn_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_event_bookings_payu_txn_id"`);
    await queryRunner.query(`ALTER TABLE "event_bookings" DROP COLUMN "payu_txn_id"`);
  }
}
