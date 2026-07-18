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

## 9. Frontend — Stage 3 mobile screens (offline-first check-in, real-device testing)

Companion coverage for Phase 2 item 3: camera QR scanning (`expo-camera`) and
offline-first check-in with a reconnect sync queue. **Unlike §6-8, this cannot be
tested in a browser or emulator/simulator alone** — `expo-camera` is native code, and
airplane-mode/reconnect behavior needs a real radio, which simulators/emulators don't
reliably provide. Both require an actual physical phone.

### 9.0 Prerequisites

1. **A dev-client build is required — Expo Go will not work.** `expo-camera` is a
   native module and the app already runs on `expo-dev-client`. From `Frontend/`:
   - Fastest for local iteration: `npx expo run:android` (device connected via USB with
     USB debugging on) or `npx expo run:ios` (Mac + cable, or `eas build` for a
     non-Mac iOS build).
   - Or a shareable build: `eas build --profile development --platform android` (or
     `ios`), then install the resulting `.apk`/build on the phone.
   - If `android/`/`ios/` native folders already existed **before** the `expo-camera`
     plugin was added to `app.json`, run `npx expo prebuild --clean` first (or just use
     `eas build`, which always prebuilds fresh) — otherwise the native project won't
     have the camera permission wired in and the permission prompt in §9.1 will never
     appear correctly.
2. Point the device at a **reachable** backend — `localhost` on the phone is not your
   dev machine. Either run the backend on your machine and set `Frontend/.env.local`'s
   `EXPO_PUBLIC_API_URL` to your machine's LAN IP (e.g. `http://192.168.1.x:3000/api/`,
   phone and dev machine on the same Wi-Fi), or point it at the deployed backend URL.
   Rebuild/reload the app after changing this.
3. Log in as an **organizer** who owns at least one approved event with a confirmed
   (`paymentStatus: "paid"`) enrollment — Check In is reached from that event's owner
   actions (`EventDetailsScreen` → "Check In Attendees"). Create that enrollment via
   §8's booking flow first if you don't have one.
4. **Getting a scannable QR code**: `TicketDetailsScreen` does not yet render a real
   QR image for a ticket (`react-native-qrcode-svg` is a later Stage 6 dependency, not
   installed yet) — it currently only shows the raw `ticketCode` string as text
   underneath a placeholder pattern. To actually test the camera path (not just manual
   entry):
   - Open `TicketDetailsScreen` for the confirmed enrollment from step 3, copy the
     `ticketCode` text shown there.
   - Paste that exact string into any QR generator (e.g. a free online QR-code
     generator, or `npx qrcode-terminal "<code>"` / the Python `qrcode` package
     locally) and display the resulting QR on a second screen/monitor, or print it.
   - Manual entry (pasting the code directly into the "Ticket Code" field) is a fully
     valid substitute for exercising every check-in behavior below **except** the
     camera/permission checks in §9.1 — use it freely for §9.2-9.4 if a second screen
     isn't available.

### 9.1 Camera permission & scanning

| Action | Expect | Check |
|---|---|---|
| First time opening Check In → QR/Code tab | OS camera-permission prompt appears | Android/iOS system dialog, text matches `app.json`'s `cameraPermission` string ("Allow Eventrix to use the camera to scan attendee ticket QR codes.") |
| Deny permission | Placeholder shown instead of a live camera feed: "Camera access is needed to scan QR codes." + a "Grant Camera Access" button | No crash, manual entry field still fully usable below it |
| Tap "Grant Camera Access" after denying | Re-prompts (or, on Android if "Don't ask again" was checked, does nothing — OS-level, not app-level) | If stuck, grant manually via OS Settings → Apps → Eventrix → Permissions → Camera, then reopen the screen |
| Grant permission | Live camera preview renders in place of the placeholder | |
| Point the camera at the QR from §9.0 step 4 | Scan registers automatically — no shutter button to tap | Should fire the same check-in flow as manual entry (see §9.2), with a success/already-used/invalid alert |
| Hold the same QR in frame for several seconds after a successful scan | Only **one** check-in fires, not repeated ones per frame | Debounced: identical scanned data within ~2.5s of the last scan is ignored (`lastScanRef` in `CheckInScreen.tsx`) |
| Scan a QR encoding garbage (not a real ticketCode) | "Invalid Ticket" alert, not a crash | |

