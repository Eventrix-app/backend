# Eventrix — Role Model Simplification & Organizer Cleanup

## Context
The audit report (`rbac_report.md`) confirmed the current role system is more complex
and more broken than assumed. This prompt fixes it by moving from role-based
permission checks to ownership-based checks everywhere except `admin`, and by
removing a parallel, half-broken organizer-registration path that isn't wired to
anything. Work through steps in order; verify each step's "before deleting/changing,
confirm" instruction before acting, since some of this touches routes that other
parts of the app might still call.

---

## STEP 0 — Security/hygiene fixes (do first, independent of everything else)

1. **`POST /admins` is currently `@Public()`** (admin.controller.ts) — any
   unauthenticated caller can create an admin account. Remove the `@Public()`
   decorator from this specific route (keep it only on `POST /admins/bootstrap`,
   which is explicitly meant to be a one-time, guarded-by-"no admin exists yet"
   bootstrap case — confirm that guard logic is actually present before assuming
   bootstrap is safe to leave public).
2. **Remove the debug `fetch()` calls** in `organizer.service.ts` (around L268, L276)
   posting to `http://127.0.0.1:7900/...`. These are leftover agent tracing calls with
   no place in the codebase.

---

## STEP 1 — Remove the institute-style organizer registration path

**Decision confirmed**: remove this entirely. It creates a second, disconnected user
account, stores approval status in an untyped JSON blob inside `users.bio`, and its
`verified` flag is "not wired to any endpoint automatically" per the audit — this is
not a working feature, it's inactive scaffolding.

Before deleting, **confirm and report**:
- Does anything on the frontend (mobile or the Next.js admin dashboard) currently
  call `POST /organizers`? Search both repos for this endpoint string before removing
  it. If something does call it, report where, and stop for confirmation rather than
  breaking that caller silently.
- Does the admin dashboard have any UI reading the `status`/institute fields out of
  `users.bio`? If so, report it — that UI will need to be removed or repointed too.

Once confirmed safe to remove:
- Delete `OrganizerController`'s `POST /organizers` route and `OrganizerService.create()`
- Delete `CreateOrganizerDto` and the institute-metadata handling (`instituteName`,
  `accreditationDetails`, `bankDetails`, `commissionRate`, `settlementCycleDays`, etc.)
- Leave `users.bio` as a column (don't drop it — it may still hold the simple
  `{ username }` metadata written by normal `POST /auth/register`), just remove the
  institute-JSON-blob usage pattern
- Leave the `organizers` table schema as-is (`company_name`, `verified`, etc.) — it's
  still used, just populated differently going forward (see Step 4)

---

## STEP 2 — Fix JWT payload and RolesGuard to use the roles array properly

Currently `roles` is a real jsonb array in the DB, but the JWT only ever carries
`roles[0]` as a single string, and `RolesGuard` does a strict single-string match.
Fix this so the array is actually used as an array:

**Backend — `auth.service.ts`** (`register()` and `login()`):
```typescript
// BEFORE
const savedRole = saved.roles?.[0] ?? 'user';
const payload: JwtPayload = { id: saved.id, email: saved.email, role: savedRole, full_name: saved.fullName };

// AFTER
const payload: JwtPayload = { id: saved.id, email: saved.email, roles: saved.roles, full_name: saved.fullName };
```
Apply the equivalent change in `login()`. Update `AuthResponseDto` to return `roles:
string[]` instead of `role: string`.

**Backend — `jwt.util.ts`**:
```typescript
export interface JwtPayload {
  id: string;
  email: string;
  roles: string[];   // was: role: string
  full_name: string;
}
```

**Backend — `roles.guard.ts`**:
```typescript
// BEFORE
if (!required.includes(user.role))
  throw new ForbiddenException(...);

// AFTER
const hasRequiredRole = required.some(r => user.roles.includes(r));
if (!hasRequiredRole)
  throw new ForbiddenException(...);
```

**Frontend — `authApi.ts` / `authSlice.ts`**:
Change `AuthResponse.role: string` and `User.role: string` to `roles: string[]`
throughout. Update every place constructing or reading `state.auth.user.role` as a
single string.

**Frontend — `RootNavigator.tsx`**:
```typescript
// BEFORE
const isAdmin = isAuthenticated && user?.role?.toLowerCase() === 'admin';

// AFTER
const isAdmin = isAuthenticated && (user?.roles ?? []).includes('admin');
```

Grep both repos for any other usage of `.role` (singular) on a user/auth object
before considering this step done — the audit found this pattern in a few places;
confirm none were missed.

---

## STEP 3 — Convert organizer permission checks from role-based to ownership-based

