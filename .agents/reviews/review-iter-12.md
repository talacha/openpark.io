# Review iteration 12 — issues only

Evidence scope: independently reviewed the approved plan, iteration-11 report/verdict, the stop-record commits `d2e36c2`/`f8d07d7`, and the unchanged platform-write, local-auth onboarding, pass/share/redemption, policy/notification, camera, and CRUD paths needed to verify the carried findings. No production source changed after reviewed implementation commit `bd189a8`; `9a0d76f..HEAD` contains only the prior review/verdict and loop bookkeeping. I relied on the recorded green stop gate in `LOOP-SUMMARY.md:714-720` (core build, seven-project typecheck, 101 web/106 API tests, CSS logical-properties check) and did not rerun suites. The worktree is clean; worktree HEAD, the user's checkout HEAD/local `main`, and `origin/main` all resolve to `f8d07d7`, so the stop record was fast-forwarded and published. The previous loop-cap correction is resolved: no twelfth implementation tick was attempted. I also checked the specifically approved criterion-5 behavior: `overstayCharge` remains in `PassPolicy`, `PATCH /v1/pass-policy`, and the admin-only Settings UI; tenant provisioning seeds `500000` only when the resolved currency is `MXN` and `0` otherwise; 12-hour guest/host/supervisor templates use the caller's currency-formatted `{amount}` and tell the recipient to move the vehicle; 10/11-hour reminder keys remain separate; no payment collection was added.

## High — criterion 7 / data integrity: Super Admin tenant creation is still non-idempotent

**Location:** `apps/api/src/http.ts:150-169`; `apps/api/src/routes/people.ts:321-335`; `apps/api/src/services/tenants.ts:24-43`; `apps/web/src/screens/Platform.tsx:17-31`.

`definePlatformRoute` authenticates the Super Admin and invokes the handler but never reads or stores `Idempotency-Key`. The Platform create form also has neither a submission key nor an in-flight guard. Two rapid submissions, or a retry after the first `POST /v1/platform/tenants` commits but its response is lost, therefore execute `provisionTenant` twice. Because no explicit slug is supplied, its collision branch deliberately gives the second request a random-suffix slug rather than recognizing it as the same operation.

**Consequence:** one intended action can create two live properties, owner records/memberships, starter inventories, policies, and audit histories.

**Correction:** add actor-scoped platform replay handling that hashes method, URL, and parsed body before any platform mutation and replays the original status/body for an exact key; bind the Platform form to a payload-scoped key and disable duplicate in-flight submission. Add a real-route lost-response/same-key test proving exactly one tenant, owner relationship, inventory, policy, and audit record and replay of the original 201.

## Medium — criterion 6 / data integrity: replay can strand a local-auth person without credentials

**Location:** `apps/api/src/services/people.ts:19-37`; `apps/api/src/http.ts:96-120`; `apps/api/src/routes/people.ts:194-209`; `apps/web/src/screens/People.tsx:230-252`; `apps/web/src/screens/Auth.tsx:43-80,119`.

In local-auth mode, `addPerson` creates an account with a generated temporary password and the successful `/v1/users` response is the only place that password is exposed. Replay storage intentionally serializes `temporaryPassword` as `null`. If the commit succeeds but the response is lost, the exact-key retry returns 201 with no credential; `People` then displays the generic invitation message although no invitation was created. The apparent forgot/reset screens do not disprove the failure: those operations are Supabase-only, and local login does not expose a recovery path.

**Consequence:** the membership exists, but neither the administrator nor the new person has a usable password or local recovery path.

**Correction:** retain the no-secret-in-replay rule, but replace one-time response-only credentials with a recoverable setup/invitation mechanism or add an authenticated credential-reset/setup action and an explicit replay outcome. Add a real lost-response retry test through the UI/API and prove the created person can complete first sign-in.

## Medium — criterion 7 / data integrity: cross-property person creation still ignores the supplied key

**Location:** `apps/api/src/http.ts:150-169`; `apps/api/src/routes/people.ts:299-317`; `apps/web/src/screens/People.tsx:238-252`; `apps/web/test/crud-roles.test.tsx:260-283`.

