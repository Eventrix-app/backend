# Phase 2 (Mobile app) implementation plan

## Context

`Backend/eventrixchanges.md` Phase 0/1 (schema + core backend logic) are fully and correctly implemented and tested (verified via independent audit — 95/95 unit tests, live-DB integration test green). Phase 2 is the unchecked "Mobile app (React Native)" section — 7 items: ticket-tier creation UI, tier/waitlist enrollment UI, offline-first check-in, refunds UI, follow-organizer, share/calendar, push notifications.

Codebase analysis found the frontend is **not a blank slate** — most screens already exist (`CreateEventScreen`, `EventDetailsScreen`, `CheckInScreen`, `MyEventsScreen`, `TicketDetailsScreen`) and are wired to real RTK Query endpoints, but they predate the Phase 0/1 ticket-tier schema change and have three concrete breakages, plus the discovery feed (Home/Explore/Search) and Bookings screen are still 100% mock data:

1. **`CreateEventScreen.tsx`** sends `pricePerTicket`/`totalCapacity` only — never `ticketTypes[]`. Every event created via the app ends up with zero ticket tiers, so enroll always 400s.
2. **Home/Explore/Search** render `MOCK_EVENTS` with fake ids (`'1'`, `'2'`...) and navigate to `EventDetails` with them; `GET /events/:id` 400s on a non-UUID and `EventDetailsScreen.tsx:45` has no error branch — infinite spinner.
3. **Cover-image upload** (`CreateEventScreen.tsx:151-167`) uses `supabase.storage.uploadToSignedUrl(path, token, ...)`, but the backend's `POST /events/upload-url` / `POST /uploads/signed-url` only returns `{uploadUrl, publicUrl}` (see `Backend/multipart.md` — no `path`/`token` fields exist). Upload always fails.
4. **`BookingsScreen.tsx`** is entirely `MOCK_BOOKINGS` — there is also no `GET` endpoint on the backend today that lists a participant's own enrollments (`events.controller.ts` has per-event enrollment listing for organizers, and `getEnrollmentById` for one ticket, but nothing like `GET /events/my-enrollments`). This blocks not just Bookings but the refund/ticket-detail/waitlist UI Phase 2 also calls for, since there's no real list to launch them from.

Two Phase 2 items also require backend work that Phase 0/1 never scoped, since `eventrixchanges.md` files Phase 2 as "mobile app" only:
- **Follow organizer**: zero backend trace (`grep -ril follow Backend/src` → nothing). Needs a `follows` table/entity, endpoints, and a `following` filter on `GET /events`.
- **Push notifications**: `NotificationService.enqueue()` (`Backend/src/notifications/notification.service.ts:17-27`) persists jobs and marks them sent by logging only — "No push/email transport is wired up yet (Phase 2 item)" per its own comment. Needs an Expo push token registration endpoint + wiring `enqueue()` to actually call Expo's push API.

**Sequencing principle:** fix the foundation (Stage 0) before building on top of it — every later stage depends on real event/booking data flowing correctly. After that, follow the doc's own priority order, with the offline check-in item kept at its stated priority ("P0-equivalent... do not deprioritize below Phase 3 items") rather than pushed to the end just because it's technically hard. Follow-organizer and push notifications move to the end since they're additive and don't block the core browse→book→attend loop.

No new state-management pattern is introduced — every stage below reuses the existing RTK Query slice pattern (`src/store/services/eventsApi.ts`), the existing screen/component style (`StyleSheet.create` + `GlassSurface`/`ScreenHeader` from `src/components/common/`), and the existing offline-draft/foreground-retry pattern (`src/store/slices/onboardingDraftSlice.ts` + `src/hooks/useForegroundSyncRetry.ts`) for the one place that needs it again (offline check-in queue).

---

## Stage 0 — Foundation fixes (prerequisite to everything else)

**0a. Fix cover-image upload.** Replace the `supabase.storage.uploadToSignedUrl(...)` call in `CreateEventScreen.tsx:151-167` with the flow `Backend/multipart.md §3.6` actually specifies: call `POST /uploads/signed-url` with `{purpose: 'event-cover', contentType}`, then a plain `fetch(uploadUrl, {method: 'PUT', body: fileBlob, headers: {'Content-Type': contentType}})`, then use the returned `publicUrl` directly. Update `UploadUrlResponse` in `eventsApi.ts:72-76` to `{uploadUrl: string; publicUrl: string}` and repoint `getUploadUrl`'s mutation to `uploads/signed-url` with body `{purpose, contentType}` (drop the deprecated `events/upload-url` fileName-based call). `src/lib/supabase.ts`'s client is no longer needed for uploads after this — leave it in place only if something else still imports it (check first).

