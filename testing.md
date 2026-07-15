# testing.md — Systematic API Test Plan

Companion to `api-routes.json` (the Postman collection). This file is the checklist:
what order to run requests in, what response/status you should see at each step, which
business rules to specifically probe, and which negative/edge cases matter. Use it to
verify the whole backend end-to-end, not just that each endpoint returns 200.

## 1. Prerequisites

1. Start the server: `npm run start:dev` (default `http://localhost:3000`, prefix `/api`).
2. Confirm migrations are applied (`npm run typeorm migration:run`) and the DB has at
   least the seeded categories (`GET /categories` should return a non-empty list).
3. Import `api-routes.json` into Postman as a collection.
4. Create a Postman **environment** with the same variable names declared in the
   collection (`baseUrl`, `accessToken`, `userRole`, `userId`, `adminBootstrapId`,
   `adminId`, `organizerId`, `participantId`, `categoryId`, `categoryId2`, `categoryId3`,
   `eventId`, `ticketTypeId`, `enrollmentId`, `refundId`, `contentType`,
   `companyLogoUrl`, `ticketCode`, `name`) — the collection's `event: test` scripts write
   into these automatically on the requests that already have one (Register, Login,
   Bootstrap Admin, Create Admin, Create Participant, Create Category, Create
   Paid/Free Event, Create Ticket Type, Enroll Participant, Request Refund).
   `Enroll Participant` captures both `enrollmentId` and `ticketCode`; `Request Refund`
   captures `refundId`.
5. Requests without a capture script (most `GET`/admin CRUD requests) require you to
   copy an `id` from the previous response into the variable manually the first time —
   after that, later requests in the same folder reuse it.

**Do not run requests out of order on a fresh database.** Nearly every folder after
Auth depends on `{{accessToken}}` and a role; several depend on IDs captured earlier
(`{{categoryId}}`, `{{eventId}}`, `{{ticketTypeId}}`, `{{enrollmentId}}`).

## 2. Role model quick reference

Roles are additive on the JWT (`roles: string[]`), not exclusive:

| Role | How it's acquired |
|---|---|
| `user` | Default role on register |
| `organizer` | Auto-added the first time a user hits `POST /events` (an `Organizer` profile is auto-created too) |
| `admin` | Only via `POST /admins/bootstrap` (first admin, `@Public()`) or `POST /admins` (subsequent admins, requires an existing admin token) |

`@Public()` routes skip auth entirely. Routes with no `@Roles()` at all require *some*
valid JWT but no specific role. Routes with `@Roles('admin')` etc. 403 for anyone
without that role — expect `{"message": "Insufficient role: requires one of [admin]"}`.

## 3. Phase-by-phase test plan

Run phases in this order on a fresh database. Each row: method + path, expected status
on the happy path, and what to specifically check (not just "200 OK").

### Phase 0 — Health & Public

| Request | Expect | Check |
|---|---|---|
| `GET /` | 200 | Server is up |
| `GET /preview`, `GET /preview/api` | 200 | Sanity only |
| `GET /categories` | 200 | Non-empty array if DB is seeded |

### Phase 1 — Auth

