# loophole.md — Multi-day Event Assumption

> **Status: Fixed.** Implemented per §3 exactly as scoped: additive nullable `events.event_end_date` column (migration `1670000000011-AddEventEndDate`, with the `event_end_date >= event_date` check constraint), a single shared `getEventEndDateTime()`/`getEventStartDateTime()` helper (`src/events/utils/event-dates.util.ts`), the payout cron and refund cutoff both switched to go through it, cross-field validation on event create/update and on ticket-tier `salesEndAt`, and unit tests covering the legacy-null/multi-day/T+3-regression cases described in §3.5. No existing single-day event behavior changed — verified via the full test suite and the Phase 0 capacity/waitlist integration test still passing unchanged.

## 1. The problem

Phase 0's `events` table never added an explicit event **end date** — only `eventDate` (start) and `endTime` (a time, not a date). Every place in the codebase that needs to know "when does this event actually finish" currently derives it as:

```
event_end = eventDate + endTime
```

This silently assumes **every event starts and ends on the same calendar day.** That assumption was a reasonable Phase 0 gap when it only affected display logic, but two Phase 1 systems now do real, money-moving or time-gated work on top of it:

| System | What it computes | What breaks for a multi-day event |
|---|---|---|
| **Payout cron (T+3 rule)** | `now() >= event.end_date + 3 days` | If a 3-day fest actually ends on Day 3 but the cron thinks it ended on Day 1 (`eventDate`), payouts fire **2 days too early** — while the event is still running and refunds could still be validly in flight. |
| **Refund cutoff (48h rule)** | `now() < event.start_date − 48h` | This one is *not* broken by the bug (it already correctly uses `eventDate` as the start), but it becomes **inconsistent** with the payout cron once multi-day events exist: refund window closes 48h before Day 1 starts, while the "safe to pay out" assumption in Phase 0's design (§9 of the gap analysis) relies on the refund window being closed *relative to when the event truly ends*, not just when it starts. For a 3-day event, a participant could still legitimately want a refund on Day 2, well after the 48h-before-Day-1 cutoff has already passed — the cutoff is currently anchored to the wrong end of the event. |
| **Ticket type sales windows** | `sales_end_at` vs. informal assumptions about "event has ended" in any UI badge (`is_past`, `is_live`) | Any "this event has ended" / "sales closed" display logic that reuses the same `eventDate + endTime` derivation will mark a still-running multi-day event as over on Day 1. |

This is not a hypothetical — your stated target users are **college fests and conferences**, which routinely run 2–3+ days. Left unfixed, this becomes a live money bug (early payouts before an event has actually concluded) the first time an organizer creates a multi-day event, not just a display glitch.

## 2. Source files affected

Exact paths depend on your repo layout — verify against your actual tree, but based on the modules described in this conversation, the following need review:

- **`Event` entity** (likely `src/events/entities/event.entity.ts` or similar) — has `eventDate`, `endTime`, no `event_end_date`.
- **Migration history** — needs one new migration; do not edit migrations `1670000000001`–`010` retroactively.
- **`EventsModule` / `EventsService`** — anywhere event creation/edit DTOs validate or default date fields; anywhere `is_past` / `is_live` / "has this event ended" logic is computed for display or for gating ticket sales.
- **`PaymentsModule` — payout cron job** — the `@Cron` task implementing the T+3 rule; currently computes eligibility off `eventDate + endTime`.
- **`PaymentsModule` — refund request endpoint** — the 48h-cutoff check; currently anchored only to `eventDate` (start), which is correct as a *start*-anchored rule but needs to be reconciled with the true end date per the fix below.
- **`WaitlistModule`**, if it has any "event already happened, stop promoting waitlist entries" logic — same derived-end-date dependency.
- **`NotificationModule`** event-change hooks — if a date-change notification is triggered by comparing old vs. new "end," it needs the same field.
- **Any mobile/CMS UI** rendering "Day 1 of 3," event badges, or countdown timers off a single `eventDate`.

## 3. Optimized resolution

### 3.1 Schema change (one small, additive migration)

Add a nullable `event_end_date` column to `events`:

```sql
ALTER TABLE events ADD COLUMN event_end_date DATE NULL;
```

