# eventrixchanges.md
Agent task list — implement in the order given. Each phase is sequenced so later tasks don't require reworking earlier ones. Do not skip ahead to P1/P2 items until all P0 items in a phase are done and migrations are applied.

---

## Settled decisions (unblocks Phase 1 — do not revisit without product sign-off)

**1. Fee payer: Organizer absorbs.**
Participant pays exactly `ticket_type.price` at checkout, no fees added on top. Organizer receives `ticket_price − platform_commission − gateway_fee` per ticket. Free events: no commission/gateway fee applies.
- Implication: the fee-calc service must be callable standalone from the "Create Event" flow (not only from the payment path), so organizers see a live net-payout estimate (e.g. "You'll receive ₹460/ticket") *before* submitting the event for admin approval. Add this as an explicit endpoint in Phase 1, not an afterthought of the payment logic.

**2. Payout cycle: T+3 days after event end date.**
Payout cron sweeps events where `now() >= event.end_date + 3 days`, batches all eligible enrollments per organizer/event, marks paid.
- Exclusion rule: any enrollment with an associated `Refund` row in status `requested` or `approved` (not yet `processed`) must be excluded from that payout run and picked up in a later run once the refund is resolved. Do not pay out on enrollments with an open refund dispute.

**3. Refund window: flat 48-hour cutoff before event start.**
Refund requests are accepted only while `now() < event.start_date − 48h`. After that point, the refund request endpoint rejects with a clear error. (Manual admin/organizer discretionary override outside this window is a possible future addition — not required for Phase 1.)

**Why these are compatible:** the refund window closes 48h *before* the event starts; payout doesn't fire until 3 days *after* the event ends. There is no point at which a payout can go out while a refund is still validly requestable — the only remaining edge case is an *already-requested-but-unresolved* refund dispute still open at payout time, handled by the exclusion rule above.

---

## Phase 0 — Schema foundation (do first, blocks everything else)

> These are breaking schema changes. Do them before writing any business logic that touches events/tickets/payments, or you will have to rewrite it.

- [x] **Replace flat event pricing with a `ticket_types` table.**
  - New entity `TicketType`: `id, event_id (FK), name, price, currency, quantity_total, quantity_sold, sales_start_at, sales_end_at, min_per_order, max_per_order, is_hidden, access_password (nullable), created_at, updated_at`
  - Remove/deprecate the single `price` field on `events`; `events.is_paid` stays as a derived/quick-check flag only.
  - Update `EventsModule` DTOs, create/edit event endpoints, and TypeORM entity relations (`Event.ticketTypes: TicketType[]`).
  - Done via `1670000000001-AddTicketTypesAndCapacity` (+ backfill of pre-existing events into a "General Admission" tier — none existed at migration time). `pricePerTicket`/`totalCapacity`/`availableTickets` kept as deprecated columns, not dropped. `CreateEventDto.ticketTypes` + `EventsService.createForUser` persist nested tiers; full per-tier CRUD/locking endpoints are Phase 1.

- [x] **Add capacity + oversell protection.**
  - Add `capacity` (nullable = unlimited) to `events`, and rely on `ticket_types.quantity_total/quantity_sold` for per-tier limits.
  - Implement enrollment as a single DB transaction using `SELECT ... FOR UPDATE` (or Postgres `UPDATE ... WHERE quantity_sold < quantity_total RETURNING`) to atomically increment `quantity_sold`. No app-level "check then write" — it must be race-safe.
  - Add integration test: fire N concurrent enrollment requests against a ticket_type with capacity < N, assert exactly `capacity` succeed.
  - Done: `EventsService.enroll()` rewritten around a single atomic `UPDATE ticket_types ... WHERE quantity_sold + $qty <= quantity_total RETURNING`, plus an `Event` row lock only when `event.capacity` requires an aggregate cross-tier check. `test/ticket-capacity.integration-spec.ts` (`npm run test:integration`) fires 20 concurrent enrollments against a ticket type with capacity 5 and asserts exactly 5 succeed — verified green against the live DB.