### 9.2 Online check-in (baseline regression)

With Wi-Fi/cellular on normally:

| Action | Expect | Check |
|---|---|---|
| Scan/enter a valid, not-yet-used ticket code | "✅ Checked In" alert | `POST /events/check-in` in this session succeeds; re-check via `GET /events/:id/enrollments` (Postman/DB) that `checkedInAt` is set |
| Scan/enter the same code again | "Already Checked In" alert | Backend's `ConflictException`, not a silent success |
| Switch to Search-by-Name tab | The just-checked-in attendee shows a green "✓ In" badge | Confirms `getEventEnrollments` refetches/re-tags correctly after `checkIn` (the `providesTags`/`invalidatesTags` fix) without needing to leave and re-enter the screen |

### 9.3 Offline-first check-in (airplane mode) — the core new capability

1. While still on Check In with the QR/Code tab open, **enable Airplane Mode** on the
   device.
2. Confirm the screen **stays visible and usable** — this is the regression test for
   the `NetworkGate`/`ServerGate` exemption (§3.0 of the implementation). Before that
   fix, the entire app would blank to a full-screen "You're offline" screen the instant
   connectivity dropped, making the rest of this section untestable.

| Action | Expect | Check |
|---|---|---|
| An orange/yellow banner appears near the top of the screen | "📴 Offline — check-ins are being saved locally" | |
| Scan/enter a ticket code that's in the cached attendee list and not yet checked in | "✓ Checked In (Offline)" alert — distinct wording from the online success alert | No network request needs to succeed for this — it's validated entirely against the locally cached list (`checkInCacheSlice`) |
| Switch to Search-by-Name | That attendee now shows "✓ In" immediately, and the banner's pending count increments (e.g. "· 1 pending") | Confirms the local overlay (`pendingSync`) merges into the displayed list without a network round-trip |
| Try the same ticket code again (still offline) | "Already Checked In" | Sourced from the local cache, not the backend |
| Try a ticket code that was never fetched into the cache for this event (e.g. a brand-new enrollment created after you last had connectivity) | "Invalid Ticket" with a message about reconnecting to refresh the cache | This is a real, expected limitation — the offline cache is only as fresh as the last successful online `GET /events/:id/enrollments` |
| Check in **several** different attendees while still offline | Banner's pending count increments each time | |
| **Kill the app entirely** (swipe away from app switcher) while still offline with a nonzero pending count, then reopen it | Still offline (airplane mode persists across app restarts) — reopen Check In for the same event | The banner still shows the correct pending count and the previously offline-checked-in attendees still show "✓ In" | Confirms `checkInCacheSlice` is actually persisted via `redux-persist`/`AsyncStorage`, not just in-memory |

### 9.4 Reconnect sync drain

Continuing directly from §9.3 (app reopened, still offline, nonzero pending count):

| Action | Expect | Check |
|---|---|---|
| **Disable Airplane Mode** (reconnect) | Within a few seconds, the pending count drops to 0 and the offline banner disappears | `useCheckInSyncRetry` fires on the `NetInfo` reconnect event, replaying `POST /events/check-in` for each queued ticket code |
| While this is happening, check the Network tab (if testing via `expo start` with remote debugging) or the backend logs | One `POST /events/check-in` per previously-queued ticket, each succeeding | |
| After the drain finishes, verify via `GET /events/:id/enrollments` (Postman/DB) | Every offline-checked-in attendee now shows a real `checkedInAt` timestamp from the backend, not just the locally-set one | This is the actual end-to-end proof the queue landed — a client-side "✓ In" badge alone doesn't prove the backend was updated |
| **Reconnect while the app is closed**, then reopen it | Pending count is still drained (not stuck at nonzero) | `useCheckInSyncRetry`'s mount-time check (not just its reconnect listener) drains any already-pending queue whenever the app launches online — confirms the sync isn't solely dependent on catching the exact reconnect transition while the app happens to be running |
| **Conflict case**: from a second device (or Postman, using an admin/organizer token), check in one of the same tickets **online** before the first device reconnects, then reconnect the first device | The first device's queued sync for that ticket resolves silently (no error alert, no retry loop) — the pending count still drops to 0 | The backend's "already checked in" response is treated as an already-resolved outcome by `useCheckInSyncRetry`, not a failure — by design, this does **not** currently surface a distinct "someone else already checked this ticket in" notice to the organizer; just confirm nothing crashes or retries forever |