`admin` stays role-gated everywhere (it's a real, rare, manually-assigned permission).
Everything organizer-related becomes an ownership check instead.

**`events.controller.ts` / `events.service.ts`:**

| Route | Current | Change to |
|---|---|---|
| `POST /events` | `@Roles('admin', 'organizer')` | Remove `@Roles()` entirely — any authenticated user can create an event (global `JwtAuthGuard` still applies) |
| `PATCH /events/:id` | `@Roles('admin', 'organizer')` | Remove `@Roles()`. In the service method: if `user.roles.includes('admin')`, allow. Otherwise, verify `event.organizerId` matches the organizer row linked to `user.id` — throw `ForbiddenException` if not. |
| `DELETE /events/:id` | Same as above | Same treatment as above |
| `GET /events/organizer/:id` | `@Roles('organizer', 'admin')` | **Audit this one specifically before changing**: does the current implementation verify that the `:id` param actually belongs to the requesting user, or does it only check role and trust whatever ID is passed in? If it doesn't verify ownership of the `:id` param today, that's a privilege-escalation bug independent of this refactor — report it. Fix: derive the organizer ID from `req.user.id` server-side (e.g. rename to `GET /events/my-events`, no param needed) rather than trusting a client-supplied ID, unless the caller is admin. |
| `PATCH /events/:id/approve`, `PATCH /events/:id/reject` | `@Roles('admin')` | **No change** — this is legitimate role gating, leave exactly as-is |
| `POST /events/:id/enroll` | `@Roles('user', 'admin', 'organizer')` | Remove `@Roles()` entirely — any authenticated user can enroll, no role list needed since this is already "everyone" in practice |

**`users.controller.ts`:**
`PUT /users/me/interests`, `PATCH /users/me/location`, `PATCH /users/me/notification-preferences`
currently have `@Roles('admin', 'user', 'organizer')` — since these operate only on
`req.user.id` (the caller's own data), this role list is redundant (it's already
"anyone authenticated"). Remove `@Roles()` from these three routes entirely; the
global `JwtAuthGuard` is sufficient.

---

## STEP 4 — Auto-create organizer profile on first event creation

In `EventsService.create()`:
```typescript
async create(dto: CreateEventDto, userId: string) {
  return this.dataSource.transaction(async (manager) => {
    let organizer = await manager.findOne(Organizer, { where: { userId } });

    if (!organizer) {
      organizer = manager.create(Organizer, {
        userId,
        companyName: dto.organizerDisplayName ?? '', // or derive from user's full name
        verified: false,
      });
      await manager.save(organizer);

      // Add 'organizer' as a label on the user's roles array for display/badge
      // purposes only — NOT used for any permission check anywhere in the app.
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user.roles.includes('organizer')) {
        user.roles = [...user.roles, 'organizer'];
        await manager.save(user);
      }
    }

    const event = manager.create(Event, {
      ...dto,
      organizerId: organizer.id,
      approvalStatus: dto.isPaid ? 'pending_approval' : 'approved', // per Section 3 of main plan
    });
    return manager.save(event);
  });
}
```
Wrap in a transaction — if organizer creation fails, event creation must roll back too.

---

## STEP 5 — Frontend cleanup

1. **Remove `RoleSelectionScreen`** from the onboarding navigator stack entirely.
   Onboarding becomes: Splash → Onboarding slides → InterestSelection →
   LocationAccess → NotificationPreferences → Login/Register.
2. **Remove `role` from `onboardingDraftSlice`** — delete the field from the
   interface, the `setRole` reducer, and any `dispatch(setRole(...))` call site
   (was only in `RoleSelectionScreen`, which is now deleted).
3. **`MainNavigator.tsx`** — the audit confirmed there is currently NO tab-swap logic
   (all users already see the same 4 tabs: Home, Explore, Shorts, Bookings). Do not
   build a role-conditional swap. Instead:
   - Add a "Create Event" entry point reachable by any authenticated user — either a
     persistent affordance (e.g. a "+" button on the Explore tab or Profile screen)
     rather than a 5th tab or a role-conditional 4th tab, to avoid crowding the tab bar
     unnecessarily for users who've never organized anything
   - Add `MyEventsScreen` reachable from `ProfileScreen` (e.g. a "My Events" list
     item), showing an empty state inviting first-time event creation if the user has
     none yet — this screen renders for anyone, no role check
4. **`EventDetailsScreen.tsx`** — the audit confirmed there is currently NO
   organizer-owner conditional UI at all (this is new, not a change to something
   broken). Add: when `event.organizerId === user.id` (need to resolve this from the
   user's organizer row, not from `user.roles`), show rejection-reason banner (if
   rejected), edit/resubmit buttons (if draft/rejected), or ticket-sales count
   (if pending/approved) instead of the normal "Book Now" button.

---

## Edge cases
1. **Existing accounts created via the now-deleted `POST /organizers` path** — their
   `organizers` row remains valid and usable; their institute metadata in `bio` just
   becomes unused going forward. No migration needed to "fix" old accounts unless you
   specifically want to clean up that JSON — optional, not required for correctness.
2. **A user with `roles: ['user']` who has never created an event** tries to access
   `MyEventsScreen` from Profile — must show a proper empty state, not an error.

## Acceptance criteria
- [ ] `POST /admins` requires authentication (no longer `@Public()`)
- [ ] No debug `fetch()` calls remain in `organizer.service.ts`
- [ ] `POST /organizers` and `CreateOrganizerDto` no longer exist (confirmed nothing
      else called them first, per Step 1's audit instruction)
- [ ] JWT contains `roles: string[]`; `RolesGuard` checks array membership via `.some()`
- [ ] `POST /events` succeeds for any authenticated user with no pre-existing
      `organizers` row, auto-creating one transactionally
- [ ] `PATCH`/`DELETE /events/:id` reject a non-owning, non-admin user with 403 —
      verified by testing with two different organizer accounts against each other's events
- [ ] `GET /events/organizer/:id` (or its renamed replacement) cannot be used to view
      another organizer's events by guessing/passing their ID
- [ ] Admin-only routes (approve/reject, admin CRUD) remain role-gated, unaffected
- [ ] `RoleSelectionScreen` no longer exists anywhere in the onboarding navigation stack
- [ ] `onboardingDraftSlice` contains no `role` field
- [ ] `EventDetailsScreen` shows owner-only UI based on organizer-row ownership, not
      any role field
- [ ] `MyEventsScreen` and event creation are reachable by any authenticated user,
      with no role gate anywhere in the path

## Hard rules
- Do not delete anything in Step 1 without first confirming (and reporting) that
  nothing else in the codebase still calls it.
- Do not touch `admin` role gating anywhere — it stays exactly as it is.
- Do not attempt to rebuild institute/verified-organizer functionality — that's
  deferred indefinitely unless real institutional users materialize later.