**0b. Wire Home/Explore/Search to real data with proper states.** Replace `MOCK_EVENTS` usage in `HomeScreen.tsx`, `ExploreScreen.tsx`, `SearchScreen.tsx` with `useGetEventsQuery`. Add an explicit `isError` branch to `EventDetailsScreen.tsx:45` (currently `isLoading || !event` only) rendering a retry/back state instead of an infinite spinner — reuse `ErrorGenericScreen`/`ErrorNoInternetScreen` pattern already in `navigation/types.ts` if suitable, or a simple inline error view matching `TicketDetailsScreen.tsx:36-45`'s existing `isError` pattern.

**0c. Add "my enrollments" list — backend + frontend.** Backend: add `GET /events/my-enrollments` to `EventsController`/`EventsService` (participant's own confirmed/pending/cancelled/refunded enrollments, most-recent-first — mirrors the existing `findEnrollments(eventId, ...)` organizer-facing method but filtered by `userId` across all events instead of by event). Frontend: add `getMyEnrollments` query to `eventsApi.ts`, rewrite `BookingsScreen.tsx` to consume it instead of `MOCK_BOOKINGS`, mapping `approvalStatus`/`checkedInAt`/`eventDate` into the existing upcoming/previous/cancelled tab filter logic.

---

## Stage 1 — Event creation: ticket tiers (Phase 2 item 1)

Backend already supports this fully: `CreateEventDto.ticketTypes?: CreateTicketTypeDto[]` (`Backend/src/events/dto/create-event.dto.ts:171-176`) and nested CRUD (`GET/POST/PATCH/DELETE /events/:id/ticket-types[/:ticketTypeId]`, `events.controller.ts:137-173`).

- New `src/components/events/TicketTypeEditor.tsx`: repeatable row list (name, price, quantityTotal, optional sale window, min/max per order) with add/remove, matching `CreateEventScreen.tsx`'s existing input styling.
- `CreateEventScreen.tsx`: replace the single `price`/`capacity` fields with `TicketTypeEditor` — a free event is just a single tier priced at 0, so the free/paid toggle drives whether the tier editor shows a price field, not whether tiers exist at all. `buildPayload()` sends `ticketTypes: tiers` instead of `pricePerTicket`/`totalCapacity`.
- Live payout preview: call `GET /payments/fee-estimate?ticketPrice=X` (`FeeEstimateDto`, `payments.controller.ts:21-24`) debounced per-tier as the organizer types a price, show "You'll receive ₹Y/ticket" beneath that row (settled decision #1 in `eventrixchanges.md` explicitly calls for this).
- New tier-management surface for already-created events (add tiers post-approval, edit/delete only while `quantitySold === 0` per backend rule at `events.service.ts:444-446,469-471`): a "Manage Ticket Types" action reachable from `EventDetailsScreen.tsx`'s existing owner actions block (`styles.ownerActions`, next to "Manage Event"/"Check In Attendees").
- Add `getTicketTypes`/`createTicketType`/`updateTicketType`/`deleteTicketType` to `eventsApi.ts`.

---

## Stage 2 — Event detail / enrollment flow (Phase 2 item 2)

- `EventDetailsScreen.tsx`: replace the single price/"Book Now" footer with a tier list (name, price, remaining = `quantityTotal - quantitySold`, "Sold Out" state), a quantity stepper respecting `minPerOrder`/`maxPerOrder`, and "Join Waitlist" instead of "Book Now" when the selected tier is sold out.
- `enrollEvent` mutation (`eventsApi.ts:125-131`) must send `{ticketTypeId, quantity}` (currently sends no body at all) and the response type must be widened to a discriminated union — `EventsService.enroll()` can return either a confirmed `Enrollment` or a `WaitlistEntry` (`events.service.ts:610-613`). Today the frontend type is `{id, ticketCode?}` only, so a waitlist join currently gets silently treated as a confirmed booking. Add a response field check (e.g. presence of `ticketCode`/`bookingReference` vs. a `position`/`status: 'waiting'` field returned by the waitlist join) and branch the UI accordingly (navigate to Bookings vs. show "You're #N on the waitlist").
- Add `getMyWaitlist` query (`GET /events/my-waitlist`) and surface entries somewhere reachable (a "Waitlist" tab/section on `BookingsScreen.tsx` is the natural fit, consistent with Stage 0c's rework of that screen).
- Note: backend has no waitlist-entry cancel endpoint (only `PATCH /events/enrollments/:enrollmentId/cancel` for confirmed enrollments). Leaving a waitlist voluntarily isn't in Phase 0/1 or explicitly in Phase 2's wording either — treat as optional/out-of-scope for this stage, flag to product if wanted.

---

## Stage 3 — Check-in: offline-first scanning (Phase 2 item 3, kept at stated priority)

`CheckInScreen.tsx` already has the search-by-name fallback (Phase 2's required secondary path) and a manual-code-entry placeholder with `// TODO: replace TextInput with CameraView barcode scanner once expo-camera is added`. Two gaps remain: real camera scanning, and offline-first caching/queueing.

- **Add `expo-camera`** (SDK 54's `CameraView` has built-in barcode scanning — no separate `expo-barcode-scanner`, which is deprecated). Replace the scanner placeholder block (`CheckInScreen.tsx:120-151`) with a `CameraView` using `barcodeScannerSettings={{barcodeTypes: ['qr']}}` and an `onBarcodeScanned` handler that calls the existing `handleCheckIn`. Keep manual entry as a visible fallback below the camera view, not removed.
- **Add `@react-native-community/netinfo`** for connectivity detection.
- **Offline cache**: on screen mount (session start), fetch `GET /events/:id/enrollments` (already used) and persist the confirmed list to `AsyncStorage` keyed by `eventId`, including each `ticketCode`. On scan/manual entry, first validate against the local cache (ticket exists, not already checked in) so scanning works with zero connectivity; if online, fire the real `POST /events/check-in` immediately; if offline, mark the ticket checked-in **locally** (update the cached list + push to a pending-sync queue in `AsyncStorage`) and show a distinct "✓ Checked in (offline — will sync)" state rather than the normal success alert.
- **Sync queue drain**: extend the existing `useForegroundSyncRetry.ts` pattern (or add a sibling hook using NetInfo's `addEventListener` instead of `AppState`, since reconnect — not app-foreground — is the correct trigger here) to drain the pending-sync queue by replaying `POST /events/check-in` for each queued `ticketCode` once connectivity returns, clearing each entry on success.
- This mirrors `onboardingDraftSlice.ts` + `syncOnboardingDraft.ts`'s existing local-draft-then-sync shape closely enough to copy the pattern rather than invent a new one — a small `checkInQueueSlice.ts` (or plain `AsyncStorage` helper, given this data doesn't need to survive a Redux devtools inspection) keyed by `eventId` is enough; redux-persist is already a dependency if the slice route is preferred for consistency.

---

## Stage 4 — Refunds UI (Phase 2 item 4)

Backend fully supports this: `POST /payments/refunds`, `GET /payments/refunds/pending`, `PATCH /payments/refunds/:id/approve|reject` (`payments.controller.ts`).

- New `paymentsApi.ts` RTK Query slice (mirrors `eventsApi.ts` structure) with `requestRefund`, `getPendingRefunds`, `approveRefund`, `rejectRefund` mutations/queries.
- Participant side: add a "Request Refund" action on `TicketDetailsScreen.tsx` (next to the existing "View Event" button in the footer, `styles.footer`), gated on `enrollment.status === 'confirmed'` and calling `POST /payments/refunds` with `{enrollmentId, reason}`. Surface the 48h-cutoff rejection message from the backend directly (it already returns a clear error string) rather than trying to re-derive the cutoff client-side.
- Organizer side: new `RefundApprovalScreen.tsx` listing `GET /payments/refunds/pending` with approve/reject actions (reject requires a reason — small text input, mirrors `RejectRefundDto`). Confirm whether `PaymentsService.findPendingRefundsForOrganizer` scopes by a specific event or is organizer-wide before wiring navigation — route the screen from `EventDetailsScreen.tsx`'s owner actions block if per-event, or from `MyEventsScreen.tsx`'s header if organizer-wide. Add the route to `RootStackParamList` accordingly.

---

## Stage 5 — Follow organizer (Phase 2 item 5 — needs new backend work)

No backend trace exists. Minimum viable slice:
- **Backend**: new `Follow` entity (`user_id`, `organizer_id`, `created_at`, unique on the pair) + migration; `POST/DELETE /organizers/:id/follow` (any authenticated user, toggles); a public organizer-profile read (display name, company logo, event count — check `organizer.controller.ts` first in case a suitable `GET` already exists before adding a new one); add an optional `following=true` query param to `GET /events` that joins against `follows` for the requesting user (mirrors the existing `categoryId`/`isOnline` filter pattern in `EventsController.findAll`, `events.controller.ts:52-60`).
- **Frontend**: new `OrganizerProfileScreen.tsx` (organizer name/logo/bio + their public events list) reachable by tapping an organizer's name on `EventDetailsScreen.tsx`/`MainEventCard.tsx`; follow/unfollow button on it; add a "Following" filter pill to `ExploreScreen.tsx`'s existing filter row (`FilterPills.tsx` component already exists in `components/events/`).

---

## Stage 6 — Social share + calendar add (Phase 2 item 6)

- **Add `expo-calendar`**. On `EventDetailsScreen.tsx`, add an "Add to Calendar" action (near the existing save/heart button in the hero section) that requests calendar permission and creates an event using `event.eventDate`/`startTime`/`endTime`/`venueName`.
- **Share**: React Native's built-in `Share.share({message, url})` is sufficient for a native share sheet — no new dependency needed. Add a share action on `EventDetailsScreen.tsx` and optionally `TicketDetailsScreen.tsx` (the latter already has a footer action slot next to "View Event"/refund button from Stage 4).

---

## Stage 7 — Push notifications (Phase 2 item 7 — needs new backend work)

- **Add `expo-notifications`** (and `expo-device` for the physical-device check Expo's docs require before registering).
- **Backend**: add `push_token` (nullable) to `users` (or a small `device_tokens` table if multi-device support matters — single column is enough for v1) + a `PATCH /users/me/push-token` endpoint. Extend `NotificationService.enqueue()` (`notification.service.ts:17-27`) to, after persisting the job, look up the user's push token and call Expo's push API (`expo-server-sdk` on the backend) instead of only logging — this is additive to the existing method, the persist-then-mark-sent shape stays intact as the audit trail.
- **Frontend**: register for push permissions + obtain the Expo push token on login/app start, `PATCH /users/me/push-token` with it (call site: alongside the existing `syncOnboardingDraft` call in the login/register success handlers, or the foreground-retry hook if registration should also retry). Add a foreground notification handler (`expo-notifications`' `addNotificationReceivedListener`) that at minimum shows an in-app banner/updates the existing `NotificationsScreen.tsx` list, and a tap handler that deep-links to the relevant screen (`EventDetails` for event-changed, `Bookings`/`TicketDetails` for waitlist-promoted, `TicketDetails` for refund-status) based on the `type`/`payload` shape already defined in `NotificationType`/`notification-job.entity.ts`.

---

## New dependencies to add (Frontend)

`expo-camera`, `@react-native-community/netinfo`, `expo-calendar`, `expo-notifications`, `expo-device`. All SDK-54-compatible via `npx expo install <pkg>` (not raw `npm install`, to get the correct pinned versions Expo expects). `react-native-qrcode-svg` optionally for rendering the ticket's own QR in `TicketDetailsScreen.tsx` (currently a `◦◦◦◦◦` placeholder) — uses `react-native-svg`, already a dependency.

## New dependencies to add (Backend)

`expo-server-sdk` (Stage 7 only).

---

## Verification approach (per stage, not deferred to the end)

- Stage 0: boot backend + Expo dev client, confirm cover image upload succeeds end-to-end, confirm Home/Explore/Search load real events with a visible error state on a bad id, confirm Bookings shows real enrollments.
- Stage 1: create an event with 2+ tiers including a free one, confirm `GET /events/:id/ticket-types` reflects them, confirm the fee-estimate preview number matches `FeeCalculationService`'s formula.
- Stage 2: enroll into a tier with capacity 1 twice from two accounts, confirm the second lands on the waitlist UI, not a false "booked" state.
- Stage 3: airplane-mode test — scan/enter a valid ticket code offline, confirm local check-in state shows, re-enable connectivity, confirm the queued check-in actually reaches the backend (`GET /events/:id/enrollments` shows `checkedInAt` set).
- Stage 4: request a refund before and after the 48h cutoff (adjust a test event's `eventDate` to control this), confirm both the accept and the reject-with-message paths render correctly; approve as organizer, confirm status updates.
- Stage 5: follow/unfollow round-trip, confirm the "Following" filter actually narrows the discovery feed.
- Stage 6: confirm a real calendar entry is created on-device and the native share sheet opens with the right content.
- Stage 7: confirm a push token round-trips to the backend, and that triggering `notifyEventChanged`/`notifyWaitlistPromoted`/`notifyRefundStatus` (e.g. by editing an event's date) results in an actual device notification, not just a log line.

No automated test suite currently exists for the Frontend beyond `jest.config.json`'s scaffold (`src/__tests__/`) — check what's there before deciding whether to add RTK Query mock-based unit tests per stage or rely on the manual verification above; matching existing coverage depth is enough, this plan doesn't mandate introducing a new testing standard.
