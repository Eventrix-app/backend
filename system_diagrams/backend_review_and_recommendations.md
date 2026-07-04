# Backend Review: Bugs, Missing Features & Recommendations

**Project:** Eventrix Backend (NestJS / TypeORM / PostgreSQL / Redis)
**Reviewed against:** `backend_architecture.md` (as of 2026-06-25)
**Purpose:** This document lists identified bugs and design flaws, missing features, and a brief implementation plan for fixing/adding each.

---

## 1. Bugs / Design Flaws

### 1.1 Duplicate enrollment relationship (`User.enrolledIn` vs `Event.participants`)
**Issue:** Both entities declare a M2M relation describing the same enrollment link. If these resolve to two different join tables (instead of one bidirectional mapping), enrollment data can drift between the two.

**Fix:**
- Confirm in code that both relations point to the **same** `@JoinTable()` (defined on only one side, e.g. `Event.participants`), and `User.enrolledIn` is just the inverse (`@ManyToMany(() => Event, event => event.participants)` with no `@JoinTable`).
- Better: replace the raw M2M with a dedicated `Enrollment` entity (see §2.1). This removes ambiguity entirely since there's now one explicit table owning the relationship.

---

### 1.2 No transactional record of enrollment (bare M2M instead of an entity)
**Issue:** A plain M2M table only stores `(userId, eventId)` pairs — no timestamp, quantity, payment reference, or status. You can't answer "when did this user enroll," "how many tickets did they buy," or "is this enrollment cancelled/refunded."

**Fix:** See §2.1 (`Enrollment`/`Ticket` entity).

---

### 1.3 Race condition on `availableTickets`
**Issue:** A read-then-write pattern (`if (hasTicketsAvailable()) { availableTickets-- }`) is not atomic. Two concurrent `POST /events/:id/enroll` requests can both pass the check before either write commits, causing overselling.

**Fix:**
- Replace the read-modify-write with a single atomic SQL statement:
  ```sql
  UPDATE events
  SET available_tickets = available_tickets - :qty
  WHERE id = :eventId AND available_tickets >= :qty
  ```
  Use TypeORM's `.decrement()` or a raw query inside `createQueryBuilder().update()`, and check `affected === 1` to confirm the decrement actually happened (0 rows affected = sold out, return 409 Conflict).
- Wrap the decrement + `Enrollment` row creation in a single DB transaction (`QueryRunner` / `DataSource.transaction()`), so either both succeed or both roll back.
- For very high contention, consider `SELECT ... FOR UPDATE` row locking on the `Event` row inside the transaction, or a Redis-backed distributed lock/semaphore keyed by `eventId` as a fast pre-check before hitting Postgres.

---

### 1.4 No idempotency on enroll endpoint
**Issue:** Network retries or double-clicks on `POST /events/:id/enroll` can create duplicate enrollments/charges for the same user.

**Fix:**
- Accept an `Idempotency-Key` header (client-generated UUID per attempt).
- Store recently-seen keys (Redis, with TTL ~24h) mapped to the resulting response; if a repeat key arrives, return the cached result instead of re-executing the enrollment logic.
- Additionally enforce a DB-level unique constraint on `(userId, eventId)` in the `Enrollment` table as a hard backstop.

---

### 1.5 Single mutually-exclusive `role` enum on `User`
**Issue:** `role: 'user' | 'admin' | 'organizer'` assumes a person is exactly one type. But `Organizer.userId` implies a `User` becomes an organizer while still being a normal attending user. A single enum can't represent "user who is also an organizer."

**Fix:**
- Drop the exclusivity. Two options:
  1. **Capability-based:** Keep `role` only for `admin` (a true privileged flag), and derive "is organizer" from `organizers.length > 0` (i.e., does this user own any `Organizer` profile). Update `RolesGuard`/`@Roles()` decorator to check both the `role` column and organizer ownership where relevant.
  2. **Array column:** Change `role` to `roles: string[]` (Postgres array or join table `UserRole`), allowing combinations like `['user', 'organizer']`.
- Recommendation: Option 1 is simpler and avoids a migration of existing role data; organizer-ness is already derivable from the `Organizer` table, so don't duplicate it as a flag.

---

### 1.6 Unguarded interaction between `approvalStatus` and `status`
**Issue:** `Event` has two independent state machines:
- `approvalStatus`: `draft → pending_approval → approved → rejected`
- `status`: `upcoming → ongoing → completed → cancelled`

Nothing documented prevents invalid combinations (e.g., `approvalStatus = 'rejected'` while `status = 'ongoing'`).

**Fix:**
- Add a guard layer in `EventsService` (or a small `EventStateMachine` helper) that validates transitions before any save, e.g.:
  - `status` can only move toward `upcoming`/`ongoing` if `approvalStatus === 'approved'`.
  - Once `approvalStatus === 'rejected'`, `status` must stay out of `upcoming`/`ongoing` (force to `cancelled` or leave undefined until resubmission).
