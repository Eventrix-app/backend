# multipart.md — Image & File Upload Strategy

> **Status: Implemented.** Built per §3 exactly as scoped, Option B (generalized signed-URL):
> new `UploadsModule` (`src/uploads/`) with `POST /uploads/signed-url` accepting
> `{ purpose, contentType }`, purpose-gated per §3.2 (`profile-picture` open to any
> authenticated user; `event-image`/`event-cover`/`company-logo` require organizer or
> admin), public buckets with a UUID path-per-upload per §3.3. `POST /events/upload-url`
> now forwards into the same service (`purpose: "event-cover"`) instead of duplicating
> the logic, fixing its previous no-role-gate hole as a side effect. `companyLogoUrl`
> added to `UpdateOrganizerDto` and wired into `OrganizerService.update()`, closing the
> dead-field gap. `src/supabase/client.ts` deleted (confirmed zero references first);
> `Enrollment.qrCodeUrl` left unwired with an explanatory comment per §3.5. Tests added:
> role-gating (allow/deny per purpose) and a `companyLogoUrl` persistence round-trip —
> see `src/uploads/uploads.service.spec.ts` and `src/users/organizer/organizer.service.spec.ts`.
> Verified via `tsc --noEmit`, the full Jest suite, the integration test, `nest build`,
> and a real server boot confirming both routes register correctly.
>
> `contentType` is a fixed allow-list, not a generic `image/*` pattern: only
> `image/png`, `image/jpeg`, `image/jpg`, `image/heic`, `image/webp` (`ALLOWED_UPLOAD_CONTENT_TYPES`
> in `create-signed-url.dto.ts`, enforced via `@IsIn`). The deprecated `/events/upload-url`
> forward re-checks the same list explicitly, since it builds the DTO object manually and
> bypasses `ValidationPipe`.

## 1. The problem

Every image field across the API (`profileImageUrl`, `coverImageUrl`, `imageUrl`, the still-dead `companyLogoUrl`) is currently a **plain string URL** that the client is expected to already have hosted somewhere before calling the API. There is no way for a real client (Postman, the mobile app, a future web organizer console) to hand over actual image bytes and get a usable URL back — except one partial exception:

- `POST /events/upload-url` returns a Supabase **signed PUT URL**; the client then uploads bytes directly to Supabase, and separately passes the resulting URL into `POST/PATCH /events`. This is a two-step flow, it works, but it:
  - only exists for events, not for participant profile pictures or organizer company logos
  - is not role-gated (any authenticated user can request one, not just organizers)
  - isn't documented/discoverable as "the" upload pattern, so it's easy for a future feature (or a future engineer) to bypass it and invent a different, worse mechanism

Meanwhile, three real gaps exist:
1. **No file input path at all** for participant profile pictures beyond pasting a URL, despite `POST /participants` and `PATCH /participants/:id` being the natural place a client would want to attach a photo.
2. **`companyLogoUrl` is a dead field** — it exists on the `Organizer` entity but no DTO or endpoint (including `PATCH /organizers/:id`) ever sets it. Organizers have no way to upload a logo at all today, file or URL.
3. **No single, generalized pattern** — if this gets solved by bolting a one-off solution onto each entity (participants, organizers, events) separately, you end up with three slightly different upload mechanisms to maintain, test, and secure instead of one.

There's also dead code adjacent to this problem: a second, unused Supabase client (`src/supabase/client.ts`) with a mismatched env var name (`SUPABASE_SERVICE_KEY` vs. the controller's `SUPABASE_SERVICE_ROLE_KEY`) that isn't wired to anything — worth removing rather than fixing, since nothing references it.

## 2. The two candidate solutions (and why one is clearly lighter/faster)

### Option A — Multipart proxy through the backend (Multer + `FileInterceptor`)
Client sends `multipart/form-data` directly to `POST/PATCH /participants`, `/events`, `/organizers`; NestJS (`@nestjs/platform-express` + Multer) receives the bytes, buffers/streams them, then forwards to Supabase Storage itself.

- Every image's bytes pass through the NestJS server before reaching storage — an extra hop, extra memory/bandwidth load on your API instance, and your app server now needs to be sized for image traffic, not just JSON API traffic.
- Couples a slow, failure-prone operation (file upload) to the same request that creates/updates a business record. If the upload is slow or fails, the whole create/update call fails with it, when the two concerns (store this file / update this record) are logically independent.
- The only real advantage: bytes are available server-side *before* they land in storage, enabling deep validation (dimension checks, virus scanning, content inspection) in the same request.

### Option B — Generalized signed-URL pattern (extending what already exists for events)
One endpoint, e.g. `POST /uploads/signed-url`, takes a `purpose` (`profile-picture` | `event-image` | `event-cover` | `company-logo`) and returns a signed PUT URL scoped to the correct bucket/path. The client uploads bytes **directly to Supabase Storage**, gets back a stable public URL, then sends that URL as a normal string field in the existing `POST/PATCH` calls — exactly the flow `/events/upload-url` already uses, just generalized and properly gated.

