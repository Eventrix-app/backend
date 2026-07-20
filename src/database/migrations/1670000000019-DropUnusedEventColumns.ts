import { MigrationInterface, QueryRunner } from 'typeorm';

// Three genuinely dead Event columns, confirmed by a full read/write trace across both
// Backend and Frontend:
//  - duration_minutes: auto-computed on every insert/update, unit-tested, but the result
//    was never read by any query/filter/sort/screen — write-only.
//  - ticket_sales_open_date / ticket_sales_close_date: accepted by CreateEventDto but
//    never sent by the real create-event UI, and no business logic ever read them — the
//    actual sales-window gate in EventsService.enroll() uses TicketType.salesStartAt/
//    salesEndAt instead. AddTicketTypesAndCapacity1670000000001's backfill (see that
//    migration's up()) already consumed these as its one-time source for salesStartAt/
//    salesEndAt when ticket types were introduced — nothing has read them since.
export class DropUnusedEventColumns1670000000019 implements MigrationInterface {
  name = 'DropUnusedEventColumns1670000000019';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "duration_minutes"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "ticket_sales_open_date"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "ticket_sales_close_date"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "duration_minutes" int NULL`);
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "ticket_sales_open_date" date NULL`);
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "ticket_sales_close_date" date NULL`);
  }
}
