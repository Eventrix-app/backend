// Single source of truth for "when does this event start/end" — every consumer (payout
// cron, refund cutoff, "is past"/"is live" display logic, notification diffing) must go
// through these instead of re-deriving eventDate/endTime inline. See loophole.md: the
// payout cron paid out 2 days early on multi-day events before this existed, because it
// re-derived "event end" from eventDate + endTime, silently assuming every event starts
// and ends on the same calendar day.
//
// Deliberately not typed against the Event entity directly — its nullable date/time
// columns (eventEndDate, endTime) are declared non-optional there (a pre-existing
// codebase convention), which would hide the nullability this util exists to handle.
export interface EventDateFields {
  eventDate: string;
  eventEndDate?: string | null;
  startTime: string;
  endTime?: string | null;
}

export function getEventStartDateTime(event: Pick<EventDateFields, 'eventDate' | 'startTime'>): Date {
  return combineDateAndTime(event.eventDate, event.startTime);
}

export function getEventEndDateTime(
  event: Pick<EventDateFields, 'eventDate' | 'eventEndDate' | 'startTime' | 'endTime'>,
): Date {
  // eventEndDate is nullable and defaults to eventDate (single-day event) for every
  // pre-existing row — no backfill needed, this is the application-level default.
  const endDate = event.eventEndDate ?? event.eventDate;
  return combineDateAndTime(endDate, event.endTime ?? event.startTime);
}

function combineDateAndTime(date: string, time: string): Date {
  return new Date(`${date}T${time}`);
}