- Encode allowed transitions as a lookup table/map rather than scattered `if` checks, so it's testable in isolation:
  ```ts
  const ALLOWED_STATUS_BY_APPROVAL: Record<ApprovalStatus, EventStatus[]> = {
    draft: [],
    pending_approval: [],
    approved: ['upcoming', 'ongoing', 'completed', 'cancelled'],
    rejected: ['cancelled'],
  };
  ```
- Call this guard inside `validateAndCalculate()` or a dedicated `service.transitionStatus()` method — not scattered across controllers.

---

### 1.7 `passwordHash` nullable with no documented auth-provider model
**Issue:** Nullable `passwordHash` suggests OAuth/social login is supported, but there's no `provider`/`providerId` column or `SocialAccount` entity. A user could end up with no password and no linked provider — permanently unable to log in.

**Fix:** See §2.2 (`AuthIdentity`/`SocialAccount` entity) — model this explicitly rather than leaving it implicit.

---

### 1.8 Validation logic placed in entity lifecycle hooks
**Issue:** `validateAndCalculate()` lives on the `Event` entity and runs on every save (including internal/admin writes like approval or cancellation), which may not want full re-validation (e.g., re-checking capacity rules on a simple `reject()` call).

**Fix:**
- Move business-rule validation into `EventsService` methods (`createEvent()`, `updateEvent()`) using DTO-level `class-validator` decorators for structural checks (URL format, non-negative numbers).
- Keep only pure, side-effect-free derived-field computation (e.g., `durationMinutes` from `startTime`/`endTime`) in a lifecycle hook (`@BeforeInsert`/`@BeforeUpdate`), since that's safe to run unconditionally.

---

### 1.9 No cascade/soft-delete policy for `Organizer` and `Event`
**Issue:** Only `User` has `deletedAt`. If an `Organizer` is hard-deleted, FK behavior on their `Event` rows is undefined in the doc — could cascade-delete historical events and any associated payment/enrollment records.

**Fix:**
- Add `deletedAt` (soft-delete) to `Organizer` and `Event` as well.
- Set FK `onDelete: 'RESTRICT'` (not `CASCADE`) for `Event.organizerId` and `Enrollment.eventId`, so deletion must go through the service layer's soft-delete path rather than the DB silently destroying records.

---

## 2. Missing Features

### 2.1 `Enrollment` (or `Ticket`) Entity — *highest priority*
**What's missing:** A real entity representing a user's enrollment/purchase for an event, replacing the bare `User`↔`Event` M2M.

**Suggested shape:**
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `userId` | uuid (FK → User) | |
| `eventId` | uuid (FK → Event) | |
| `quantity` | int | number of tickets |
| `unitPrice` | decimal(10,2) | snapshot of price at purchase time |
| `totalAmount` | decimal(10,2) | `unitPrice * quantity` |
| `status` | enum (`pending`, `confirmed`, `waitlisted`, `cancelled`, `refunded`) | |
| `checkedInAt` | Date (nullable) | for day-of check-in |
| `createdAt`/`updatedAt` | Date | |
| Unique constraint | `(userId, eventId)` | prevents duplicate enrollment |

**Implementation idea:** Add `EnrollmentModule` with `EnrollmentService`, called from `EventsController.enroll()`. The service wraps the atomic ticket decrement (§1.3) and `Enrollment` row insert in one DB transaction.

---

### 2.2 Payment / Transaction handling
**What's missing:** No entity or flow for actually charging users, despite `pricePerTicket`/`currency` existing on `Event`.

**Implementation idea:**
- Add a `Payment` entity (`id`, `enrollmentId`, `provider` e.g. `'razorpay'`/`'stripe'`, `providerPaymentId`, `amount`, `currency`, `status: 'initiated'|'succeeded'|'failed'|'refunded'`).
- Add `PaymentModule` with a webhook endpoint (`POST /payments/webhook`) that verifies provider signature and updates `Payment.status`, then triggers `Enrollment.status = 'confirmed'` only after payment success (not before).
- Keep `Enrollment.status = 'pending'` until webhook confirms — never confirm enrollment on the client's say-so alone.

---

### 2.3 Auth provider model (OAuth/social login)
**What's missing:** Explicit modeling for non-password logins, tied to §1.7.

**Implementation idea:**
- Add `AuthIdentity` entity: `id`, `userId` (FK), `provider` (`'google'|'apple'|'local'`), `providerUserId`, `createdAt`. A `User` can have multiple `AuthIdentity` rows (link multiple providers to one account).
- `passwordHash` only required when a `'local'` `AuthIdentity` exists; enforce this in `AuthService.register()` rather than at the DB level.
- Add `POST /auth/google`, `POST /auth/apple` (or a generic `POST /auth/oauth/:provider`) endpoints that upsert the `AuthIdentity` and issue a JWT.

---

### 2.4 Refresh tokens & session revocation
**What's missing:** Only `POST /auth/login` is listed — no refresh, logout, or revocation mechanism. Pure short-lived JWT with no revocation means a stolen token stays valid until expiry.

**Implementation idea:**
- Add a `RefreshToken` entity (`id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`).
- `POST /auth/login` returns a short-lived access JWT (e.g. 15 min) + a long-lived refresh token (stored hashed, sent as httpOnly cookie or response body).
- Add `POST /auth/refresh` (rotates refresh token, issues new access token) and `POST /auth/logout` (sets `revokedAt`).
- Check `revokedAt IS NULL` on every refresh attempt.

