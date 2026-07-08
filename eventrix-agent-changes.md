# Eventrix — Consolidated Change Prompt for Coding Agent (v2 — updated after role audit)

## How to use this document
This covers every change decided on across all planning sessions, in priority order.
**Razorpay/commission integration is explicitly deferred** — do not build or modify
payment logic beyond what already exists as a skeleton, unless a section below says
otherwise.

**v2 change note**: Section 2 (role model simplification) is new, inserted based on
findings from a full RBAC audit of the actual codebase. It comes before the organizer
mobile flow section because that section's original design (a role-conditional tab
swap) turned out to rely on an assumption the audit disproved — see Section 3 for the
corrected version. Sections are renumbered from the original plan; if you were handed
an earlier version of this document, discard it in favor of this one.

For every section: run the stated audit steps FIRST and report findings before writing
any code. Do not assume a table, column, or endpoint is missing or present — verify by
reading the actual entity files, migrations, and controllers. If something described as
"new" already exists in some partial form, report it and adapt rather than duplicating it.

Work through sections in order. Do not start a section until the previous one's
acceptance criteria are met — each section assumes the previous one is functioning.

---

## SECTION 0 — Global pre-flight audit (do this once, before Section 1)

Inspect and report on:
1. Does `user_interests` table/entity exist?
2. Does `users` table have a `notification_prefs` (or similarly named) column?
3. Do these routes exist in any form, even partial: `PUT /users/me/interests`,
   `PATCH /users/me/location`, `PATCH /users/me/notification-preferences`?
4. Does a `GET /categories` endpoint exist?
5. Does `events` table have `approval_status`, `approval_method`, `is_paid`,
   `refund_policy` columns? Which already exist vs. need adding?
6. Does `enrollments` table have a ticket code / QR-related column?
7. What does `EventDetailsScreen.tsx` currently render — is there already any
   organizer-only conditional UI, even partial?
8. Confirm current tab structure in `MainNavigator.tsx`.

Report all findings before proceeding to Section 1.

---

## SECTION 1 — Onboarding data sync fix

### STATUS: COMPLETE — implemented and manually tested (kill-and-resume, end-to-end
sync, airplane mode retry, no-duplicate-sync, and 3-minimum enforcement all verified
working). Kept below for reference only. Do not redo.

Files touched: onboardingDraftSlice.ts, InterestSelectionScreen.tsx,
LocationAccessScreen.tsx, NotificationPreferencesScreen.tsx, syncOnboardingDraft.ts,
RegisterScreen.tsx, LoginScreen.tsx, HomeScreen.tsx (AppState foreground retry),
update-interests.dto.ts (ArrayMinSize(3)), users.controller.ts/users.service.ts
(three sync endpoints), migration AddOnboardingFields.

Note: this section's onboarding order (InterestSelection -> LocationAccess ->
NotificationPreferences -> Login/Register) already did NOT depend on a role-selection
step being first — no changes needed here as a result of Section 2's removal of
RoleSelectionScreen.

---

## SECTION 2 — Role model simplification & organizer registration cleanup (NEW,
do before Section 3)

### Context from audit
A full RBAC audit found the role system more complex and more broken than assumed:
- A parallel, disconnected organizer registration path (POST /organizers) exists,
  collecting institute-style metadata (accreditation, bank details, commission rate)
  and storing an approval status inside an untyped JSON blob in users.bio. Its
  verified flag is not wired to any endpoint automatically — inactive scaffolding,
  not a working feature. Decision: remove it entirely.
- The JWT only ever carries roles[0] as a single string, and RolesGuard does a strict
  single-string match, despite roles being a real array in the DB.
- POST /admins is @Public() — anyone unauthenticated can create an admin account.
- Debug fetch() calls to http://127.0.0.1:7900 are left in organizer.service.ts.
- No frontend tab-swap logic actually exists yet (all users see the same 4 tabs) —
  Section 3 below is corrected to reflect this rather than building a swap.