- Bytes never touch the NestJS server — no memory buffering, no bandwidth cost on the app server, upload throughput scales independently of API capacity.
- Business-record writes (create/update participant, event, organizer) stay fast, synchronous, and unaffected by upload speed or failure — a slow image upload never blocks or fails an event-creation call.
- Matches a pattern that's already proven correct in this codebase for events — extending it is lower-risk than introducing a second, different mechanism (Multer) alongside it.
- Client-side validation (file type/size checks in the image picker before upload) covers the vast majority of real-world needs at this stage; deep server-side validation is deferred, not lost — see §5.

**This is the lighter, faster option, and the one to build.** Option A is the heavier alternative and should only be revisited later if a genuine need for pre-storage server-side validation (e.g. mandatory virus scanning) emerges — see §5 for what to do if that day comes.

## 3. The correct implementation

### 3.1 One generalized endpoint, not three one-offs

```
POST /uploads/signed-url
Body: { "purpose": "profile-picture" | "event-image" | "event-cover" | "company-logo", "contentType": "image/jpeg" }
Response: { "uploadUrl": "https://...supabase.../signed-put-url", "publicUrl": "https://.../final-object-url" }
```

- `purpose` maps internally to a fixed bucket + path prefix (see §3.3) — the client never chooses the bucket or path directly, only declares intent.
- Replaces `POST /events/upload-url` entirely; that route can be deprecated once callers migrate.

### 3.2 Role-gating (fixes a real hole found during the inventory)

`/events/upload-url` currently accepts any authenticated user. The generalized endpoint must check `purpose` against the caller's role before issuing a signed URL:

| `purpose` | Allowed roles |
|---|---|
| `profile-picture` | any authenticated user (setting their own) |
| `event-image`, `event-cover` | organizer (and admin, for the admin-as-organizer case already seen in testing) |
| `company-logo` | organizer (and admin) |

A participant account must not be able to request a signed URL scoped to `event-image` or `company-logo`, even though the underlying storage call would otherwise succeed.

### 3.3 Bucket structure and path naming

- **Public buckets** for all four purposes above — these are all low-sensitivity, routinely-displayed assets (profile pictures, event images, organizer logos), so public buckets get the best CDN cache hit rate with no signed-URL complexity on the *read* side.
- **Path-per-upload, not overwrite-in-place.** Include a UUID or timestamp in the object path on every upload (e.g. `event-covers/{eventId}/{uuid}.jpg`), rather than always writing to the same path (e.g. `event-covers/{eventId}/cover.jpg`). This sidesteps the CDN/browser cache-staleness window entirely on update, instead of relying on the ~60-second Smart CDN invalidation delay and hoping the client's browser also refreshes.
- Old objects left behind after a user replaces their profile picture/logo/cover image become orphaned — acceptable to leave as-is for now (cheap storage), revisit with a scheduled cleanup job later if storage cost becomes material.

### 3.4 Wiring up the two real gaps found in the inventory

- **Participant profile pictures**: no new field needed — `profileImageUrl` on `POST /participants` / `PATCH /participants/:id` already exists and works as a URL target. The only change is that clients now obtain that URL via `purpose: "profile-picture"` instead of hosting it themselves.
- **`companyLogoUrl`**: add it to the `PATCH /organizers/:id` DTO (it's currently missing entirely, not just unfilled) so the URL returned from `purpose: "company-logo"` has somewhere to be saved. This closes the dead-field gap directly.

### 3.5 Cleanup while touching this code

- Delete `src/supabase/client.ts` (the unused second client with the mismatched env var) rather than fixing the typo — nothing references it, and a working-but-unused duplicate client is a worse outcome than no duplicate at all.
- Leave `qrCodeUrl` on `Enrollment` unwired **intentionally** — this should be generated server-side from the existing signed ticket code at enrollment or fetch time, not accepted as client-uploaded input. Document this explicitly in code/comments so it isn't mistaken for an oversight later.

### 3.6 Client-side responsibilities (mobile/Postman/future web)

1. Call `POST /uploads/signed-url` with the appropriate `purpose`.
2. `PUT` the file bytes directly to the returned `uploadUrl`.
3. Take the returned `publicUrl` and include it in the normal `POST/PATCH` call for the participant/event/organizer record.
4. Perform basic client-side validation (file type, max size, e.g. reject anything over ~5MB) before step 2 — this is the validation layer for now; see §5 for when server-side validation becomes necessary.

## 4. Tests to add

- Role-gating: participant token requesting `purpose: company-logo` or `event-image` → expect 403.
- Organizer/admin token requesting any purpose → expect 200 with a scoped signed URL.
- `companyLogoUrl` round-trip: obtain signed URL for `company-logo`, simulate upload, `PATCH /organizers/:id` with the returned URL, `GET` the organizer back, assert the field persists (this is the field that was previously silently dropped).
- Confirm `POST /events/upload-url` (old route) either 410s or forwards to the new endpoint, per whatever deprecation approach is chosen — don't leave two live, undocumented upload mechanisms active simultaneously.

## 5. When to revisit Option A (Multer/backend-proxy)

Only reconsider routing bytes through the backend if a concrete requirement emerges that client-side validation can't satisfy — e.g. mandatory virus/malware scanning before storage, or strict server-verified image dimension/content checks for compliance reasons. If that need arises, the correct migration is additive: keep the signed-URL endpoint for the common case, and add a separate, explicitly-named proxy-upload endpoint (e.g. `POST /uploads/scanned`) for the specific purpose that needs it — not a wholesale replacement of the pattern in §2 for every image field.