### 9.5 Scoping regression — the gate exemption must stay narrow

Confirms §3.0's fix didn't accidentally disable the network/server gates app-wide:

| Action | Expect | Check |
|---|---|---|
| While offline (airplane mode) on Check In, navigate **back** to any other screen (e.g. Home) | The full-screen "You're offline" gate **does** appear now | Proves the exemption is scoped to the Check In screen only, not a global bypass |
| Return to Check In while still offline | Gate disappears again, Check In is usable | |
| With connectivity restored but the **backend stopped** (`Ctrl+C` the `npm run start:dev` process), open/stay on Check In | Screen stays usable (same offline-cache behavior as §9.3, since requests will fail) | `ServerGate`'s exemption |
| Navigate away from Check In while the backend is still stopped | Full-screen "We can't reach our servers right now" gate appears | Restart the backend before continuing other tests |

### 9.6 Known limitations of this pass

- No real QR is rendered anywhere in the app yet for a tester to scan directly off
  another Eventrix screen — see the workaround in §9.0 step 4. This closes once
  `react-native-qrcode-svg` is wired into `TicketDetailsScreen` (Stage 6).
- A sync conflict (same ticket checked in on two devices before either syncs) resolves
  silently rather than surfacing a distinct notice to the organizer — see §9.4's last
  row. Acceptable for v1 per the implementation plan; flag to product if a visible
  conflict notice becomes a requirement.
- This section assumes a single active Check In session per device. The sync-drain
  hook (`useCheckInSyncRetry`) does drain **all** cached events' queues, not just the
  currently open one, but this pass only exercises one event at a time.

## 10. Frontend (mobile app) — Account, Saved Events & Notifications (real-device testing)

Companion coverage for the account-data bugs fixed in this pass: `ProfileScreen`,
`EditProfileScreen`, `SavedEventsScreen`, and `NotificationsScreen` previously ran entirely
on hardcoded mock data (`MOCK_USER`/`MOCK_EVENTS`/`MOCK_NOTIFICATIONS`) with zero connection
to the real backend — every user saw the same fake identity, and "Save Changes" silently
discarded whatever was typed. This section verifies the real wiring. Each test below states
**what** is being verified, **how** to drive it, and the **exact pass condition** — if the
screen doesn't match the pass condition, the test fails and the bug isn't actually fixed.

Real-device build required (same dev-client build used for §9 — Expo Go is fine for *this*
section specifically, since nothing here touches `expo-camera` or other native modules, but
using the same dev-client build you already have is simplest).

### 10.0 Prerequisites

1. Run the two new migrations before testing anything in this section — both `Favorites`
   and `Notifications` are new tables:
   ```
   npm run typeorm migration:run
   ```
   Confirm `favorites` and `notification_jobs.read_at` exist (`\d favorites`, `\d
   notification_jobs` in `psql`, or just proceed — a missing table/column will surface as
   a 500 on the relevant request, which is itself a clear fail signal).
2. Point the device at a reachable backend (see §9.0 step 2 if you need the LAN-IP
   reminder) and log in as a real, non-demo account through the app itself.
3. Have a **second** test account (or a second device/session) available for the
   Notifications tests — some of those notifications are only generated by an organizer's
   action affecting a participant's booking.

### 10.1 Profile screen shows the real logged-in account

**What**: `ProfileScreen` (reached via the avatar icon on Home or Explore) reflects the
actual logged-in user, not a fixed mock identity.

**How**:
1. Log in as Account A. Open Profile (Home → top-right avatar, or Explore → avatar icon).
2. Note the name, email, and city shown.
3. Log out, log in as a **different** Account B. Open Profile again.

