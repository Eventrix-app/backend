# Instructions for Coding Agents — Codebase Change Protocol

## Phase 1: Before touching any code

**Restate the task in your own words before starting.** If any part of the request is ambiguous (which file, which flow, which edge case), state your assumption explicitly instead of guessing silently.

**Search before creating.** Before writing a new function, component, hook, service, DTO, or type, search the codebase for existing implementations that do the same or similar thing — by name, by folder, by behavior. Reuse or extend existing code instead of duplicating logic.

**Read the full surrounding context, not just the lines being changed.** For any function/component you're editing, identify:

- Every place that calls it (upstream usages)
- Every function/service/table it depends on (downstream dependencies)
- Any shared state, context, global store, or database table it touches

**Map the blast radius before editing.** List every file that could be affected by this change — especially for shared utilities, shared types/interfaces, API routes/controllers, Prisma models, or context providers/hooks used across multiple screens.

**Follow existing conventions.** Match the codebase's current patterns for naming, file structure, error handling, state management, and API response shape. Don't introduce a new pattern when one already exists for the same purpose.

**Check for existing tests or type contracts** tied to the code being changed, so you know what "already works" and shouldn't break.

---

## Phase 2: While implementing

**Make the smallest change that satisfies the requirement.** Don't refactor, rename, or "clean up" unrelated code while making a scoped change.

**Never modify business logic silently.** If completing the task requires changing a validation rule, pricing calculation, booking/payment flow, permission check, or any core business rule beyond what was explicitly requested — stop and flag it before making that change.

**Preserve existing function signatures, API contracts, and DB schema fields** unless the task explicitly requires changing them. If a signature/schema must change, find and update every call site/consumer — don't leave stale references.

**No dead code.** No commented-out blocks, no unused imports, no unused variables/props left behind after an edit.

**No placeholder or stub logic passed off as done.** If something can't be fully implemented in this pass, say so explicitly rather than silently leaving a TODO or fake return value.

**Match existing type safety and validation standards.** Don't introduce loose typing (`any`, unchecked casts) or skip input validation where the rest of the codebase enforces it.

**Don't add new dependencies/libraries** if the task is solvable with what's already installed, unless explicitly instructed to add one.

**Handle edge cases relevant to the domain:** empty states, null/undefined inputs, unauthorized/unauthenticated access, network/API failures, race conditions — especially around auth, bookings, payments, or ticketing logic.

---

## Phase 3: Before calling it done

**Diff your change against the original request.** Confirm it does exactly what was asked — nothing extra, nothing missing.

**Check for regressions in adjacent features** that share the touched code. If you edited shared auth logic, re-verify login, signup, session refresh — not just the one flow you were focused on.

**Run existing tests** if they exist for the touched area. If no tests exist for that logic, say so explicitly rather than assuming safety.

**Check for new console errors, type errors, or unhandled promise rejections** introduced by the change.

**Verify against real data shape, not just the happy promise rejections** introduced by the change.

**Verify against real data shape, not just the happy path** — especially for anything hitting Prisma/Supabase, since schema mismatches fail silently in JS if not typed strictly.

---

## Phase 4: Communication discipline

**Report what changed and why, in plain terms** — not just "done" or "fixed."

**Explicitly state any assumption made due to ambiguity,** so it can be corrected quickly if wrong.

**Never expand scope silently.** If you notice a second, unrelated bug while fixing the first, report it separately — don't fix it without being asked.

**If a requested change conflicts with existing business logic, stop and raise the conflict clearly** instead of resolving it unilaterally in either direction.

**Don't touch environment variables, config files, CI/build scripts, or auth secrets** unless the task specifically requires it.

**Comment only where logic is non-obvious** — avoid restating what the code already clearly says.