| Request | Expect | Check |
|---|---|---|
| `POST /auth/register` | 201 | Response includes `accessToken`; `roles: ["user"]` |
| `POST /auth/register` again, same email | 4xx | Duplicate email is rejected, not silently overwritten |
| `POST /auth/login` (bootstrap admin's credentials, after Phase 2) | 201 | `accessToken` present, `roles` includes `admin` |
| `POST /auth/login` wrong password | 401 | `"Invalid email or password"` |
| `POST /auth/forgot-password` (existing email) | 200 | No email is actually sent — the 6-digit OTP is printed to the **server console log**, not returned in the response. Copy it from there. |
| `POST /auth/forgot-password` (non-existent email) | 200 | Must respond identically to the existing-email case (no user enumeration) — check the body doesn't reveal whether the account exists |
| `POST /auth/reset-password` with the OTP from the console | 200 | Password actually changes — verify with a fresh `POST /auth/login` using the new password |
| `POST /auth/reset-password` with literal `"123456"` | 200 | Dev-only fallback: matches the most recently issued OTP regardless of which email it belongs to. Confirm this only works when at least one OTP is currently pending — don't rely on it in a clean-state test |
| **Rate limit**: fire 11 requests to any `/auth/*` route inside 60s | 11th → 429 | Class-level `@Throttle({ limit: 10, ttl: 60000 })` on `AuthController` — this applies per route *and* is shared across all four auth routes, so 10 total across login+register+forgot+reset in that window trips it |

### Phase 2 — Admin bootstrap & CRUD

| Request | Expect | Check |
|---|---|---|
| `POST /admins/bootstrap` (no auth header) | 201 | Works with zero prior admins; captures `adminBootstrapId` |
| `POST /admins/bootstrap` a second time | Should still succeed (each bootstrap creates its own record) — but log in as the **first** one for the rest of this phase | Confirm bootstrap isn't a true one-time-only gate unless you've specifically implemented that; if it *should* be one-time, this is the place to catch a regression |
| `POST /auth/login` as the bootstrap admin | 201 | Capture `{{accessToken}}` |
| `POST /admins` (with admin token) | 201 | Captures `adminId` |
| `POST /admins` (with a non-admin token) | 403 | Class-level `@Roles('admin')` |
| `GET /admins`, `GET /admins/:id` | 200 | Admin-only |
| `PATCH /admins/:id` | 200 | Fields update |
| `PATCH /admins/users/:userId/ban` (body: `{ "reason": "..." }`) | 200 | Use a non-admin `userId`; afterwards that user's `POST /auth/login` should fail — verify this explicitly, it's the actual point of the ban flag |
| `PATCH /admins/users/:userId/unban` | 200 | Login succeeds again afterward |
| `DELETE /admins/:id` | 200 | Soft-deletes; confirm `GET /admins/:id` afterward 404s |

### Phase 3 — Users/me (self-service profile)

Log in as a plain `user` (from Phase 1's register) for this phase.

| Request | Expect | Check |
|---|---|---|
| `GET /users/me` | 200 | Returns the logged-in user's own record only |
| `PUT /users/me/interests` with **fewer than 3** `categoryIds` | 400 | `arrayMinSize` — 3-minimum is enforced (see `UpdateInterestsDto`) |
| `PUT /users/me/interests` with 3 IDs where **two are the same** (e.g. `[A, B, B]`) | 400, `"categoryIds must not contain duplicates"` | **Fixed** (`testing-bugs.txt` #1) — this used to silently pass (length check only) and save just the 2 distinct categories with no error at all. `ArrayUnique()` now rejects it outright |
| `PUT /users/me/interests` with 3 distinct valid `categoryIds` | 204 | Re-run `GET /users/me`, confirm `interests` array reflects the update |
| `PATCH /users/me/location` | 200/204 | `latitude`/`longitude` persist |
| `PATCH /users/me/notification-preferences` | 200/204 | Flags persist |

### Phase 4 — Participants

Note: `profileImageUrl` here is still a plain string field (see §7 for how to obtain one
via the uploads flow instead of hand-hosting it).

| Request | Expect | Check |
|---|---|---|
| `POST /participants` | 201 (this route is `@Public()`, despite the class-level `@Roles('admin')` — confirm it works **without** an auth header) | Captures `participantId`. **Fixed** (`testing-bugs.txt` #2): the response now also includes an `accessToken`, the same as `POST /auth/register` — this route creates an equally login-capable account, just via a richer form (phone/gender/dob/address), so it must log you in immediately too instead of forcing a separate `POST /auth/login` |
| `GET /participants` (no auth) | 401 | Class-level `@Roles('admin')` applies here — only `create` is public |
| `GET /participants` (admin token) | 200 | Full list |
| `GET /participants/:id` (admin token) | 200 | |
| `PATCH /participants/:id` as the **same** user | 200 | Method-level `@Roles('admin','user')` + in-handler ownership check |
| `PATCH /participants/:id` as a **different** non-admin user | 403 | `"You can only update your own profile"` |
| `PATCH /participants/:id` as admin, different target | 200 | Admin bypasses the ownership check |
| `DELETE /participants/:id` | Same ownership rule as PATCH | Confirm self-delete and admin-delete both work, cross-user delete 403s |

### Phase 5 — Organizers

**Fixed**: `OrganizerController.update`/`.remove` now carry `@Roles('admin', 'organizer')`
at the method level, overriding the class-level `@Roles('admin')` so a non-admin
organizer's request actually reaches the in-handler ownership check
(`req.user.id !== organizer.userId`) instead of 403ing at the guard first. Verified
live: register → create an event (auto-promotes to `organizer`) → re-login to pick up
the new role → `PATCH /organizers/:id` on your own record now returns 200.

| Request | Expect | Check |
|---|---|---|
| `GET /organizers`, `GET /organizers/:id` | 200 (admin token) / 403 (non-admin) | `findAll`/`findOne` have no method-level override, so these two stay pure admin-only by design — that's unchanged |
| `PATCH /organizers/:id` **as the owning organizer, non-admin token**, self-serviceable fields only (`firstName`, `lastName`, `phone`, `password`, `companyLogoUrl`) | 200 | This is the fixed path — confirm it's not 403ing at the guard |
| `PATCH /organizers/:id` as the owning organizer, but including an `ADMIN_ONLY_FIELDS` value (`commissionRate`/`commissionFlatFee`/`verificationLevel`/`autoApproveEvents`) | 403 | `"Only an admin can change commission rate or verification settings"` — the ownership check passing doesn't bypass this second, separate check |
| `PATCH /organizers/:id` as a **different** organizer (has the `organizer` role, but not this record's owner) | 403 | Now correctly reaches `"You can only update your own profile"` rather than a generic role-guard 403 |
| `PATCH /organizers/:id` as a plain `user` with no `organizer` role at all | 403 | Still blocked at the guard (`"Insufficient role: requires one of [admin, organizer]"`) — expected, they have no organizer record to own |
| `PATCH /organizers/:id` as admin, with `companyLogoUrl` set from the Uploads flow | 200 | `GET /organizers/:id` afterward must show the new `companyLogoUrl` — this is the regression test for the previously-dead field (see `multipart.md` §3.4) |
| `DELETE /organizers/:id` | Same ownership/role pattern as `PATCH` above | |

### Phase 6 — Categories

| Request | Expect | Check |
|---|---|---|
| `POST /categories` | 201 (admin) / 403 (non-admin) | Captures `categoryId` |
| `POST /categories/bulk` | 201 (admin) / 403 (non-admin) | Captures `categoryId2`/`categoryId3` from the two entries in the response array — run this **after** `POST /categories` so all three end up distinct (Phase 3's interests test now requires that — duplicates 400) |
| `GET /categories`, `GET /categories/:id` | 200, no auth needed | `@Public()` |
| `PATCH /categories/:id`, `DELETE /categories/:id` | Admin-only | |

### Phase 7 — Uploads (signed URL flow)

See `multipart.md` for the design rationale. **This is a two-step flow, and only step 1
is our backend** — step 2 is a direct-to-Supabase request that never touches our API.
Testing just step 1 (does the signed URL come back, is it gated correctly) is enough to
verify *our* code; do step 2 only if you want to confirm actual file storage works too.

#### 7.0 Prerequisites specific to this phase

1. `.env` must have `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set — watch the exact
   name: `SUPABASE_SERVICE_ROLE_KEY`, **not** the older/removed `SUPABASE_SERVICE_KEY`
   (that was a second, unused Supabase client deleted in an earlier pass — see
   `multipart.md` §3.5). If your `.env` still has the value under the old name, step 1
   itself will 503 (see the table below) and you can't proceed to step 2 at all.
2. For step 2 only: the buckets `profile-pictures`, `event-images`, `organizer-logos`
   must actually exist in your Supabase project (created in the Supabase dashboard —
   nothing in this backend provisions them). If a bucket is missing, step 2 will fail
   with a Supabase-side "bucket not found" error, unrelated to our code.
3. Have a real small image file on disk (e.g. a `.jpg` under a few hundred KB) ready to
   attach in Postman for step 2.

#### 7.1 Step 1 — get a signed URL from our API

Run one of the three "Signed URL - ..." requests in the Uploads folder, e.g. **Signed
URL - Profile Picture** (`POST /uploads/signed-url`, body `{ "purpose": "profile-picture",
"contentType": "image/jpeg" }`, `Authorization: Bearer {{accessToken}}`).

Expect `200` with a body shaped like:
```json
{
  "uploadUrl": "https://<project>.supabase.co/storage/v1/object/upload/sign/profile-pictures/users/<yourUserId>/<uuid>.jpg?token=...",
  "publicUrl": "https://<project>.supabase.co/storage/v1/object/public/profile-pictures/users/<yourUserId>/<uuid>.jpg"
}
```
Note the auth token for the upload is already embedded in `uploadUrl`'s query string —
step 2 does **not** need your `{{accessToken}}` bearer header.

Copy `uploadUrl` out of the response (or capture it into a Postman variable — see §7.4).

#### 7.2 Step 2 — actually upload the file (direct to Supabase, not our API)

Create a **new** Postman request, separate from the collection's "Signed URL - ..."
entries:

1. Method: **PUT**
2. URL: paste the `uploadUrl` you copied — use it exactly as returned, don't strip or
   re-encode the `?token=...` query string.
3. Headers: add `Content-Type` matching what you declared in step 1 (e.g.
   `image/jpeg`). Do **not** add an `Authorization` header — this request isn't
   authenticated against our API at all.
4. Body: select **binary**, then "Select File" and pick your test image.
5. Send.

Expect `200` from Supabase. A common failure here is `400`/`404` "Bucket not found" —
that means prerequisite 2 above wasn't done, not a bug in our code.

#### 7.3 Step 3 — use the uploaded file

Take `publicUrl` from step 1's response and pass it as a normal string field on the
relevant create/update call — e.g. `PATCH /participants/:id` → `profileImageUrl`,
`PATCH /organizers/:id` → `companyLogoUrl`, `POST`/`PATCH /events` →
`imageUrl`/`coverImageUrl`. Then `GET` that record back and confirm the URL round-trips,
and optionally open `publicUrl` directly in a browser to confirm the image actually
loads (only meaningful if step 2 actually succeeded).

#### 7.4 Optional: make step 1 → step 2 scriptable instead of copy-paste

Add a `test` script to each "Signed URL - ..." request that captures the response into
variables:
```js
const data = pm.response.json();
if (data && data.uploadUrl) pm.environment.set('uploadUrl', data.uploadUrl);
if (data && data.publicUrl) pm.environment.set('publicUrl', data.publicUrl);
```
Then the step-2 request's URL can just be `{{uploadUrl}}`, and step 3's body can
reference `{{publicUrl}}` directly, instead of manual copy-paste each time.

#### 7.5 Gating, validation, and edge-case checks

| Request | Expect | Check |
|---|---|---|
| `POST /uploads/signed-url` with `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` unset or misnamed in `.env` | 503, `"File uploads are not configured on this server (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)."` | **Fixed** (`testing-bugs.txt` #3) — this used to be an uncaught 500 leaking the raw `supabase-js` message `"supabaseKey is required."` |
| `POST /uploads/signed-url` with no auth header | 401 | Route requires authentication even for `profile-picture` |
| `purpose: "profile-picture"`, any authenticated role | 200 | Returns `{ uploadUrl, publicUrl }` |
| `purpose: "event-image"` or `"event-cover"` or `"company-logo"` as a plain `user` (no `organizer`/`admin` role) | 403 | `"Your role cannot request an upload URL for purpose ..."` |
| Same three purposes, as `organizer` or `admin` | 200 | |
| `contentType: "image/gif"` (or any type outside the allow-list) | 400 | Only `image/png`, `image/jpeg`, `image/jpg`, `image/heic`, `image/webp` are accepted (`@IsIn`) |
| `purpose: "avatar"` (invalid enum value) | 400 | `@IsEnum` rejection |
| Inspect the returned `uploadUrl`/`publicUrl` | — | Path should look like `{prefix}/{yourUserId}/{uuid}.{ext}` — confirm two calls in a row produce **different** paths (UUID, not overwrite-in-place) |
| **Deprecated route**: `POST /events/upload-url` with `{ "contentType": "{{contentType}}" }` | 200, behaves identically to `purpose: "event-cover"` | Confirm it now also 403s for a non-organizer/non-admin token (previously this route had no role gate at all — that's the fix, verify it actually took) |
| `POST /events/upload-url` with an invalid `contentType` | 400 | This route builds the DTO manually and bypasses `ValidationPipe`, so it re-checks the allow-list itself — confirm it isn't silently accepting anything |
| Step 2 PUT with a `Content-Type` that doesn't match what was declared in step 1 | Supabase will likely still accept it (it isn't re-validated server-side) | Not our backend's concern — the `@IsIn` check in step 1 is the actual enforcement point; step 2's `Content-Type` header only affects what gets stored as the object's mime type |

### Phase 8 — Events (core flows)

Log in as the Phase 3 `user` for creation (they'll get auto-promoted to `organizer`).

| Request | Expect | Check |
|---|---|---|
| `POST /events`, paid (`isPaid: true`, `pricePerTicket > 0`), **no `refundPolicyType`** | 400 | `"Refund policy type is required for paid events"` |
| `POST /events`, free (`pricePerTicket: 0` or omitted, `isPaid: false`) | 201, `approvalStatus: "approved"`, `approvalMethod: "auto"` | Free events always auto-approve regardless of the organizer's `autoApproveEvents` flag |
| `POST /events`, paid, organizer's `autoApproveEvents = false` (the default) | 201, `approvalStatus: "pending_approval"` | Captures `eventId`, `organizerId` |
| `POST /events` with `eventEndDate` earlier than `eventDate` | 400 | Cross-field date validation (`loophole.md` §3.4) |
| `GET /events/:id` for the **pending** event, as a **different user or guest** | 404 | Not 403 — existence of a non-approved event must not be disclosed (`findOneForViewer`) |
| `GET /events/:id` for the same pending event, as the **owning organizer or admin** | 200 | Owner/admin can preview before approval |
| `GET /events` (public list) | 200 | Should only surface `approved` events — confirm the pending one from above is absent |
| `PATCH /events/:id/approve` as non-admin | 403 | |
| `PATCH /events/:id/approve` as admin | 200, `approvalStatus: "approved"` | Now `GET /events/:id` as a guest should succeed |
| `PATCH /events/:id/approve` again (already approved) | 400 | `"Event is already approved"` |
| `PATCH /events/:id/reject` with empty `rejectionReason` | 400 | |
| `PATCH /events/:id/reject` with a reason, on a different event | 200, `approvalStatus: "rejected"` | |
| `GET /events/:id/ticket-types` for the **rejected** event, as a guest | 200, empty array `[]` | Pricing/inventory hidden from the public once rejected — even though the event record itself may 404 separately per the rule above |
| `POST /events/:id/ticket-types` on the **rejected** event | 400 | `"Cannot modify ticket types on a rejected event"` |
| `POST /events/:id/ticket-types` on the **pending** (not yet rejected/approved) event | 201 | Pending events *are* allowed to grow tiers — only rejected blocks it |
| `PATCH /events/:id` changing `eventDate`/`eventEndDate` on an **approved paid** event | 200 | Confirm `assertValidEventDateRange` still applies on update, not just create |
| `DELETE /events/:id` on an event **with an active (confirmed/pending) enrollment** | 409 | `"Cannot delete this event: N active booking(s) still exist..."` — this is the loophole.md/loophole-fix regression test, confirm it actually blocks rather than silently soft-deleting |
| `DELETE /events/:id` on an event with **no** active enrollments | 204 | |

### Phase 9 — Ticket types & enrollment

| Request | Expect | Check |
|---|---|---|
| `POST /events/:id/ticket-types` | 201 | Captures `ticketTypeId` |
| `POST /events/:id/ticket-types` with `salesEndAt` after the event's end | 400 | `assertSalesEndWithinEvent` |
| `PATCH /events/:id/ticket-types/:ticketTypeId` after it has `quantitySold > 0` | 403 | `"Cannot edit a ticket tier that already has sales"` — enroll once first, then retry this |
| `DELETE /events/:id/ticket-types/:ticketTypeId` after sales | 403 | Same lock rule |
| `GET /events/:id/ticket-types` as guest, on an **approved** event | 200 | Hidden tiers (`isHidden: true`) filtered out for non-owners |
| `POST /events/:id/enroll` on an event that isn't `approved`/`upcoming` | 400 | `"Event is not accepting enrollments"` |
| `POST /events/:id/enroll`, valid, **paid** ticket type (`price > 0`) | 201, `status: "confirmed"`, `paymentStatus: "pending"` | Captures `enrollmentId` and `ticketCode`. `paymentStatus` stays `"pending"` until `POST /payments/webhook` confirms it — see Phase 10 |
| `POST /events/:id/enroll`, valid, **free** ticket type (`price: 0`) | 201, `status: "confirmed"`, `paymentStatus: "paid"` | **Fixed** — free tickets have no gateway/webhook to ever confirm them, so `paymentStatus` is now set to `"paid"` immediately at enroll time instead of being stuck at `"pending"` forever |
| `POST /events/:id/enroll` again, same user/event | 409 | `"User already enrolled in this event"` |
| `POST /events/:id/enroll` when the ticket type is sold out (`quantitySold` == `quantityTotal`) | 201, but check the response shape — it should be a **waitlist entry**, not an enrollment | `WaitlistService.join()` fallback |
| **Rate limit**: fire 6 enroll requests inside 60s (different ticket types/events to get past the 409 duplicate check) | 6th → 429 | `@Throttle({ limit: 5, ttl: 60000 })` on `enroll` specifically |
| `GET /events/:id/enrollments` as a non-owner organizer | 403 | Ownership-gated |
| `GET /events/:id/enrollments/search?name=...` | 200 | Case-insensitive partial match on `user.fullName` |
| `GET /events/enrollments/:enrollmentId` as a different user | 403 | `"You can only view your own tickets"` |
| `PATCH /events/enrollments/:enrollmentId/cancel` | 200, `status: "cancelled"` | Confirm the ticket type's `quantitySold` decrements afterward (re-check via ticket-types list), and if a waitlist entry existed for that tier, confirm it gets auto-promoted (`GET /events/my-waitlist` as that waitlisted user should now show a promoted/confirmed state) |
| `PATCH .../cancel` twice | 400 | `"This booking is already cancelled"` |
| `POST /events/check-in` with a **paid-ticket** enrollment's `ticketCode`, called **before** `POST /payments/webhook` confirms payment | 400 | `"Cannot check in: payment for this booking is not confirmed"` — **new fix**, see §5. Run this once right after enroll to prove the gate, then re-run after Phase 10's webhook step to confirm it now succeeds |
| `POST /events/check-in` with a valid `ticketCode` once `paymentStatus: "paid"` (free ticket immediately, or paid ticket after the webhook), as the event's organizer | 200 | `checkedInAt` set |
| `POST /events/check-in` same ticket again | 409 | `"Ticket already checked in"` |
| `POST /events/check-in` as an unrelated organizer | 403 | Ownership check |

### Phase 10 — Payments

| Request | Expect | Check |
|---|---|---|
| `GET /payments/fee-estimate?ticketPrice=99.99&feePayer=organizer` | 200 | Returns the fee breakdown; cross-check the math against `FeeCalculationService` (organizer-pays: buyer pays exactly `ticketPrice`, organizer payout is net of commission+gateway fee) |
| `GET /payments/fee-estimate?ticketPrice=0` | 200, all-zero breakdown | Free-event short-circuit |
| `GET /payments/fee-estimate?feePayer=participant` | 200 | Buyer price should now be `ticketPrice + fees`, organizer payout = full `ticketPrice` |
| `POST /payments/refunds` for a **paid**-ticket enrollment, called **before** `POST /payments/webhook` confirms payment (`paymentStatus: "pending"`) | 400, `"This booking has no completed payment to refund"` | **New fix** — previously this silently succeeded (201) and could be approved/processed for money that was never actually collected; see §5. Run this once right after enroll to prove the gate is live |
| `POST /payments/webhook` for that same `enrollmentId`, `status: "success"` | 200 | Confirm via `GET /events/enrollments/:enrollmentId` that `paymentStatus` flips to `"paid"` |
| `POST /payments/refunds` again, same enrollment, **now that `paymentStatus: "paid"`** and **more than 48h before the event start** | 201, refund status `requested` | Captures `refundId` |
| `POST /payments/refunds` for an enrollment **inside the 48h cutoff** (event date < 48h out, but paid) | 400/403 | Cutoff is anchored to event **start**, not end — confirm the rejection message references the window, and is distinct from the payment-status message above |
| `POST /payments/refunds` twice for the same enrollment while one is still open | 4xx | `existingOpenRefund` check |
| `GET /payments/refunds/pending` as the event's organizer | 200 | Only that organizer's events' refunds appear |
| `GET /payments/refunds/pending` as an unrelated organizer | 200, empty | Ownership-scoped, not a 403 |
| `PATCH /payments/refunds/:id/approve` | 200, refund `status: "processed"` | Also flips the enrollment to `status: "refunded"`, `paymentStatus: "refunded"` — confirm via `GET /events/enrollments/:enrollmentId` |
| `PATCH /payments/refunds/:id/reject` with a reason | 200 | |
| `POST /payments/webhook` (`@Public()`, no auth header) | 200 | Gateway callback — confirm it works with **no** `Authorization` header |
| `POST /payments/webhook` with the **same** `gatewayEventId` twice | 200 both times, but confirm **no duplicate side effect** (enrollment `paymentStatus` shouldn't flip twice / no duplicate Payment row) | Idempotency check — this is the actual point of the test |
| `POST /payments/webhook` with `status: "failed"` | 200 | Confirm it does *not* mark the enrollment as paid |
| `POST /payments/webhook`, `status: "success"`, for an enrollment whose refund was **already approved/processed** (i.e. `status: "refunded"`) — use a fresh `gatewayEventId` to simulate a late/duplicate gateway retry | 200, but the `Payment` row is still recorded | **New fix** — confirm via `GET /events/enrollments/:enrollmentId` that `status`/`paymentStatus` **stay** `"refunded"`/`"refunded"` and are **not** flipped back to `"confirmed"`/`"paid"`. Check the server log for the `"...which is already \"refunded\"; payment recorded but enrollment left untouched"` warning — this is the exact bug found in `Backend/logs`, see §5 |
| **Rate limit**: 61 webhook calls inside 60s | 61st → 429 | `@Throttle({ limit: 60, ttl: 60000 })` |
| **Payout cron** | N/A — `@Cron(CronExpression.EVERY_HOUR)`, no manual-trigger endpoint exists | Can't be tested on-demand via Postman. To verify: create a paid enrollment, mark it paid via the webhook, set the event's date far enough in the past to clear `eventDate/eventEndDate + 3 days`, then either wait for the top of the hour or temporarily lower the interval in a local branch and watch the server log for `"Payout sweep: N payout(s) created across M candidate event(s)"`. The candidate query now also requires `paymentStatus: "paid"` (not just `status: "confirmed"`) — an enrollment stuck at `"pending"`/`"failed"` payment must never be swept into a payout |

### Phase 11 — Audit log (no query endpoint — verify via DB)

There is currently **no** `GET /audit-logs` route. `@AuditAction(...)` fires on: event
approve/reject, organizer update/remove, admin create/update/remove, user ban/unban,
refund approve/reject. To verify logging actually happened, query the `audit_logs`
table directly after exercising one of those actions:

```sql
SELECT action, target_type, target_id, actor_id, created_at
FROM audit_logs
ORDER BY created_at DESC
LIMIT 10;
```

Confirm a row appears immediately after each audited action, with the correct
`actor_id` (the caller) and `target_id` (the affected record).

## 4. Rate-limit summary (for a dedicated pass)

| Scope | Limit | Where |
|---|---|---|
| App-wide default | 20 req / 10s per client | `ThrottlerModule.forRoot()` in `app.module.ts` |
| `/auth/*` (all 4 routes share the bucket) | 10 req / 60s | `AuthController` class-level `@Throttle` |
| `POST /events/:id/enroll` | 5 req / 60s | Route-level `@Throttle` |
| `POST /payments/webhook` | 60 req / 60s | Route-level `@Throttle` |

Test each independently with a fast loop (e.g. Postman Runner or a small script) and
confirm the response is `429` with a `Retry-After`-style body once the limit is
exceeded, and that it resets after the window.

## 5. Cross-cutting things to re-verify after any future change

- **Approval-status gating**: pending/rejected events must stay invisible to the public
  on `GET /events/:id`, `GET /events/:id/ticket-types`, and blocked from new ticket
  types once rejected — but *pending* events may still grow ticket types. Only `enroll()`
  additionally requires `status: upcoming`.
- **Event deletion guard**: `DELETE /events/:id` must 409 while any `confirmed`/`pending`
  enrollment exists.
- **Multi-day event dates**: payout eligibility and "is this event over" logic must use
  `eventEndDate` (falling back to `eventDate`), never re-derive from `eventDate +
  endTime` inline — see `loophole.md`.
- **Fee-payer symmetry**: `organizer` vs `participant` fee payer must be mirror images
  (buyer pays exactly `ticketPrice` either way in total economic terms).
- **Upload content-type allow-list**: exactly `image/png`, `image/jpeg`, `image/jpg`,
  `image/heic`, `image/webp` — nothing else, on **both** `/uploads/signed-url` and the
  deprecated `/events/upload-url` forward.
- **`paymentStatus` enforcement**: `enrollment.status` reaching `"confirmed"` only means
  a ticket was reserved, not that it was paid for — that's what `paymentStatus` is for.
  Found via `Backend/logs`: a refund was requested/approved/"processed via gateway" for
  an enrollment whose `paymentStatus` was still `"pending"` (the webhook hadn't fired
  yet), and a *later*-arriving webhook then silently resurrected the refunded booking
  back to `status: "confirmed"`, `paymentStatus: "paid"`. Fixed by (1) marking free
  tickets `paymentStatus: "paid"` immediately at enroll time since no webhook will ever
  confirm them, (2) gating `POST /payments/refunds` and `POST /events/check-in` on
  `paymentStatus === "paid"`, (3) making `handleWebhook()`'s success branch a no-op for
  an enrollment that's already `"refunded"`/`"cancelled"`, and (4) requiring
  `paymentStatus: "paid"` in the payout-sweep candidate queries. Any new code path that
  treats `status: "confirmed"` as "this ticket was paid for" is a regression of this bug.
- **Class-level vs. method-level `@Roles()`**: any controller mixing a class-level
  `@Roles('admin')` with an in-handler self-service ownership check needs a matching
  method-level `@Roles()` override, or the ownership check is dead code (this was the
  `OrganizerController` bug — `ParticipantController` already had the pattern right).
  Worth a quick grep (`@Roles\(` vs. `req.user.id !==`) across controllers if this class
  of bug is suspected elsewhere.

## 6. Frontend — Stage 0 mobile screens (browser responsive testing)

Companion coverage for `Frontend/eventriximplementationplan.md`'s Stage 0 (the
foundation fixes that precede Phase 2's ticket-tier/waitlist/refund UI work). Unlike
§1-5 above, this section is manual browser testing — there is no Postman collection for
the mobile app. It exists because Stage 0 is UI + data-wiring work that a `tsc`/`jest`
pass can't fully catch (real layout, real network responses, real error states).

### 6.0 Prerequisites

1. Start the backend (`npm run start:dev`, default `http://localhost:3000`) with at
   least a few **approved** events in the DB (free and paid, at least one with a real
   `coverImageUrl`) — an empty DB will only exercise the empty-state UI, not the real
   data path.
2. `Frontend/.env.local` must have `EXPO_PUBLIC_API_URL` pointing at that backend
   (`http://localhost:3000/api/` locally) and valid `EXPO_PUBLIC_SUPABASE_URL`/
   `EXPO_PUBLIC_SUPABASE_KEY` (needed for the cover-image upload test, which PUTs
   directly to Supabase Storage).
3. From `Frontend/`: `npx expo start --web`. Open the printed `localhost` URL in
   Chrome or Edge.
4. Open DevTools (F12) → toggle the device toolbar (Ctrl+Shift+M on Windows) → pick a
   phone preset (e.g. "iPhone 14 Pro" or "Pixel 7"). These screens are built for a
   ~390-430px-wide viewport — testing at full desktop width will show stretched/broken
   layout that isn't a real bug, just the wrong test conditions.
5. Register or log in through the app's own UI (not Postman) so the RTK Query calls
   carry a real JWT via `authSlice`.

### 6.1 Screen-by-screen checks

| Screen / Action | Expect | Check |
|---|---|---|
| Home tab | Loads real events from `GET /events`, not the old hardcoded mock titles | Featured carousel + "Based on Interest"/"You Might Also Like" sections show actual seeded event titles and real cover images (not a stray URL string, not a blank box) |
| Home → tap an event card | Navigates straight into Event Details with real data | Confirm it's a real UUID driving the screen, not the old `'1'`/`'2'` mock ids |
| Explore tab | Same real-data source as Home, with its own loading/error/empty states | Load normally first; then in DevTools Network tab throttle to "Offline", reload the tab, confirm a "Couldn't load events" message with a working Retry button appears — not a stuck spinner |
| Search tab | Typing/category-chip filtering works against real events | Category chips now filter by real category names (not the old mock lowercase keys) — confirm at least one chip actually narrows the result list |
| Search — throttle to Offline before opening | Distinct error state, not a false "No events found" | This is the regression test for the fix — confirm you see "Couldn't load events" + Retry, and that it's visually different from the genuine empty-results state |
| Event Details — valid event | Full details render with no `undefined`/`[object Object]` text anywhere | Category name, organizer name, venue, price all populate from the real nested `category`/`organizer` fields |
| Event Details — cover image present | Real photo renders on Home's "Based on Interest"/"You Might Also Like" cards, Explore's list, Search's cards, and the Featured carousel | Regression test for the `EventInterestCard`/`MainEventCard` image-source fix — a real `coverImageUrl` must show as an actual photo in all four surfaces, not a blank tile only in some of them |
| Event Details — force a load failure (e.g. stop the backend mid-navigation, or edit the URL to a malformed id if testing web directly) | "Couldn't load this event" with working Retry and Go back buttons | No infinite spinner |
| Create Event → cover image upload | Real upload succeeds end-to-end via the fixed signed-URL flow | Pick an image; in the Network tab confirm a `POST` to `uploads/signed-url` (200, returns `{uploadUrl, publicUrl}`), then a `PUT` straight to a `supabase.co` URL (200) — then confirm the on-screen preview shows the uploaded image via `publicUrl` |
| My Bookings tab | Real enrollment history via `GET /events/my-enrollments`, not the old 4 hardcoded mock bookings | Upcoming/Previous/Cancelled tabs bucket correctly: a `refunded`/`cancelled` enrollment → Cancelled tab; a confirmed enrollment for a past-dated event → Previous; everything else → Upcoming |
| My Bookings — a paid-ticket enrollment whose webhook hasn't fired | Shows a "Pending Payment" badge, not "Confirmed" | Only testable if such an enrollment exists (see Phase 10 of §3) |
| My Bookings tab, throttled Offline | "Couldn't load your bookings" + Retry, not a blank/stuck screen | |
| **Any** `GET /events`, `GET /events/:id`, `GET /events/:id/enrollments`, or `GET /events/:id/enrollments/search` response, inspected in the Network tab | Zero occurrence of `passwordHash` anywhere in the body | Regression test for the PII-leak fix — click the request in DevTools → Response tab → search (Ctrl+F within the panel) for `passwordHash`; must find nothing under `organizer.user` or any enrollment's `user` object |

### 6.2 Known limitations of this pass

Browser/responsive testing only covers what Stage 0 actually touched: data wiring,
error/loading states, and layout. It does **not** cover camera scanning, offline
sync-queueing, push notifications, or any other native-only capability — those belong
to later Phase 2 stages and aren't built yet. This pass is a stand-in for the
data/layout-correctness portion of a real device test, not a substitute for one before
shipping.

## 7. Frontend — Stage 1 mobile screens (ticket-tier authoring)

Companion coverage for Phase 2 item 1: multi-tier ticket creation (`TicketTypeEditor`),
live fee-estimate preview, and post-creation tier management (`ManageTicketTypesScreen`).
Same manual-browser-testing setup as §6 — start there first if you haven't already.

### 7.0 Prerequisites

Everything in §6.0, plus: log in as a **brand-new account with no prior events** for at
least one pass through 7.1 — several of the checks below are regression tests for bugs
that only reproduce on a first-time organizer (no `Organizer` profile yet).

### 7.1 Create Event — ticket tiers

| Screen / Action | Expect | Check |
|---|---|---|
| Create Event → "Ticket Types" section | One blank tier row ("Tier 1") shown by default, no "Remove" link on it | A single-tier event is still the common case — shouldn't require deleting anything to get there |
| Tap "+ Add Ticket Type" | A second row ("Tier 2") appears | Both rows now show a "Remove" link (only hidden when exactly one tier remains) |
| Toggle "Free Event" **off** (paid) | Every tier row grows a "Price (INR)" field | |
| Type a price (e.g. `499`) in a tier's price field, wait ~½s | "You'll receive ₹Y/ticket after fees" appears under that field | Network tab: `GET /payments/fee-estimate?ticketPrice=499`, 200 — text should NOT appear on every keystroke, only after you pause (debounced) |
| Two tiers with the **same** price | Both show a payout hint | Confirms the fee-estimate cache is shared per price, not refetched per row (not user-visible directly, but the Network tab should show only one request for the shared price) |
| Toggle "Free Event" back **on** | Price fields disappear from all tiers | Publishing now treats every tier as ₹0 regardless of what was typed earlier |
| Tap "+ Advanced options" on a tier | Min/Max per order fields + "Sale starts"/"Sale ends" calendar pickers expand | Tapping the date fields opens a real calendar (iOS: inline calendar + Done button; Android: native dialog) — not a text box |
| Try to Publish with a tier's name left blank | Validation alert: "Every ticket type needs a name" | Blocks save |
| Try to Publish (paid) with a tier's price left blank/invalid | "Enter a valid price for ..." | |
| Set Max per order < Min per order on a tier | "Max per order can't be less than min per order for ..." | |
| Set "Sale ends" earlier than "Sale starts" on a tier | "Sale end date must be after the start date for ..." | |
| Publish a paid event with 2+ tiers (different prices/quantities) | Success dialog → redirected to My Events | Open the event (or Manage Ticket Types, §7.2) and confirm every tier you configured exists with the right name/price/quantity — this is the core Stage 1 regression test: before this stage, only a single hardcoded "General Admission" tier was ever created |
| **Cover image + tier creation together (Stage 0 interaction regression)**, brand-new account | Pick a cover image, confirm "Uploaded when you save this event" hint (no network call yet) → tap Publish → event + tiers + image all succeed | Network tab: `POST /events` (201) fires *before* `POST /uploads/signed-url` (200, not 403) — confirms the upload-after-create ordering still holds now that tier creation shares the same save path |
| **Double-submit regression**: rapidly double-tap "Publish Event" | Only one event is created | Check My Events afterward — should show exactly one new event, not two identically-named ones; only the tapped button should have shown a spinner, the other stayed as plain disabled text |
| Edit an **existing** event (tap Edit from a draft, or Manage Event → Edit) | "Ticket Types" section is replaced by a note: *"Ticket tiers are managed from 'Manage Ticket Types' on the event page..."* | No tier editor shown in edit mode at all — confirm saving the edit doesn't create/change any tiers (check Manage Ticket Types before/after, count should be unchanged) |

### 7.2 Manage Ticket Types (post-creation)

Reach this from `EventDetailsScreen` as the owning organizer: owner-actions block →
"Manage Ticket Types" (below "Manage Event").

| Screen / Action | Expect | Check |
|---|---|---|
| Open Manage Ticket Types on an event with unsold tiers | Each tier renders as an editable card (name, price, quantity, min/max, sale window, Save Changes, Remove) | |
| Change a field (e.g. price) and tap "Save Changes" | "Saved" alert; `PATCH /events/:id/ticket-types/:id` in Network tab, 200 | Re-open the screen (or check `GET /events/:id/ticket-types`) and confirm the change persisted |
| Tap "Remove" on an unsold tier | Confirm dialog ("Remove this tier?" / Cancel / Delete) | **Cancel** → nothing happens, tier still listed. **Delete** → tier disappears from the list |
| Scroll to "Add a New Tier" at the bottom, fill in name + price, tap "+ Add Ticket Type" | "Tier added" alert; new tier appears in the editable list above; form resets to blank | `POST /events/:id/ticket-types`, 201 |
| **Double-submit regression**: rapidly double-tap "+ Add Ticket Type" | Only **one** new tier is created | Count tiers before/after — this exact bug (two identical tiers from one double-tap) was caught and fixed during review; if you see two, it's regressed |
| Book a ticket against a tier (see §8) so its `quantitySold > 0`, then revisit this screen | That tier now renders as a **read-only** card: "🔒 Has sales" badge, no input fields, no Remove link, with a note explaining tiers with sales can't be edited/removed | Other, still-unsold tiers on the same event stay fully editable — the lock is per-tier, not per-event |
| Try to circumvent the lock by re-fetching after a sale (pull-to-refresh / navigate away and back) | Locked tier stays locked | Confirms this is server-enforced (`quantitySold > 0` check on the backend), not just a client-side hide |
| **Sale-window round-trip regression**: set "Sale ends" to *today's* date on a tier, Save, then re-open Manage Ticket Types (navigate away and back) | "Sale ends" still shows the **same date** you picked, not the day before | Regression test for a timezone bug found in review: dates used to be sent as UTC-midnight, which both (a) cut sales off up to a full day early, and (b) could display one day earlier than picked when re-opened. Both are fixed — this check confirms the fix holds |
| **Sale-window edge case (known nuance, not a bug)**: try setting a tier's "Sale ends" to the exact same calendar date as the event itself, on an event whose own end time is earlier in the day | May be rejected: *"salesEndAt cannot be after the event ends"* | This can legitimately happen now that "sale ends" correctly means "through the end of that day" — if you hit it, either pick the day before, or leave "Sale ends" blank (defaults to no cutoff). Not a bug to file, just worth knowing about so it isn't mistaken for one |

## 8. Frontend — Stage 2 mobile screens (tier selection, booking, waitlist)

Companion coverage for Phase 2 item 2. Requires at least one **approved** event with
2+ ticket tiers from §7 — ideally one tier with `quantityTotal: 1` so you can actually
drive it to sold-out without needing many test accounts.

### 8.0 Prerequisites

Everything in §6.0/§7.0. You'll need **two** logged-in accounts (or one account plus a
second browser/incognito window) to exercise sold-out → waitlist.

### 8.1 Tier picker & booking

| Screen / Action | Expect | Check |
|---|---|---|
| Open Event Details for a multi-tier event, as a participant (not the owner) | A "Tickets" section lists every tier: name, price, remaining count | Owner viewing their own event should **not** see this section (they get Manage Event/Manage Ticket Types/Check In instead) |
| Tap a tier row | Row highlights (pink border); a quantity stepper appears below the list, starting at that tier's `minPerOrder` | |
| Tap the stepper's `+`/`−` | Quantity changes, clamped between `minPerOrder` and `min(maxPerOrder, remaining)` | Buttons visibly dim and stop responding exactly at each boundary |
| Footer button while an available tier is selected | Reads "Book Now" | |
| Tap "Book Now" on the `quantityTotal: 1` tier | "Booked!" dialog → on dismiss, redirected to Bookings | Bookings → Upcoming tab shows the new booking |
| **Stale-cache regression**: without navigating away, look at the same tier's "remaining" count on Event Details | Immediately shows one less (or "Sold out — join waitlist") | This tier list used to only refresh after leaving and returning to the screen — confirm it now updates right after your own booking, same session |
| **Double-submit regression**: rapidly double-tap "Book Now" on a tier with 1 remaining | Only **one** booking is created | Check Bookings afterward — exactly one entry. If you instead see a raw error/crash, that's the race this fix targets — should get a clean rejection, not a 500 |
| From a **second** account, select the now-sold-out tier | Row shows "Sold out — join waitlist" in red; footer button reads "Join Waitlist" | |
| Tap "Join Waitlist" | Dialog: "You're on the Waitlist" — "You're #1 in line for '<tier name>'" → on dismiss, redirected to Bookings | |
| Bookings → **Waitlist** tab (new 4th tab, between Previous and Cancelled) | Shows the waitlist entry: event title, "#1 in line" badge, tier name, quantity | |
| Try joining the same tier's waitlist again with the same account | Rejected — "You are already on the waitlist for this ticket type" | No duplicate waitlist entries |

### 8.2 Sale-window-aware tier states

Using a tier configured in §7.1 with a future "Sale starts" date, and one with a past
"Sale ends" date:

| Screen / Action | Expect | Check |
|---|---|---|
| Tier with a future "Sale starts" date | Row shows *"On sale from &lt;date&gt;"* in italic, greyed out, **not tappable** | If it's the only/first tier, the footer should show "Not on Sale Yet" and stay disabled |
| Tier with a past "Sale ends" date | Row shows *"Sales closed"* in italic, greyed out, not tappable | Footer shows "Sales Closed" if selected |
| Attempt to force-book a closed/not-yet-open tier anyway (e.g. via direct API call with its `ticketTypeId`, bypassing the UI) | `POST /events/:id/enroll` → 400, *"Ticket sales have not started yet..."* / *"...have ended..."* | Confirms this is enforced server-side, not just hidden in the UI |

### 8.3 Waitlist promotion

Requires a confirmed booking + at least one waitlisted user on the same sold-out tier
(from §8.1).

| Screen / Action | Expect | Check |
|---|---|---|
| Cancel the confirmed booking (from `TicketDetailsScreen`, if a cancel action is wired up — otherwise via `PATCH /events/enrollments/:id/cancel` directly) | The tier's capacity frees up | |
| Re-check the waitlisted account's Bookings → Waitlist tab | The entry is **gone** from Waitlist | It should now appear as a real confirmed booking under Upcoming instead — this is `WaitlistService.promoteNext()` firing off the cancellation |

### 8.4 Known limitations of this pass

- No "leave waitlist" action exists in the UI (or the backend) — explicitly out of scope
  per the Phase 2 plan; joining is one-directional until promoted or the event passes.
- `isHidden` and `accessPassword` tier fields (password-gated/invite-only tiers) are
  supported by the backend DTO but not exposed anywhere in `TicketTypeEditor` or
  `ManageTicketTypesScreen` — out of scope for this stage.
- Camera-based check-in, offline sync, and push notifications are still not built
  (later Phase 2 stages) — not covered here.

## 9. Sign-off checklist

- [ ] Phase 0 — Health & Public
- [ ] Phase 1 — Auth (incl. rate limit)
- [ ] Phase 2 — Admin bootstrap/CRUD/ban
- [ ] Phase 3 — Users/me self-service
- [ ] Phase 4 — Participants CRUD + ownership
- [ ] Phase 5 — Organizers CRUD + self-service gap verified either way
- [ ] Phase 6 — Categories CRUD
- [ ] Phase 7 — Uploads signed-URL + content-type allow-list
- [ ] Phase 8 — Events core flow (approval, visibility, deletion guard)
- [ ] Phase 9 — Ticket types & enrollment (incl. waitlist, rate limit)
- [ ] Phase 10 — Payments (fee estimate, refunds, webhook idempotency)
- [ ] Phase 11 — Audit log DB spot-check
- [ ] Rate-limit summary pass (§4)
- [ ] Cross-cutting checks (§5)
- [ ] Frontend Stage 0 — browser responsive pass (§6): Home/Explore/Search real-data +
      error states, Event Details real data + error state, cover-image upload,
      My Bookings real data + bucketing, `passwordHash` leak regression check
- [ ] Frontend Stage 1 — ticket-tier authoring (§7): multi-tier create + fee-estimate
      preview + validation, cover-image/tier-creation interaction, double-submit
      regression on Publish, Manage Ticket Types add/edit/delete + lock-on-sale,
      double-submit regression on Add Ticket Type, sale-window round-trip regression
- [ ] Frontend Stage 2 — tier selection & waitlist (§8): tier picker + quantity stepper,
      book a tier to sold-out, stale-cache regression, double-submit regression on Book
      Now, waitlist join + position display, sale-window-aware tier states (server-side
      enforced), waitlist auto-promotion on cancellation