- [x] **Split commission from payment gateway fee in schema.**
  - Update `commissions` table: rename/split into `platform_commission_amount` and `gateway_fee_amount`, both tied to `payment_id`.
  - Add `fee_payer` enum (`organizer` | `participant`) at the `event` level. **Settled: default = `organizer`** (see "Settled decisions" above) — participant always pays exactly `ticket_type.price`, organizer's payout is net of commission + gateway fee.
  - Add configurable commission rate fields to `organizers` (already has `commission_rate` — extend to support a flat fee component too, e.g. `commission_flat_fee`, mirroring "% + flat" models).
  - Done via `1670000000002-AddPaymentsAndCommissions` (`payments`/`commissions` are net-new; a same-named, differently-shaped, empty, unreferenced legacy `payments` table was dropped and replaced). Default was initially built as `participant` per an earlier verbal answer, then corrected to `organizer` via `1670000000006-ChangeFeePayerDefaultToOrganizer` once this was formally settled — entity default and comment updated to match (organizer absorbs commission + gateway fee by default; `participant` is the opt-in mirror). The fee-calc service itself, and its standalone "live payout preview" endpoint for the Create Event flow, are Phase 1.

- [x] **Add refund data model.**
  - New entity `Refund`: `id, enrollment_id (FK), requested_by, reason, status (requested|approved|rejected|processed|failed), amount, gateway_refund_id, requested_at, processed_at`.
  - Add state-machine guard in `PaymentService` so status transitions only move forward (no requested → processed skipping approved, unless auto-approval rule applies).
  - Done via `1670000000003-AddRefunds`. `Refund.canTransition()` encodes the forward-only state machine on the entity; `PaymentService` (Phase 1) calls it. No deadline column — the settled 48h-before-event-start cutoff is computed from `event.eventDate`/`startTime` at request time in Phase 1, not stored.

- [x] **Add payment webhook idempotency.**
  - Add `gateway_event_id` (unique) column to `payments` (or a separate `webhook_events` table) to dedupe PayU/Razorpay webhook retries before processing.
  - Wrap ticket issuance + payment confirmation in one transaction keyed on this idempotency field.
  - Schema done: unique partial index on `payments.gateway_event_id` (migration 2 above). The webhook handler itself, and wrapping ticket issuance/payment confirmation in a transaction keyed on it, is Phase 1 (`PaymentsModule`).

- [x] **Define organizer verification levels.**
  - Change `organizers.verified` boolean → `verification_level` enum (`unverified | email_verified | phone_verified | document_verified`).
  - Add `auto_approve_events` boolean, computed or manually set by admin, for organizers at `document_verified` level with a clean track record (no rejected/flagged events in last N).
  - Done via `1670000000004-AddOrganizerVerificationLevel` (backfilled from the old `verified` boolean, kept as a deprecated column). The auto-approval *branch in the approval workflow* that reads `auto_approve_events` is Phase 1.

**Also fixed while verifying this phase:** a pre-existing, unrelated bug where signed `ticket_code` JWTs (~260+ chars) didn't fit in `event_bookings.ticket_code varchar(255)`, silently breaking every confirmed enrollment. Widened to `text` via `1670000000005-WidenTicketCodeColumn`.

Run and commit all migrations before starting Phase 1. **(Done — all 6 migrations through `1670000000006` applied to the live DB.)**

---

## Phase 1 — Core backend logic (NestJS)

- [x] **EventsModule**: add endpoints for CRUD on `ticket_types` nested under an event (organizer-only, pre-approval only — ticket types lock once event is approved and has sales, allow only adding new tiers not editing sold ones).
  - Done: `GET/POST /events/:id/ticket-types` + `PATCH/DELETE /events/:id/ticket-types/:ticketTypeId` in `EventsController`/`EventsService`. New tiers can be added at any time (including post-approval); edit/delete is blocked once a tier has `quantitySold > 0` (protects buyers rather than gating on approval status literally, per the "allow only adding new tiers not editing sold ones" clause). Public listing filters `isHidden` tiers for non-owners.