- **Nullable, not required** — this is the key to making it a cheap, low-risk migration instead of a breaking one. No backfill logic is needed to *guess* end dates for existing single-day events.
- **Application-level default, not a DB default:** in `EventsService`, when `event_end_date` is not explicitly provided at creation, default it to `eventDate` (i.e., single-day event, end = start). This preserves 100% backward-compatible behavior for every existing single-day event with zero migration-time data rewriting.
- Add a DB check constraint: `event_end_date >= event_date` (when not null) to prevent an organizer from creating an event that "ends before it starts."

This is deliberately the smaller, additive alternative to reworking `eventDate`/`endTime` into a full date-range model — it solves the actual money-bug without touching every existing query that reads `eventDate`.

### 3.2 Single source of truth for "event end"

Add one helper — not scattered inline derivations — so every consumer (cron, refund check, UI) computes the same thing the same way:

```typescript
// events/utils/event-dates.util.ts
function getEventEndDateTime(event: Event): Date {
  const endDate = event.eventEndDate ?? event.eventDate; // fallback for legacy rows
  return combineDateAndTime(endDate, event.endTime);
}
```

Replace every inline `eventDate + endTime` derivation (payout cron, "is past" checks, notification diffing) with a call to this single function. This is the actual bug-fix leverage point — the schema column alone doesn't help if five different call sites keep computing the end date their own way.

### 3.3 Fix the two Phase 1 systems specifically

- **Payout cron:** change eligibility query to `now() >= getEventEndDateTime(event) + 3 days`. No change to the 3-day rule itself, only to what "event end" means.
- **Refund cutoff:** keep the rule anchored to **event start** (`now() < event.eventDate − 48h`) as originally settled — do **not** change this to be end-date-anchored, because the original intent ("no refunds once the event is imminent/underway") is about the *start*, not the finish. What changes is only the **documentation/reasoning**, not the code: explicitly note that for multi-day events, the refund window closes 48h before Day 1 and stays closed for the full event, which is an intentional product behavior (no refunds once any part of a multi-day event has begun), not a bug. This removes the false inconsistency flagged in §1 — it was a reasoning gap, not a code gap, once the cutoff is clearly documented as start-anchored by design.

### 3.4 Validation at event creation

In the "Create Event" DTO/validator (same layer as the Phase 1 live fee-preview endpoint), add:
- `event_end_date`, if provided, must be `>= eventDate`.
- If organizers are allowed to set ticket-tier `sales_end_at` per tier, validate it doesn't exceed `getEventEndDateTime(event)`.

### 3.5 Test coverage to add

- Unit test: `getEventEndDateTime()` returns `eventDate` when `eventEndDate` is null (legacy/single-day row).
- Unit test: `getEventEndDateTime()` returns the later date when `eventEndDate` is set.
- Integration test: create a 3-day event, advance the clock to `Day1 + 3 days` (old buggy T+3 point), assert payout cron does **not** yet pay out; advance to `Day3 + 3 days`, assert it does.
- Regression test: confirm the existing Phase 0 single-day payout test still passes unchanged (this is the backward-compatibility check that proves the fix is additive, not breaking).

## 4. Why this is the optimized approach (vs. alternatives considered)

| Alternative | Why not chosen |
|---|---|
| Rework `eventDate`/`endTime` into a full `start_datetime`/`end_datetime` pair, dropping the old fields | Correct long-term, but touches every existing query/entity/DTO that reads `eventDate`/`endTime` — much larger diff and regression surface for a problem that a nullable additive column solves just as well. |
| Backfill `event_end_date` for all existing rows at migration time | Unnecessary — application-level default-to-`eventDate` achieves the same effect without a data migration pass, and is simpler to reason about (nulls only mean "not explicitly multi-day," never "unknown"). |
| Leave the derivation inline at each call site and just fix the cron | Fixes today's known bug but leaves the same landmine for the next feature (e.g. a future "event has ended" badge, or an SLA/reminder job) that reimplements the same wrong derivation independently. |

The additive nullable column + single shared helper function is the smallest change that (a) fixes the live payout-timing bug, (b) requires no data backfill, (c) keeps 100% of existing single-day event behavior unchanged, and (d) prevents the same mistake from being reintroduced by a future feature that doesn't know about this loophole.