---

### 2.5 Email verification & password reset flows
**What's missing:** `isEmailVerified`/`isPhoneVerified` flags exist but no endpoints to actually set them.

**Implementation idea:**
- Add `VerificationToken` entity (`id`, `userId`, `type: 'email_verify'|'phone_verify'|'password_reset'`, `tokenHash`, `expiresAt`, `usedAt`).
- Endpoints: `POST /auth/verify-email/request`, `POST /auth/verify-email/confirm`, `POST /auth/forgot-password`, `POST /auth/reset-password`.
- Send tokens via email/SMS provider (e.g. SES/Twilio) integrated through a `NotificationModule` (see §2.7).

---

### 2.6 Rate limiting
**What's missing:** No rate limiting mentioned anywhere, especially risky on `/auth/login` (credential stuffing) and `/events/:id/enroll` (ticket-bot abuse).

**Implementation idea:**
- Use `@nestjs/throttler` with Redis storage (you already have Redis via `RedisMemcachedModule`) so limits are shared across instances.
- Apply stricter limits on `/auth/login` (e.g. 5/min per IP+email) and `/events/:id/enroll` (e.g. 10/min per user).

---

### 2.7 Notification system (email/push) for status changes
**What's missing:** Listed only as a "future enhancement," but approval/rejection/enrollment are exactly the events users need to be notified about now.

**Implementation idea:**
- Add `NotificationModule` with a `NotificationService.send(userId, template, data)` abstraction over an email provider (SES/SendGrid) and optionally push (FCM).
- Trigger from existing service methods via NestJS event emitters (`@nestjs/event-emitter`): emit `event.approved`, `event.rejected`, `enrollment.confirmed` events; have `NotificationService` listen and dispatch, decoupling notification logic from core business logic.

---

### 2.8 Pagination & filtering on list endpoints
**What's missing:** `GET /events`, `GET /participants`, `GET /organizers` have no documented pagination/sort contract — will degrade badly at scale.

**Implementation idea:**
- Add a shared `PaginationQueryDto` (`page`, `limit`, `sortBy`, `sortOrder`) used across all list endpoints, validated via `class-validator` with sane caps (e.g. `limit` max 100).
- Return a consistent envelope: `{ data: T[], meta: { total, page, limit, totalPages } }`.
- For `GET /events`, add filter params (`categoryId`, `organizerId`, `dateFrom`, `dateTo`, `isOnline`, `priceMax`) backed by the existing indexes.

---

### 2.9 File upload handling for image/URL fields
**What's missing:** `profilePictureUrl`, `companyLogoUrl`, `imageUrl`/`coverImageUrl` are just `varchar`/`text` — unclear if these are client-supplied arbitrary URLs (SSRF/XSS risk) or system-generated.

**Implementation idea:**
- Add an `UploadsModule` with `POST /uploads/presigned-url` that returns a short-lived S3/GCS pre-signed PUT URL scoped to the authenticated user.
- Client uploads directly to object storage, then sends back the resulting object URL/key to save on the entity.
- Validate on the backend that any URL field saved to `User`/`Organizer`/`Event` matches your storage bucket's domain — reject arbitrary external URLs to close the SSRF/embed-abuse risk.

---

### 2.10 Audit trail / status history
**What's missing:** No record of who approved/rejected/cancelled an event and when, beyond the single `rejectionReason` text field.

**Implementation idea:**
- Add a generic `AuditLog` entity (`id`, `entityType`, `entityId`, `action`, `actorUserId`, `metadata: jsonb`, `createdAt`).
- Write to it from a NestJS interceptor or directly inside service methods that mutate approval/status fields. Keeps a queryable history without needing per-entity history tables.

---

### 2.11 Event sub-categories
**What's missing:** Listed as future work, but cheap to add now versus a later migration once `EventCategory` rows are populated and referenced widely.

**Implementation idea:**
- Add `parentCategoryId` (self-referencing FK, nullable) directly on `EventCategory` rather than a separate `EventSubCategory` table — keeps category hierarchy in one table with recursive queries (`WITH RECURSIVE`) for tree traversal.

---

## 3. Priority Summary

| Priority | Item |
|---|---|
| 🔴 Do first | Atomic ticket decrement (§1.3), `Enrollment` entity (§2.1), idempotency on enroll (§1.4) |
| 🔴 Do first | Payment/transaction flow (§2.2) — if events are ever paid |
| 🟠 Soon | Role model fix (§1.5), approval/status guard (§1.6), refresh tokens (§2.4) |
| 🟠 Soon | Pagination contract (§2.8), rate limiting (§2.6) |
| 🟡 Later | Auth provider model (§1.7/§2.3), email verification (§2.5), notifications (§2.7) |
| 🟡 Later | Audit log (§2.10), sub-categories (§2.11), upload handling (§2.9) |
| 🟢 Cleanup | Move validation out of lifecycle hooks (§1.8), soft-delete on Organizer/Event (§1.9), fix dual enrollment relation (§1.1) |