- [x] **EventsModule**: implement auto-approval branch in the approval workflow — check `organizer.auto_approve_events` before routing to admin queue; still log the event for audit even if auto-approved.
  - Done in `EventsService.createForUser()`: paid events from an organizer with `autoApproveEvents=true` are saved `APPROVED` with `approvalMethod='auto_organizer'`, and an `AuditLog` row (`event.auto_approved`) is written post-commit via the new `AuditLogService`/`AuditLogModule`.
- [x] **PaymentsModule**: implement fee calculation service per the settled formula — buyer always pays exactly `ticket_type.price`; organizer payout = `ticket_type.price − platform_commission − gateway_fee`. Expose it as a standalone endpoint callable from the "Create Event" flow (not just the payment path) so organizers see a live net-payout estimate before submitting for admin approval. Unit test this in isolation (it's the most bug-prone part of the system).
  - Done: new `PaymentsModule` (`src/payments/`). `FeeCalculationService.calculate()` is a pure function shared by both the `GET /payments/fee-estimate` preview endpoint and the actual webhook/payout settlement paths, so they can never drift from each other. Gateway fee rate is configurable (`GATEWAY_FEE_PERCENT`/`GATEWAY_FEE_FLAT`, default 2% + ₹3). 9 unit tests in `fee-calculation.service.spec.ts` cover free events, both fee-payer directions, flat-only/percent-only/combined commission models, rounding, and payout clamped at 0.
- [x] **PaymentsModule**: implement refund request → approval → gateway refund call → status update flow. Enforce the settled 48-hour cutoff (`now() < event.start_date − 48h`) at the "request refund" endpoint — reject with a clear error outside that window. Expose organizer-facing "approve/reject" endpoint and participant-facing "request refund" endpoint.
  - Done: `POST /payments/refunds` (participant), `GET /payments/refunds/pending` + `PATCH /payments/refunds/:id/approve|reject` (organizer/admin, audit-logged). Uses `Refund.canTransition()` from Phase 0. The 48h cutoff is computed from `event.eventDate`/`startTime` at request time (`REFUND_WINDOW_HOURS`, default 48). No live PayU/Razorpay integration exists yet — `processGatewayRefund()` is the single stubbed seam a real gateway call slots into; approve immediately triggers it and frees the ticket-type slot to the waitlist on success.
- [x] **PaymentsModule**: implement payout job (scheduled via NestJS `@Cron`) using the settled T+3 rule — sweep events where `now() >= event.end_date + 3 days`, batch eligible enrollments per organizer/event, mark paid. Must exclude any enrollment with an associated `Refund` in status `requested` or `approved` (not yet `processed`); pick those up in a later run once resolved.
  - Done: `PaymentsService.runPayoutSweep()` (`@Cron(EVERY_HOUR)`). Since Phase 0 didn't add an explicit `event.end_date` or payout tracking table, "event end" is derived from `eventDate` + `endTime ?? startTime` (single-day event model), and a new `payouts` table + `event_bookings.payout_id` (migration `1670000000008-AddPayouts`) track what's been swept, batched one `Payout` row per event per run. Exclusion uses a `NOT EXISTS` subquery against `refunds` (not a `LEFT JOIN`, since Postgres refuses `FOR UPDATE` across the nullable side of an outer join) under a `pessimistic_write` lock so concurrent sweep runs can't double-pay. `PAYOUT_DELAY_DAYS` configurable, default 3.
- [x] **EnrollmentModule** (or extend ParticipantModule): implement waitlist — when `quantity_sold >= quantity_total`, enrollment request creates a `WaitlistEntry` instead of failing outright; auto-promote FIFO on cancellation/refund freeing a slot.
  - Done via new `WaitlistModule`/`WaitlistService` (`src/waitlist/`) + `waitlist_entries` table (migration `1670000000007-AddWaitlistAndAuditLog`). `EventsService.enroll()` now joins the waitlist instead of throwing when the atomic capacity claim returns zero rows; a new `PATCH /events/enrollments/:enrollmentId/cancel` endpoint was added (none existed before) so cancellations can free a slot. Both cancellation and a processed refund call `WaitlistService.promoteNext()`, which walks the FIFO queue under row locks and re-uses the same atomic `UPDATE ... RETURNING` capacity claim as the primary enroll path. `GET /events/my-waitlist` lists a participant's own entries. The Phase 0 `ticket-capacity.integration-spec.ts` was updated to assert the new behavior: all 20 concurrent requests now resolve (5 confirmed, 15 waitlisted) rather than 15 rejecting, while the oversell invariant (`quantitySold` never exceeds capacity) is unchanged.
- [x] **NotificationService**: add event-change triggers — hook into `EventsModule` update endpoint so any change to date/time/venue fires a notification job to all active enrollments for that event.
  - Done via new `NotificationModule`/`NotificationService` (`src/notifications/`) + `notification_jobs` table (migration `1670000000009-AddNotificationJobs`), built generically (not just event-change) since Phase 2 explicitly says it will "reuse existing NotificationService triggers from Phase 1" for waitlist-promotion and refund-status pushes too — both are already wired up now (`notifyWaitlistPromoted`, `notifyRefundStatus`) alongside `notifyEventChanged`. No push/email transport is wired yet (that's the Phase 2 item); jobs are persisted then "delivered" by logging and marked sent immediately, so Phase 2 has a real queue table to drain instead of a bare log line.
- [x] **Add rate limiting**: apply `@nestjs/throttler` (or equivalent) to enrollment and auth endpoints to blunt scripted mass-enrollment/scalping.
  - Done: `ThrottlerModule`/`ThrottlerGuard` wired app-wide in `AppModule` (default 20 req/10s). `POST /events/:id/enroll` tightened to 5/min, all of `AuthController` tightened to 10/min, `POST /payments/webhook` (gateway callback, no user JWT) at 60/min.
- [x] **Add audit log table + interceptor**: log all AdminModule mutating actions (approve/reject event, ban user, change commission rate, resolve dispute) with actor, action, target, timestamp.
  - Done via new `AuditLogModule`/`AuditLogService` + `audit_logs` table (migration `1670000000007-AddWaitlistAndAuditLog`), plus an `@AuditAction(action, targetType)` decorator + `AuditLogInterceptor` (global `APP_INTERCEPTOR`) that logs actor/action/target/timestamp after any decorated mutation succeeds. Applied to: event approve/reject, refund approve/reject, admin create/update/remove, organizer update/remove. "Ban user" and "change commission rate" had no endpoints at all before this phase, so both were added: `commissionRate`/`commissionFlatFee`/`verificationLevel`/`autoApproveEvents` are now admin-only fields on `PATCH /organizers/:id` (migration-free, columns already existed from Phase 0), and `PATCH /admins/users/:userId/ban|unban` was added (migration `1670000000010-AddUserBanFlag`), with `AuthService.login` now rejecting banned accounts. "Resolve dispute" has no dedicated action yet — that's the Phase 3 "Dispute/refund resolution screen" item, which will get the same `@AuditAction` treatment when built.

**Schema additions made along the way** (Phase 0 didn't anticipate these; added now since Phase 1 logic depends on them): `waitlist_entries`, `audit_logs`, `payouts` + `event_bookings.payout_id`, `notification_jobs`, `users.is_banned`/`banned_reason` — migrations `1670000000007` through `1670000000010`, all applied to the live DB.

Run: `npm test` (42 unit tests passing) and `npm run test:integration` (ticket-capacity oversell + waitlist, verified green against the live DB).

---

## Phase 2 — Mobile app (React Native)

- [ ] **Event creation flow**: update organizer "Create Event" screens to support multiple ticket tiers (add/remove tier rows: name, price, quantity, sale window) instead of a single price field.
- [ ] **Event detail / enrollment flow**: show tier selector, live remaining-quantity indicator, and waitlist CTA when sold out.
- [ ] **Check-in (organizer app)**: implement offline-first scanning — cache the event's valid ticket codes locally on session start, mark scans locally, queue sync to backend when connectivity returns. This is P0-equivalent for real venue usage even though it's a Phase 2 item; do not deprioritize it below Phase 3 items.
- [ ] **Refunds**: add participant-facing "Request refund" action on ticket detail screen, and organizer-facing refund approval queue screen.
- [ ] **Follow organizer**: add follow/unfollow action on organizer profile; add "Following" filter to event discovery feed.
- [ ] **Social share + calendar add**: add native share sheet integration on event detail, and "Add to calendar" action (device calendar API).
- [ ] **Push notifications**: wire up event-change, waitlist-promotion, and refund-status notifications (reuse existing `NotificationService` triggers from Phase 1).

---

## Phase 3 — CMS / Admin dashboard (Next.js)

- [ ] **Organizer analytics dashboard** (also expose a subset of this to organizers in mobile app or a lightweight organizer web view): sales over time, ticket-type breakdown, check-in rate, revenue after commission.
- [ ] **Bulk actions**: multi-select approve/reject on the event approval queue; multi-select ban/suspend on user management.
- [ ] **Multi-role admin**: add `admin_role` enum (`content_moderator | finance_admin | super_admin`) and gate routes/actions in `AdminModule` and the Next.js dashboard accordingly.
- [ ] **Dispute/refund resolution screen**: surface `Refund` entities with status `requested`, allow admin override/escalation separate from organizer-level approval.
- [ ] **Content moderation queue**: generalize beyond reels — add a `reports` table (`reportable_type`, `reportable_id`, `reason`, `status`) so reels, profiles, and comments all funnel into one moderation queue instead of one-off reel handling.
- [ ] **Fraud flagging**: add a simple rule engine (or just a scheduled check) — flag events for manual review when `organizer.verification_level < document_verified` AND `ticket_type.price` exceeds a configurable threshold.

---

## Phase 4 — Compliance & infra hardening

- [ ] **DPDP Act (India) compliance basics**: add explicit consent capture at signup (location + interests usage), add data retention policy fields, implement a "delete my account/data" endpoint that cascades or anonymizes per policy — do this before public launch, not after.
- [ ] **CDN for media**: front Supabase Storage with a CDN (Cloudflare or Supabase's CDN layer) for event images and reels before reel traffic grows.
- [ ] **Real-time capacity/check-in sync**: adopt Supabase Realtime to push live `quantity_sold`/check-in updates to organizer dashboards and event detail screens instead of polling.

---

## Phase 5 — Growth differentiators (only after P0/P1 above are live and stable)

- [ ] Discount/promo codes on ticket types
- [ ] Custom registration form fields per event
- [ ] Organizer badges (computed from completed-events count + low refund rate)
- [ ] Public organizer profile / "storefront" page
- [ ] Instant payouts (requires working-capital/float arrangement — flag for business sign-off before building)
- [ ] Add-on merchandise sales per event
- [ ] AI-assisted event description/copy generation (LLM API call on event creation form)
- [ ] Seating charts / reserved seating (only if auditorium-style events become common)
- [ ] Sponsored placement / ads within discovery feed

---

## Execution notes for the agent

- Treat Phase 0 as a single PR/branch — it's all schema, and splitting it risks inconsistent migrations.
- Write a migration + a rollback for every schema change in Phase 0.
- Do not build Phase 2 UI for a feature before its Phase 1 backend endpoint exists and is tested.
- Flag any task above marked "decide now" / "business decision" back to the product owner before implementing — specifically: default `fee_payer`, payout cycle length, and refund window — these are not engineering calls.
- After each phase, update this file by checking off completed items rather than deleting them, so the history of what's shipped stays visible.