### Model going forward
Only admin remains a real role-based permission gate. Everything organizer-related
becomes an ownership check (event.organizerId matches the caller's organizer row)
instead of a role check. The roles array keeps 'organizer' only as a cosmetic
label/badge, auto-added on first event creation — never checked for permissions.

### STEP 0 — Security/hygiene fixes (do first)
1. Remove @Public() from POST /admins (keep only on the explicitly-guarded
   POST /admins/bootstrap, after confirming that route's "no admin exists yet" guard
   is real)
2. Remove the debug fetch() calls in organizer.service.ts (~L268, L276)

### STEP 1 — Remove institute-style organizer registration
Before deleting, confirm and report: does anything in either repo (mobile or Next.js
admin dashboard) call POST /organizers or read the institute/status fields out of
users.bio? If so, report and pause rather than breaking a live caller.

Once confirmed safe: delete POST /organizers, OrganizerService.create(),
CreateOrganizerDto, and the institute-metadata handling. Leave users.bio as a column
(still used for simple { username } metadata from normal registration) and leave the
organizers table schema as-is — it's populated differently going forward (Step 4).

### STEP 2 — Fix JWT payload and RolesGuard to use the roles array properly
- auth.service.ts (register(), login()): JWT payload carries roles: saved.roles
  (full array), not roles[0]
- jwt.util.ts: JwtPayload.roles: string[] (was role: string)
- roles.guard.ts: required.some(r => user.roles.includes(r)) (was strict
  .includes(user.role) single-string match)
- Frontend authApi.ts/authSlice.ts: User/AuthResponse carry roles: string[]
- RootNavigator.tsx: isAdmin = (user?.roles ?? []).includes('admin')
- Grep both repos for any other single-string .role usage before considering this
  step done

### STEP 3 — Convert organizer permission checks to ownership-based

| Route | Change |
|---|---|
| POST /events | Remove @Roles() entirely — any authenticated user |
| PATCH /events/:id, DELETE /events/:id | Remove @Roles(). Service checks: admin bypasses; otherwise event.organizerId must match caller's organizer row, else 403 |
| GET /events/organizer/:id | Audit first: does it verify :id belongs to the caller, or only check role? If it trusts a client-supplied ID without ownership verification, that's a privilege-escalation bug — report it. Fix by deriving the organizer from req.user.id server-side (consider renaming to GET /events/my-events) rather than trusting a param, except for admin callers |
| PATCH /events/:id/approve, /reject | No change — legitimate admin-only role gating stays exactly as-is |
| POST /events/:id/enroll | Remove @Roles() — any authenticated user |
| PUT /users/me/interests, PATCH /users/me/location, PATCH /users/me/notification-preferences | Remove @Roles() — these already only touch req.user.id's own data, role list was redundant |

### STEP 4 — Auto-create organizer profile on first event creation
In EventsService.create(), wrapped in a transaction: if no organizers row exists for
userId, create one with sensible empty defaults, and add 'organizer' to the user's
roles array (display-only, not permission-bearing) if not already present. If
organizer-row creation fails, the whole transaction (including event creation) rolls
back.

### STEP 5 — Frontend cleanup
1. Remove RoleSelectionScreen from the onboarding navigation stack entirely.
   Onboarding becomes: Splash -> Onboarding slides -> InterestSelection ->
   LocationAccess -> NotificationPreferences -> Login/Register.
2. Remove role from onboardingDraftSlice (interface, setRole reducer, all
   dispatch(setRole(...)) call sites).
3. MainNavigator.tsx — do NOT build a role-conditional tab swap (none currently
   exists; all users already see Home/Explore/Shorts/Bookings). Instead, add a
   persistent "Create Event" affordance (e.g. from Explore or Profile) and a
   MyEventsScreen reachable from ProfileScreen, both available to every
   authenticated user regardless of whether they've organized anything yet.
4. EventDetailsScreen.tsx — add (net-new, none exists today) organizer-owner
   conditional UI keyed on event.organizerId matching the user's linked organizer
   row, not on any role field: rejection-reason banner + edit/resubmit for
   rejected/draft, ticket-sales count for pending/approved.

### Edge cases
1. Existing accounts created via the now-deleted POST /organizers — their organizers
   row stays valid; institute metadata in bio becomes unused, no forced migration
   needed.
2. A user with no organized events accessing MyEventsScreen from Profile — proper
   empty state, not an error.

### Acceptance criteria
- [ ] POST /admins requires authentication
- [ ] No debug fetch() calls remain in organizer.service.ts
- [ ] POST /organizers/CreateOrganizerDto removed (confirmed nothing else called
      them first)
- [ ] JWT carries roles: string[]; RolesGuard checks array membership
- [ ] POST /events succeeds for any authenticated user, auto-creating an organizer
      row transactionally if none exists
- [ ] PATCH/DELETE /events/:id reject a non-owning, non-admin user with 403 (test
      with two different organizer accounts against each other's events)
- [ ] GET /events/organizer/:id (or its replacement) cannot be used to view another
      organizer's events by guessing/passing their ID
- [ ] Admin-only routes remain role-gated, unaffected
- [ ] RoleSelectionScreen and role in onboardingDraftSlice no longer exist
- [ ] EventDetailsScreen shows owner-only UI based on organizer-row ownership
- [ ] MyEventsScreen and event creation reachable by any authenticated user

---

## SECTION 3 — Organizer mobile flow (was Section 2 — UPDATED to remove the
role-conditional tab assumption per Section 2's findings above)

### Decision context
Organizers get full event creation/management on mobile, not just the web console.
Per Section 2, this is NOT gated by role — any authenticated user can reach it.

### 3a. Navigation — no tab swap; universal access instead
Per the audit, no tab-conditional logic currently exists, and none should be built.
Keep the 4 existing tabs (Home, Explore, Shorts, Bookings) for everyone. Add:
- A persistent "Create Event" affordance (e.g. a "+" on Explore, or an item on
  Profile) — reachable by all users
- MyEventsScreen reachable from ProfileScreen (e.g. a "My Events" list item)

### 3b. New screen — MyEventsScreen.tsx
List the user's own organized events (via their organizer row, auto-created per
Section 2 Step 4), filterable by status: All / Draft / Pending / Approved / Rejected.
Each card shows title, status badge, date, ticket count sold. Include a
[+ Create] action in the header. Empty state invites first-time creation.

### 3c. New screen — CreateEventScreen.tsx
Single form: title, description, category (dropdown), venue name + address,
date/time, duration, capacity, price per ticket or free toggle, is_online + meeting
link, cover image.

Two exit actions:
- Save as Draft -> POST /events with approvalStatus: 'draft'
- Publish/Submit -> see Section 4 for the free-vs-paid branching logic determining
  approved vs pending_approval

Route params: { eventId?: string } — omitted for create, present for edit (reuses
this screen pre-filled, hitting PATCH /events/:id).

### 3d. EventDetailsScreen.tsx — conditional UI (net-new per Section 2)
When event.organizerId matches the current user's organizer row:
- rejected -> red banner with rejection_reason + "Edit & Resubmit"
- draft -> "Edit" + "Submit for Approval"/"Publish" (per Section 4's copy logic)
- pending_approval / approved -> read-only view + ticket sales count

Extend the existing screen with conditional blocks — do not fork a separate screen.

### 3e. Backend — enrollment visibility endpoint
Ownership check per Section 2 Step 3 — admin bypasses, otherwise verify event
belongs to the caller's organizer row, else 403. No @Roles() decorator needed beyond
the global JwtAuthGuard.

### 3f. Backend — image upload via Supabase Storage
CreateEventScreen needs a cover image; events.image_url/cover_image_url columns
already exist but no upload path does. Presigned-URL pattern:
1. POST /events/upload-url returns a Supabase Storage signed URL + path
2. Mobile uploads the image directly to that signed URL
3. Mobile sends the resulting public URL back with the rest of the form

### Acceptance criteria
- [ ] Any authenticated user can reach "Create Event" and MyEventsScreen — no gate
- [ ] User can create a draft, edit it, and submit it
- [ ] Rejected events show reason and allow edit+resubmit
- [ ] A user cannot view another organizer's /events/:id/enrollments (403)
- [ ] Cover image upload works end-to-end and persists on the event record

---

## SECTION 4 — Approval workflow: free auto-publish, paid stays gated (was Section 3)

### Decision
Free events publish instantly with no admin review. Paid events still require admin
approval before becoming bookable, because real money is at risk on unvetted listings.

### 4a. Schema
ALTER TABLE events ADD COLUMN approval_method VARCHAR(20) DEFAULT NULL;
-- values: 'manual' | 'auto' | NULL (null while still pending)

### 4b. Create logic
events.service.ts create(), combined with Section 2 Step 4's organizer auto-creation
logic in the same transaction: free events get approvalStatus 'approved' with
approvalMethod 'auto' and approvedAt set immediately; paid events get
'pending_approval' with approvalMethod null.

### 4c. Close the free-to-paid loophole
In update(): if an event is switching from isPaid=false to isPaid=true, force
approvalStatus back to 'pending_approval' and approvalMethod to null, regardless of
what else is in the update payload.

### 4d. Mobile UI copy
CreateEventScreen button label depends on the paid toggle: "Publish Event" (free,
immediate) vs. "Submit for Approval" (paid, review wait).

### 4e. Admin dashboard
Approval queue (WHERE approval_status = 'pending_approval') now naturally only ever
contains paid events — confirm the query already reflects this.

### Acceptance criteria
- [ ] Free event -> approved/bookable immediately, no admin action
- [ ] Paid event -> pending_approval, invisible-to-book until admin approves
- [ ] Editing an approved free event to paid forces it back to pending_approval
- [ ] Admin approval queue contains only paid, pending events

---

## SECTION 5 — QR ticket generation + check-in (was Section 4)

### 5a. Schema
ALTER TABLE enrollments ADD COLUMN ticket_code VARCHAR(255) UNIQUE;

Signed token (JWT encoding { enrollmentId, eventId }) rather than a raw UUID, so the
scan endpoint can verify authenticity without trusting an unsigned value.

### 5b. Generate on confirmation
Whenever an enrollment transitions to confirmed (immediately for free events; after
payment webhook for paid events once Razorpay resumes), generate and store
ticket_code.

### 5c. Backend — check-in endpoint (ownership-based per Section 2, not role-based)
Verify the signed ticket token, then check: admin bypasses; otherwise the event's
organizerId must match the caller's organizer row, else 403. If already checked in,
throw a conflict rather than silently allowing a duplicate check-in.

### 5d. Mobile — organizer check-in screen
Two input methods, both required:
- QR scanner (primary) — expo-camera/expo-barcode-scanner
- Search-by-name fallback (secondary, required) — searchable list of the event's
  confirmed enrollments with a manual "Check In" button per row (covers dead phone /
  lost ticket at the door — do not ship QR-only)

### 5e. Mobile — participant ticket display
TicketDetailsScreen renders the QR from ticket_code (check for an existing QR
rendering library dependency before adding a new one).

### Acceptance criteria
- [ ] Confirmed enrollment has a signed, unique ticket_code
- [ ] Scanning a valid ticket checks in exactly once; re-scanning shows "already
      checked in," not a silent duplicate
- [ ] A non-owning, non-admin user cannot check in tickets for an event they don't own
- [ ] Search-by-name check-in works as a fallback to QR scanning
- [ ] Forged/tampered ticket codes are rejected

---

## SECTION 6 — Small fixes (was Section 5 — do alongside whichever section touches
the same files; not a separate scheduled block)

1. Guest mode guardrails — "Continue as Guest" drops into Main with no auth. Any
   protected action tapped as a guest must redirect to Login, not fail silently.
2. bookingId vs enrollmentId naming — TicketDetailsScreen route param is
   { bookingId } while the backend entity is Enrollment/enrollmentId. Map explicitly
   when wiring this screen to the API.

### Acceptance criteria
- [ ] Guest tapping a protected action is redirected to Login
- [ ] TicketDetailsScreen correctly resolves data against the actual API contract

---

## SECTION 7 — Trust/UX schema prep (was Section 6 — schema + display only; full
logic waits on Razorpay resuming)