**Pass when**: Account A's profile shows Account A's real name and email (matching what
they registered with), Account B's shows Account B's — the two are visibly different, and
neither shows a name/email you didn't set up. The "Events" / "Saved" / "Bookings" numbers
in the stats row are `0`s (or accurate low counts) for a fresh account, not the old fixed
mock numbers (4 events attended, 12 saved, etc.). If a `profilePictureUrl` was ever set on
this account, a real photo renders in the avatar circle; otherwise a single-letter initial
renders (not an emoji).

### 10.2 Edit Profile actually persists

**What**: `EditProfileScreen`'s "Save Changes" writes to the real account (`PATCH
/participants/:id`) instead of just calling `navigation.goBack()`.

**How**:
1. From Profile, tap "Edit Profile".
2. Confirm the First Name / Last Name / Phone / City fields are pre-filled with your
   **real** current values (not blank, not a mock name) — this alone is a regression test,
   since the previous version always pre-filled from `MOCK_USER` regardless of who was
   logged in.
3. Change the City field to something new and distinctive (e.g. "TestCity123"). Tap "Save
   Changes".
4. Force-close the app entirely (not just background it) and reopen it. Navigate back to
   Edit Profile.

**Pass when**: Step 3 shows a brief loading state on the button then returns you to
Profile without an error. Step 4's reopened Edit Profile screen shows **"TestCity123"** —
proving the value round-tripped through the real backend and wasn't just a local, in-memory
change that reset on app restart. Also confirm the Email field is shown as **read-only**
text (not an editable input) — email changes aren't wired here on purpose (see the bug
report's rationale: changing login email needs its own verification flow).

### 10.3 Save/heart toggle on Event Details + Saved Events list

**What**: The heart icon on `EventDetailsScreen`'s hero image, and `SavedEventsScreen`,
both used to be pure local UI state / mock data with no backend connection at all.

**How**:
1. Open any approved event's details as a participant (not the owning organizer — owners
   don't see the tickets/save UI the same way).
2. Tap the heart icon in the top-right of the cover image. It should fill in
   (🤍 → ❤️) immediately.
3. Navigate back, then go to Profile → "Saved Events".
4. Return to the same event's details and tap the heart again to un-save it.
5. Go back to Saved Events.
6. **Kill the app entirely**, reopen it, log back in (if needed), and check Saved Events
   once more.

**Pass when**: After step 2, the heart shows filled (❤️). After step 3, that exact event
appears in the Saved Events list with its real title/cover image/venue (not a mock card).
After step 4, the heart reverts to empty (🤍). After step 5, the event is gone from Saved
Events. After step 6, the list still correctly reflects whatever save/unsave state you left
it in — confirming this is backend-persisted (`GET /events/my-favorites`), not just
client-side Redux state that resets on a fresh app launch.

### 10.4 Notifications list — real jobs, not mock data

**What**: `NotificationsScreen` now lists real `NotificationJob` rows via `GET
/notifications` instead of `MOCK_NOTIFICATIONS`, with working mark-as-read.

**How** (generating a real notification — pick any one of these three, using your second
test account or a Postman/organizer session for the triggering half):
- **Event-changed**: As Account A, book a ticket to an event owned by an organizer account
  you control. As the organizer, `PATCH` that event's `eventDate` or `venueName` (via the
  app's Manage Event screen, or directly via Postman if that screen doesn't exist yet).
- **Waitlist-promoted**: Book the last available ticket on a `quantityTotal: 1` tier as
  Account A, then join the waitlist for the same tier as Account B, then cancel Account A's
  booking. Account B should get promoted.
- **Refund status**: As Account A, request a refund on a paid, confirmed booking (see
  Phase 10, §3), then approve or reject it as the organizer/admin.

Then, as the account that should have received the notification:
1. Open Notifications (Profile → 🔔 Notifications, or the bell icon on Home/Explore).
2. Observe the new entry.
3. Tap the unread entry.
4. If more than one unread entry exists, tap "Mark all" in the header.

**Pass when**: Step 2 shows a new card with a **pink-tinted border**, a **bold title**, and
a small pink dot — matching one of these titles depending on which trigger you used:
"Event updated" / "You're in!" / "Refund update". The unread banner above the list
("N unread notifications") reflects the correct count. The relative time (e.g. "Just now",
"5m ago") is accurate, not a mock timestamp. Step 3 removes the bold styling and pink dot
from that card immediately (confirms `PATCH /notifications/:id/read` fired). Step 4 clears
every remaining unread card and banner at once (confirms `PATCH /notifications/read-all`).
Force-closing and reopening the app should NOT bring back the "unread" styling on
already-read notifications — if it does, the read state isn't actually persisting server-side.

---

## 11. eventrix-welcome-flow (Next.js web) — real backend auth (real-device / browser testing)

Companion coverage for the two fixes made to `eventrix-welcome-flow`: the `.env.local`
`BACKEND_URL` double-`/api` bug (login/register were completely broken against the
deployed backend before this fix), and `forgot-password`/`reset-password` being rewired
from a local demo-only user store to the real backend's OTP-based endpoints. "Real device"
here means a genuine phone/tablet browser hitting the deployed site (or your LAN IP for a
local dev server) — not just a resized desktop browser window, since mobile Safari/Chrome
have their own quirks (viewport units, autofill, on-screen keyboard covering inputs) that
a desktop-only pass won't catch.

### 11.0 Prerequisites

1. Either use the deployed site, or run `npm run dev` from `eventrix-welcome-flow/` and
   access it from a phone on the same Wi-Fi via your machine's LAN IP (`http://192.168.x.x:3000`) — `localhost` on your dev machine is not reachable from a phone.
