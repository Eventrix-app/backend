import { MigrationInterface, QueryRunner } from 'typeorm';

// events.available_tickets (deprecated, superseded by TicketType.quantityTotal -
// quantitySold): confirmed unused by a full read/write trace. The only writer left was
// EventsService.bulkSeed() (a testing-only endpoint); nothing read the stored value —
// EventsService.withComputedSeats() always recomputes availableTickets fresh from
// ticket_types at response time (see events.service.ts), and the two frontend read paths
// that ever received the raw column (SavedEventsScreen's MainEventCard, and
// ProfileScreen's organizer-events EventInterestCard fed a raw, un-adapted event) don't
// actually render it. events.total_capacity has an identical profile but is left alone
// here — only available_tickets was in scope for this pass.
export class DropAvailableTicketsColumn1670000000020 implements MigrationInterface {
  name = 'DropAvailableTicketsColumn1670000000020';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "available_tickets"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "available_tickets" int NULL`);
  }
}