### 7a. Refund/cancellation policy field
ALTER TABLE events ADD COLUMN refund_policy_type VARCHAR(30) DEFAULT 'no_refunds';
ALTER TABLE events ADD COLUMN refund_policy_text TEXT;

Required field on CreateEventScreen for paid events; displayed on EventDetailsScreen
before the booking button.

### 7b. Fee transparency display prep
CheckoutScreen UI shows a line-item breakdown (ticket price + platform fee = total)
using placeholder commission values for now, ready to wire to real data once
Razorpay resumes.

### Acceptance criteria
- [ ] Organizer must select a refund policy when creating a paid event
- [ ] Refund policy displays on EventDetailsScreen before checkout
- [ ] Checkout UI has the line-item breakdown layout ready

---

## EXPLICITLY DEFERRED — do not build

- Razorpay Route linked-account transfers, KYC-dependent payout logic
- Automatic refund-on-cancellation trigger (depends on Razorpay being live)
- Real commission calculation in the Section 7b checkout breakdown
- Institute-style verified-organizer tier (accreditation, bank details, admin
  approval status) — removed in Section 2 as broken/unwired scaffolding; not to be
  rebuilt unless real institutional/corporate users materialize and specifically
  need it
- Follow-organizer notifications, post-event feedback surveys, multi-tier ticketing,
  team members per organizer account, recurring events, promo codes — confirmed as
  v1.1+ roadmap

Do not implement any of the above even if a natural integration point is found while
working through Sections 1-7. Leave a clearly marked TODO comment instead.

---

## Final checklist before marking this work complete
- [ ] Section 0 audit findings were reported before any code was written
- [ ] Section 2's Step 1 audit (confirming nothing still calls POST /organizers) was
      completed before deletion
- [ ] All sections' acceptance criteria pass
- [ ] No payment/commission logic was implemented beyond existing skeleton
- [ ] All new migrations are reversible (down() methods implemented, not left empty)
- [ ] No duplicate tables/columns/endpoints were created where partial versions
      already existed
- [ ] No role-based permission check remains for organizer actions except the
      legitimate admin-only routes (approve/reject, admin CRUD)