2. Confirm `eventrix-welcome-flow/.env.local`'s `BACKEND_URL` is the **bare origin only**
   (e.g. `https://backend-one-virid-16.vercel.app`, no trailing `/api`, no trailing slash)
   — this is the fix from earlier in this pass; if it's misconfigured again, every test
   below will fail with what looks like a generic network error.
3. Have a real, already-registered account's credentials on hand, plus access to the
   backend's server console/logs (Vercel's function logs, or your local terminal running
   `npm run start:dev`) — the OTP for password reset is only ever printed there, never
   returned to the browser.

### 11.1 Login / Register — real backend round-trip (regression)

**What**: Confirms the `BACKEND_URL` fix actually holds — this is the bug that made every
login/register attempt 404 before it was fixed.

**How**:
1. On the phone, open the login page. Enter valid credentials for a real account. Submit.
2. Open the register page in a private/incognito tab (so it doesn't reuse the login
   session). Register a brand-new account with a fresh email.
3. Try logging in with an intentionally wrong password.

**Pass when**: Step 1 redirects you into the app as the correct user (name/role shown
matches the real account) — not stuck on the login page, not a generic error toast. Step 2
succeeds and lands you in the app as the new account. Step 3 shows a clear "invalid
credentials"-style error, not a network/500 error (a 500 or "service unavailable" at this
step usually means `BACKEND_URL` has regressed back to the double-`/api` bug).

### 11.2 Forgot Password — now calls the real backend OTP endpoint

**What**: `forgot-password` no longer touches the local in-memory demo store; it calls
the real `POST /auth/forgot-password`, which silently OTP-logs server-side and always
responds identically whether or not the email exists (anti-enumeration).

**How**:
1. On the phone, go to "Forgot password". Enter the email of a real, registered account.
   Submit.
2. Repeat the exact same flow, but with an email that has **never** been registered.
3. Immediately check the backend's server console/logs for a block of text like
   `PASSWORD RESET OTP FOR <email>: 123456`.

**Pass when**: Both step 1 and step 2 show the **exact same** on-screen confirmation
message ("If that email exists, a reset code has been sent.") — no visible difference that
would let someone probe which emails are registered. Neither step shows a "Demo shortcut"
box with a clickable continue-to-reset link anymore — that shortcut only existed for the
old local demo store and is correctly gone now that a real backend (which never returns
the code to the browser) is wired up. Step 3's log line appears **only** for the real,
registered email from step 1 — nothing is logged for step 2's fake email.

