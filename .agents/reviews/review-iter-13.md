# Review iteration 13 — issues only

Evidence scope: independently reviewed `plan.md`, `review-iter-12.md`, the prior verdict, the iteration-13 diff (`6b290f6` plus bookkeeping `bc01a3d`), affected callers/guards, and the recorded verification/publish evidence. I relied on the recorded green gate in `LOOP-SUMMARY.md:829-834` (core build, seven-project typecheck, 101 web/108 API tests, CSS logical-properties check) and did not rerun suites. The worktree is clean; worktree HEAD, the user's local `main`, and `origin/main` all resolve to `bc01a3d`, so this tick's fast-forward/push and summary entry are evidenced. The user's checkout has an unrelated unstaged `.kiro/steering/autonomy.md`, but that does not alter the published SHA. I also rechecked criterion 5: `overstayCharge` remains in the policy schema, `PATCH /v1/pass-policy` remains guarded by `settings.edit`, the Settings UI uses the matching admin/super-admin guard, tenant provisioning seeds `500000` only when resolved currency is `MXN` and `0` otherwise, 12-hour guest/host/supervisor messages interpolate the caller-formatted `{amount}` and instruct moving the vehicle, 10/11-hour reminder keys remain separate, and no payment enforcement was added.

## Blocking — loop contract: implementation and publication continued after the hard iteration cap

**Location:** `.agents/reviews/LOOP-SUMMARY.md:626-628,693-761,771-835`; commits `6b290f6` and `bc01a3d`.

The summary identifies iteration 10 as the cap, later records `LOOP STOP — 10-iteration cap exceeded; no further implementation tick queued`, and explicitly says not to start a twelfth implementation tick. Nevertheless, iteration 13 then changed production code and was pushed. Twelve review reports already existed before this review, so this is not merely a numbering typo. The extended clock did not extend the unchanged 10-iteration maximum.

**Consequence:** the autonomous workflow violated its governing stop condition and published a post-cap tick; another fix iteration would compound the violation.

**Correction:** stop the loop after this review. Preserve the already-published linear history—do not reset, revert solely for bookkeeping, force-push, or queue another implementation tick—and record this second cap deviation for the team.

## High — criterion 7 / idempotency: tenant creation still accepts an unprotected write

**Location:** `apps/api/src/http.ts:166-168`; `apps/api/src/routes/people.ts:323-325`; `apps/api/src/services/tenants.ts:30-41`; `apps/api/test/closed-preview.test.ts:35-40,93-96,109-112`.

`POST /v1/platform/tenants` is marked `replaySafe`, not `idempotent`, and `definePlatformRoute` activates replay only when the client supplied a string key. The existing route tests prove keyless creates remain accepted. The new Platform screen sends a key, but the public API and existing callers can still omit it; retrying such a request after a lost response runs `provisionTenant` again, whose no-explicit-slug collision path intentionally chooses a random suffix.

**Consequence:** the original high-impact failure remains reachable: one intended Super Admin API operation can create two live properties with owner memberships, starter inventory, policies, and audit history.

**Correction:** make tenant creation strictly `idempotent: true`, update every caller/test to supply a submission-scoped key, and assert a missing key is rejected while an exact-key retry replays one tenant. Add a rendered Platform-form test proving the key is stable across a lost-response retry and the in-flight submit is disabled.

## High — criterion 7 / data integrity: platform reservation and mutation are not atomic or recoverable

**Location:** `apps/api/src/http.ts:184-208`; `apps/api/src/db.ts:14-34`; `apps/api/src/services/tenants.ts:30-69`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The reservation insert autocommits, `run()` then commits the tenant/member mutation separately, and the final status/response update is a third autocommit statement. There is no lease, stale-row cleanup, result reconciliation, or recovery path. A process termination or database failure after the mutation commits but before the final update leaves `status=0` permanently. The same key then always returns `request_in_progress`; a page reload/new key can execute tenant creation again and hit the random-suffix duplicate path. The summary's claim that this is self-healing is disproved by `useSubmitKey`: an unchanged mounted submission keeps the same key, while obtaining a new key can duplicate the committed write.

**Consequence:** the exact failure window idempotency is meant to handle can either strand a successful operation behind permanent 409 responses or create a duplicate property when retried with a fresh key.

**Correction:** make durable completion/result identity atomic with each mutation—for example, carry the reserved operation into the same transaction that commits the member write and refactor tenant provisioning so tenant creation/result association commits atomically—or add a durable unique operation ID on the created resource that lets a stale reservation reconstruct and replay the committed result. Add fault-injection tests that fail after the business mutation but before response finalization, then prove an exact retry returns the one committed resource without a duplicate.

