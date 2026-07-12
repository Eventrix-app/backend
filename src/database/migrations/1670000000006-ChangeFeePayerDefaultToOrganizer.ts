import { MigrationInterface, QueryRunner } from 'typeorm';

// Settled decision (see "Settled decisions" in eventrixchanges.md): fee_payer defaults to
// 'organizer', not 'participant' — the participant pays exactly ticket_type.price, and the
// organizer's payout is net of commission + gateway fee. Supersedes the default set in
// 1670000000001-AddTicketTypesAndCapacity.
export class ChangeFeePayerDefaultToOrganizer1670000000006 implements MigrationInterface {
  name = 'ChangeFeePayerDefaultToOrganizer1670000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Only the column default changes — existing rows may have deliberately chosen
    // 'participant' and are left untouched (there were 0 events at the time this ran).
    await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "fee_payer" SET DEFAULT 'organizer'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "fee_payer" SET DEFAULT 'participant'`);
  }
}
