import { IsOptional, IsUUID, IsInt, IsString, Min, Max } from 'class-validator';

// Hard ceiling independent of TicketType.maxPerOrder/Event.capacity, both of which are
// optional and otherwise leave a single order free to claim an unbounded slice of
// inventory (or an unbounded totalAmount) when an organizer never sets them.
const MAX_QUANTITY_PER_ORDER = 50;

export class EnrollDto {
  @IsOptional()
  @IsUUID()
  ticketTypeId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_ORDER)
  quantity?: number;

  // Required when the resolved ticket type has TicketType.accessPassword set — see
  // EventsService.enroll(). Not present on public ticket type listings, so a caller has
  // to have actually been given it out-of-band.
  @IsOptional()
  @IsString()
  accessPassword?: string;
}