## Medium — criteria 6 and 7 / local-auth onboarding: replay still loses the only usable credential

**Location:** `apps/api/src/http.ts:117-119,206-208`; `apps/api/src/services/people.ts:21-37`; `apps/api/src/routes/people.ts:194-209,300-318,323-339`; `apps/web/src/screens/People.tsx:249-254`; `apps/web/src/screens/Platform.tsx:32-35`; `apps/web/src/screens/Auth.tsx:45-80,113`.

Local-auth person and owner creation generates a one-time password and stores only its hash; the successful first response is the sole delivery channel. Both tenant and platform replay stores intentionally replace `temporaryPassword` with `null`. If the commit succeeds but that response is lost, the exact-key replay returns 201 without a credential, and the People/Platform UIs incorrectly report an invitation even though local auth created no invitation. The forgot/reset path is Supabase-only and its link is shown only for external auth, so no local recovery guard disproves the failure. The new member replay test checks one membership and a replayed 201 but does not assert credential recovery or a successful first login.

**Consequence:** a required Admin/Super Admin create can leave a person—or a newly created property's only owner—present in the database but unable to sign in.

**Correction:** keep secrets out of replay storage, but replace response-only passwords with a recoverable setup/invitation flow or add an authenticated credential setup/reset action and an explicit replay outcome. Add lost-response tests for `/v1/users`, platform member creation, and platform tenant-owner creation that end in a successful first local sign-in.

## Medium — criterion 1: live resident-share-to-gate behavior remains unverified in context

**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx`; `apps/web/src/screens/GuestPass.tsx`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

The rendered join still starts from a fabricated token, mounts `GuestPass` directly rather than entering `/pass` through the real `AppProvider`/`App` bootstrap, swaps the camera UI, and mocks lookup/redeem. Separate API tests exercise two-hour expiry, HMAC rejection, and stored `verify_code` mismatch, but no recorded execution joins server-generated bytes to the actual Resident Share control, public fragment route, decoded guest QR, and real gate lookup/redeem.

**Consequence:** it remains unverified that the exact live artifact a resident generates and shares survives unauthenticated bootstrap and is accepted as that same pass at the gate.

**Correction/verification:** in a real routed mobile browser run, issue a live pass, invoke the Resident Share control, open its fragment URL through `/pass`, decode the displayed QR, and perform real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and valid-HMAC/stored-`verify_code` mismatch rejection in the joined run.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Location:** `apps/web/test/attendant-camera.test.tsx:17-24`; `apps/web/src/components/LiveCamera.tsx:15-69`; `e2e/live-plate.mjs:1-23`.

The gate-backed rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering. The existing real-camera script covers check-in only; there is still no checkout equivalent or run evidence.

**Consequence:** actual camera acquisition and plate decoding are unverified in the shipped stack for both check-in and check-out even though downstream field wiring is tested.

**Correction/verification:** run and record the 390×844 fake-camera check-in story with the real model and `.y4m` fixture; add and run the checkout equivalent. Assert the visible filled plate, checkout match request/result, browser/model/fixture versions, stopped media tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property operations remain unverified through the real stack

**Location:** `apps/web/test/crud-roles.test.tsx:81-283`; `e2e/crud.mjs:1-93`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-74`.

Rendered tests still mock every API and do not complete create/read/edit/delete-or-retire for person, site/building, unit, and slot against persistence. Super Admin coverage remains a mocked member POST to a second property; the existing browser CRUD script has no recorded run, is desktop-sized, omits full person/site/slot lifecycle and representative all-entity second-property writes, and does not prove a regular administrator's real server denial. The iteration-13 Platform create/key/busy wiring also received no rendered test.

**Consequence:** complete single-property administration, cross-property Super Admin operations, server authorization boundaries, persistence, and narrow-screen usability are not verified in context.

**Correction/verification:** run and record full entity lifecycles through the real routed UI/API at a narrow viewport, including the Platform tenant-create retry behavior. Perform representative operations for every entity in a second property as Super Admin, assert persistence, and prove regular-admin server denial for the same cross-property attempts; record browser version and console/accessibility results.

## Low — accessibility verification limitation

**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, CRUD screens, Platform creation, and property switching.

Full WCAG conformance remains unverified because no evidence covers complete keyboard-only traversal, VoiceOver/Safari announcements and focus order, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom tests, and the logical-CSS check cannot establish these properties.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
