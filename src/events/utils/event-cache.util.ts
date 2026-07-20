import { CacheService } from '../../common/cache/cache.service';

// Shared with anything that mutates ticket_types.quantity_sold outside EventsService
// itself (WaitlistService.tryPromote, PaymentsService.processGatewayRefund) — each of
// those changes the same number availableTickets (EventsService.withComputedSeats) is
// derived from, so they all need to invalidate the exact same keys EventsService reads
// through. Centralized here rather than duplicated per-service so the key format can
// never drift between writers and the reader.
export const EVENTS_LIST_VERSION_KEY = 'events:list:version';

export function eventDetailCacheKey(id: string): string {
  return `events:detail:${id}`;
}

export async function invalidateEventCaches(cache: CacheService, id: string): Promise<void> {
  await Promise.all([cache.del(eventDetailCacheKey(id)), cache.bumpVersion(EVENTS_LIST_VERSION_KEY)]);
}