### 11.3 Reset Password — using the real OTP from the backend logs

**What**: `reset-password` now calls the real `POST /auth/reset-password`, validating
the 6-digit OTP against the backend's in-memory store instead of a local demo token.

**How**:
1. Continuing from §11.2, copy the 6-digit code from the backend log line.
2. On the phone, navigate to the reset-password page (manually, since there's no more
   auto-link — go to `/reset-password` and enter the code by hand when prompted, or
   however the page collects it).
3. Enter the copied code and a new password (8+ characters). Submit.
4. Try the exact same code again immediately afterward with a different new password.
5. Go back to the login page and log in with the **new** password from step 3.
6. Separately, try entering the literal digits `123456` on a **fresh** forgot-password →
   reset-password attempt (don't reuse a real code) for the same account.

**Pass when**: Step 3 succeeds and redirects toward login. Step 4 fails with an
"invalid or expired" style error — the backend deletes the OTP after first successful use,
so a same-code replay must not succeed twice. Step 5 logs in successfully with the new
password (proves the reset actually changed the real account's password on the backend,
not just a local demo record). Step 6 is a **known dev-only backend behavior, not a bug**:
`123456` is a hardcoded fallback that matches whichever OTP was most recently issued
server-side — expect it to succeed if an OTP is currently pending for any account, which is
a deliberate testing convenience on the backend, not something this frontend pass needs to
guard against.

---

## 12. Backend fixes from this pass — device-observable + Postman verification

These four fixes were found via code audit rather than a specific screen, so most of them
are verified through a mix of the mobile app (for the parts a user would actually notice)
and Postman/server logs (for the parts that aren't visible in any UI). Listed here so a
full regression pass doesn't skip them just because they don't have a dedicated screen.

### 12.1 Payout sweep now has a way to actually run in production

**What**: `PaymentsService.runPayoutSweep()`'s `@Cron(EVERY_HOUR)` never fires on Vercel
(no long-lived process). A new `GET /payments/payout-sweep` endpoint, guarded by a
`CRON_SECRET` bearer token and wired into `vercel.json`'s `crons`, is the fix.

**How** (Postman, not device — there's no UI for this):
1. Confirm `CRON_SECRET` is set as an env var on your Vercel project (this fix only works
   once you've done this yourself — it isn't set automatically).
2. `GET https://<your-backend>/api/payments/payout-sweep` with **no** `Authorization`
   header.
3. Same request, with `Authorization: Bearer wrong-value`.
4. Same request, with `Authorization: Bearer <the real CRON_SECRET value>`.

**Pass when**: Step 2 and step 3 both return `401 Unauthorized` (confirms this endpoint
can't be triggered by a random public request). Step 4 returns `200` with a body like
`{"eventsProcessed": N, "payoutsCreated": M}`. If you have a real eligible enrollment
(paid, confirmed, event ended 3+ days ago, no open refund) sitting unpaid, `M` should be
`≥1` and a new row should appear in the `payouts` table afterward.

### 12.2 Banning a user now takes effect immediately, not at next login

**What**: `JwtAuthGuard` now re-checks the user's live `isBanned`/`deletedAt` state from
the DB on every request, not just at login — a still-valid token from before a ban used to
keep working for up to its full 1-hour lifetime.

**How** (this one **is** device-observable):
1. Log into the mobile app as a test participant account (not the account you're doing the
   banning from). Leave the app open and logged in.
2. From an admin session (Postman, with an admin token), `PATCH
   /admins/users/:userId/ban` with `{"reason": "test"}`, targeting the logged-in test
   account's `userId`.
3. Immediately, on the phone, pull-to-refresh Home (or navigate to any screen that fires
   an authenticated request — Bookings, Profile, etc.) without logging out first.

**Pass when**: Step 3's request fails — the screen should show an error/loading-failed
state (exactly how depends on which screen you tested from; at minimum, the request should
not silently succeed). This proves the ban took effect on the **already-issued token**
immediately, rather than the user being able to keep using the app normally until their
token happened to expire an hour later. Afterward, confirm `POST /auth/login` with that
account's credentials also fails (the pre-existing, already-tested behavior) — then unban
the account via `PATCH /admins/users/:userId/unban` so it doesn't stay banned.

### 12.3 Refund processing is now atomic (regression check via Postman)

**What**: `processGatewayRefund` now wraps the refund-status update, enrollment-status
update, and ticket-type capacity decrement in a single DB transaction — previously these
were three separate writes with no atomicity guarantee.

**How**: This is a correctness fix for a partial-failure scenario that's hard to force
deliberately (a mid-sequence crash). The practical regression check is just re-running
Phase 10's existing refund-approval flow (§3) end-to-end and confirming all three
side effects land together:
1. Approve a valid, pending refund request (`PATCH /payments/refunds/:id/approve`).
2. Immediately check all three: `GET /events/enrollments/:enrollmentId` (should show
   `status: "refunded"`, `paymentStatus: "refunded"`), `GET /events/:id/ticket-types`
   (the tier's `quantitySold` should have decremented by the refunded quantity), and — if
   a waitlist existed for that tier — `GET /events/my-waitlist` as the waitlisted user
   (should show they were promoted).

**Pass when**: All three checks in step 2 are consistent with each other (none lag behind
or contradict the others) immediately after the approval call returns — there should be no
window where, say, the enrollment shows refunded but the tier's capacity hasn't freed up
yet.

### 12.4 Rate limiting via Redis (optional — only if you've provisioned Upstash)

**What**: `ThrottlerModule` now uses a Redis-backed store (via `@upstash/redis`) when
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set, so rate limits are shared
across Vercel's separate serverless containers instead of each container keeping its own
independent in-memory counter. **This fix only takes effect once you've provisioned an
Upstash Redis instance and set those two env vars yourself** — without them, behavior is
unchanged from before (in-memory, correct only on a single long-lived process).

**How**: If you haven't set up Upstash, skip this — there's nothing new to verify yet.
If you have:
1. Re-run §4's existing rate-limit pass (e.g. 11 requests to `/auth/*` inside 60s) against
   the deployed Vercel URL specifically (not local dev).
2. Restart/redeploy the backend (forces a fresh serverless container) mid-way through a
   burst of requests that hasn't yet hit the limit, then continue the burst past the limit
   from what Vercel may route to a new container.

**Pass when**: Step 1 still 429s at the same request count as before. Step 2 **still**
429s at the correct cumulative count even across the container restart — this is the
actual point of the fix; with the old in-memory-only storage, a fresh container would have
reset the counter to zero and let the burst continue well past the configured limit.

---

## 13. Sign-off checklist

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
- [ ] Frontend Stage 3 — offline-first check-in, **real device required** (§9): camera
      permission + QR scanning + scan debounce, online check-in baseline, offline
      check-in (banner, local validation, persists across app kill), reconnect sync
      drain (incl. drain-on-launch and same-ticket conflict resolution), NetworkGate/
      ServerGate exemption scoped to Check In only and nowhere else
- [ ] Frontend — Account, Saved Events & Notifications, **real device** (§10): Profile
      shows the real logged-in identity (not mock, differs per account), Edit Profile
      persists real changes across an app restart with email read-only, heart toggle on
      Event Details + Saved Events list round-trip through the real Favorites API and
      survive an app kill, Notifications list shows real jobs (event-changed/
      waitlist-promoted/refund-status) with working mark-read / mark-all-read that
      persists server-side
- [ ] eventrix-welcome-flow — real backend auth, **real device/browser** (§11):
      login/register `BACKEND_URL` regression check, forgot-password identical response
      for existing vs. non-existent email with no demo-shortcut box, reset-password with
      the real OTP from backend logs (incl. one-time-use and new-password login check)
- [ ] Backend fixes from this pass (§12): payout-sweep trigger endpoint 401s without/with
      wrong `CRON_SECRET` and 200s with the right one, live ban takes effect on an
      already-issued token (not just at next login), refund approval's three side effects
      (enrollment status, ticket-type capacity, waitlist promotion) land consistently
      together, Redis-backed rate limiting survives a container restart (only if Upstash
      is provisioned)
