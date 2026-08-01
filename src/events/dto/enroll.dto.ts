import { IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';

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
}