`People` supplies a stable key to `POST /v1/platform/tenants/:slug/members`, but that endpoint uses `definePlatformRoute`, which ignores the header. An exact retry after a committed/lost response calls `addPerson(..., direct: true)` again; the membership insert then affects no row and returns `already_member`. For a newly created local account, the only temporary password was in the lost first response. The rendered test mocks `post` and proves only that the UI passes a key, not that the real endpoint honors it.

**Consequence:** a required Super Admin cross-property write can report failure after success and leave the new person unable to sign in.

**Correction:** apply tenant-scoped replay semantics to this platform endpoint and return the recoverable onboarding outcome described above. Add a same-key retry test against the real route that asserts one account, membership, and audit event plus a usable setup/sign-in result.

## Medium — criterion 1: the generated pass is not verified through the complete live share-to-gate path

**Location:** `apps/web/test/pass-e2e.test.tsx:29-54,109-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/App.tsx:58-65`; `apps/web/src/app-context.tsx:76-101`.

The recorded rendered test starts with a fabricated `TOKEN`, renders `GuestPass` directly rather than entering `/pass` through the real `AppProvider`/`App` bootstrap, replaces the camera UI, and mocks lookup/redeem. Separate API tests execute the two-hour expiry, HMAC rejection, and stored `verify_code` mismatch, but no recorded execution joins those server-generated bytes to the actual Resident Share control, public route, rendered/decoded QR, and real gate lookup/redeem.

**Consequence:** it remains unverified in context that the exact live artifact generated for a resident survives sharing and unauthenticated bootstrap and is accepted as that same pass at the gate.

**Correction/verification:** issue a live pass via the API, invoke the real Resident Share control, open its fragment URL through `/pass` at a mobile viewport, decode the displayed QR, and perform real lookup/redeem. Assert exact token identity, the two-hour unused expiry, HMAC tamper rejection, and valid-HMAC/stored-`verify_code` mismatch rejection in the joined run.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `apps/web/src/components/LiveCamera.tsx:28-69`; `e2e/live-plate.mjs:1-23`.

The rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. The source does clean up media tracks, but no recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering. The existing real-camera script covers check-in only; there is no equivalent checkout story or run evidence.

**Consequence:** actual camera acquisition and plate decoding are unverified in the shipped stack for both check-in and check-out, despite the screen wiring tests passing.

**Correction/verification:** run and record the 390×844 fake-camera check-in story with the real model and `.y4m` fixture; add and run the checkout equivalent. Assert the visible filled plate, checkout match request/result, browser/model/fixture versions, stopped camera tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property operations remain unverified in context

**Location:** `apps/web/test/crud-roles.test.tsx:81-283`; `e2e/crud.mjs:1-93`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`.

The gate-backed rendered tests mock every API. They complete CRUD only for a unit; person is create-only, site/zone/slot coverage is incomplete, and the Super Admin case is one mocked person POST to a second property. The existing browser script contains real unit/site/slot operations but has no recorded run in this loop, uses a 1280px viewport, omits full person CRUD and Super Admin second-property operations, and does not establish a regular administrator's server-side cross-property denial. Assigning `window.innerWidth = 390` in jsdom does not execute CSS layout.

**Consequence:** complete person/building/unit/slot administration, persisted operations across properties, authorization boundaries, and narrow-screen usability are not verified through the real routed UI and API.

**Correction/verification:** run and record create/read/edit/delete-or-retire for person, site, unit, and slot through the real UI/API at a narrow viewport. As Super Admin, perform representative operations for all entities in a second property and assert persistence; then prove a regular administrator receives server denial for the same cross-property attempts. Record browser version and console/a11y results.

## Low — accessibility verification limitation

**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, and property switching.

Full WCAG conformance remains unverified because no evidence covers complete keyboard-only traversal, VoiceOver/Safari announcements and focus order, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, the logical-CSS check, and jsdom cannot establish these properties.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
