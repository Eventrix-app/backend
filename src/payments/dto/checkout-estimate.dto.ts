import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// Buyer-facing checkout preview. Deliberately takes only the ticket tier and a quantity:
// the organizer and the event's feePayer are resolved server-side, so a caller can never
// name an arbitrary organizer the way FeeEstimateDto allows (that endpoint is organizer/
// admin-facing and guards against commission-rate enumeration with a 403 — this one has
// nothing to guard because the client never supplies an organizer at all).
export class CheckoutEstimateDto {
  @IsUUID()
  ticketTypeId!: string;

  @Type(() => Number)
  @IsInt({ message: 'quantity must be a whole number' })
  @Min(1, { message: 'quantity must be at least 1' })
  // Bounded so a nonsense quantity can't be used to probe for overflow behaviour in the
  // fee maths; real per-order limits are enforced by enroll() against the tier itself.
  @Max(100, { message: 'quantity is too large' })
  quantity!: number;
}
