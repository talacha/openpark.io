# Review iteration 19 — issues only

Evidence scope: reviewed `plan.md`, `review-iter-18.md`, the current route wrappers, service transactions, UI callers, guards, and relevant tests, plus the bookkeeping-only diff `6066bd7..ba8306f`. No production, test, schema, locale, or migration file changed this tick, so I used the recorded gate at the same production tree rather than rerunning it: core build passed, seven-project typecheck passed, 212 tests passed with one pre-existing skip, and `check:css` reported logical properties only (`LOOP-SUMMARY.md:1140-1148`). The worktree was clean before this report, and worktree `HEAD`, local `main`, and `origin/main` all resolved to `ba8306f`; iteration 19 and pushed SHA `484bbc5` are recorded at `LOOP-SUMMARY.md:1097-1151`, so the per-tick publication/bookkeeping requirement held for this docs-only tick.

Criterion 5 was specifically rechecked and has no blocker: `tenant.settings.passPolicy.overstayCharge` remains validated and PATCH-editable (`apps/api/src/routes/passes.ts:74-88`) and editable for admins in the Settings UI (`apps/web/src/screens/GuestPasses.tsx:13-59`); provisioning seeds `500000` only when the resolved currency is MXN and `0` otherwise (`apps/api/src/services/tenants.ts:23-25,65-69`); 12-hour guest, host, and supervisor messages interpolate `Intl.NumberFormat` output from the snapshotted/configured policy amount and direct moving the vehicle, while the 10/11-hour reminder path remains separate (`apps/api/src/services/passes.ts:354-390,405-440`; `apps/api/src/notify/messages.ts:7-13,17-23`; `apps/api/test/passes.test.ts:281-366`). Only an announced `status:'pending'` event is recorded; no billing or payment collection was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:561-628,771-835,1097-1151`; commits `fddd34b`, `6b290f6`, `484bbc5`, and `ba8306f`.

Iteration 10 is explicitly recorded as the cap, but production code was subsequently changed and published in iteration 13, and this workflow has now reached a nineteenth implementer tick. The current tick correctly made no production change, but another iteration would continue violating the governing stop condition.

**Consequence:** further implementation in this workflow is unauthorized and would add post-cap work without the promised bounded review cycle.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation still accepts duplicate-prone keyless writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:165-176`; `apps/api/src/routes/people.ts:323-336`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:31-41,145-163`.

`POST /v1/platform/tenants` remains `replaySafe`, not `idempotent`. `definePlatformRoute` requires a header only for `idempotent` routes and directly runs a keyless `replaySafe` handler; existing route tests also prove keyless creation is accepted. When a client retries a lost keyless request without an explicit slug, `provisionTenant` encounters the first tenant and deliberately chooses a random suffix, creating a second live property.

**Consequence:** one intended Super Admin action can create duplicate properties, owners, inventory, policy, and audit history.

**Correction:** make tenant creation require `Idempotency-Key`, update all callers/tests to send a stable submission-scoped key, reject keyless requests, and test that a lost-response retry returns the one original property. Keep the rendered Platform submit disabled while in flight.

## High — criterion 7 / data integrity: platform creation and replay finalization are not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:12-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/001_init.sql:278-287`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The platform reservation insert, `create_tenant` call, tenant initialization transaction, business result, and replay finalization are separate commits. `create_tenant` commits the bare tenant before `withTenant` creates its owner, inventory, rate plan, and policy. There is no lease, phase/tenant identity, reconciliation, or compensation. A failure after tenant creation can leave a partial tenant; a crash after the business commit but before the final update leaves `status=0` indefinitely. The exact key then always returns `request_in_progress`, while a fresh key can create a random-suffixed duplicate.

**Consequence:** property creation can strand an unusable or partially initialized property and recovery can duplicate it.

**Correction:** either execute tenant creation, initialization, and idempotency completion in one database transaction, or persist a unique operation-to-tenant identity and resumable phases with stale-operation recovery. Add fault-injection tests immediately after `create_tenant` and after business commit but before replay finalization, proving retries converge on one complete property.

## Medium — criteria 6 and 7: local-auth onboarding can lose the only usable credential

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/services/people.ts:15-37`; `apps/api/src/services/tenants.ts:43-55`; `apps/api/src/http.ts:117-119,206-208`; `apps/api/src/routes/people.ts:194-208,300-336`; `apps/web/src/screens/People.tsx:249-253`; `apps/web/src/screens/Platform.tsx:24-36`; `apps/web/src/screens/Auth.tsx:45-80,103-115`; `apps/api/test/api.test.ts:383-395`.

Local onboarding stores only a hash of a generated password and returns the plaintext once. Both replay stores deliberately replace `temporaryPassword` with `null`; the regression test confirms the replayed 201 has no password. A lost first response therefore leaves the created member—or a new property's only owner—without the sole credential, while People/Platform report an invitation even though local auth created none. The local-auth application exposes login but no forgot/reset or administrative setup path.

**Consequence:** a successfully created user can be permanently unable to sign in without direct database intervention.

**Correction:** add a recoverable, expiring setup/invitation flow or an authenticated credential-reset flow, preserve explicit replay semantics without storing plaintext secrets, and test lost-response retries for tenant members, cross-property members, and new owners through successful first local sign-in.

## Medium — criterion 1: live resident share-to-gate behavior remains unverified in context

**Criterion/bar:** Generate and share a tamper-protected QR that expires after two unused hours.  
**Location:** `apps/web/test/pass-e2e.test.tsx:105-161`; `apps/web/src/screens/Resident.tsx:147-194`; `apps/web/src/screens/GuestPass.tsx:19-45`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-95,165-247`.

Rendered tests execute Share/public-QR/attendant UI behavior, and API tests separately execute default two-hour expiry, HMAC tamper rejection, supersession, and stored `verify_code` mismatch. The joined rendered test nevertheless begins with a fabricated token, mounts `GuestPass` directly, replaces the scanner, and mocks lookup/redeem. No recorded execution joins server-generated bytes to the actual Share control, routed unauthenticated `/pass` bootstrap, decoded guest QR, and real gate validation/redeem.

**Consequence:** the exact artifact produced by the live resident flow has not been shown to survive sharing and redeem as the same valid pass.

**Correction/verification:** in a separately authorized run, execute a routed mobile-browser story from live pass issue through Share, `/pass#t=…`, QR decode, and real lookup/redeem. Assert exact token identity, default two-hour unused expiry, HMAC-field tamper rejection, and stored `verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture filling check-in and check-out fields; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:17-24,55-110`; `apps/web/src/components/LiveCamera.tsx:16-76`; `apps/web/src/screens/Attendant.tsx:224-226,461-465`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering; the existing browser script covers check-in only and has no recorded run for this workflow.

**Consequence:** actual camera acquisition/model decoding may fail before the covered downstream field wiring, and checkout camera behavior is not verified in the shipped stack.

**Correction/verification:** in a separately authorized run, record 390×844 real-model fake-camera stories for both check-in and checkout, including visible filled fields, checkout match/result, browser/model/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive and authorization bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:81-239`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`; `e2e/crud.mjs:1-end`.

The rendered suite mocks every API. It executes a full lifecycle only for a unit; person is create-only, the site/zone/slot case creates each and deletes only a slot, and cross-property coverage is one mocked member POST. API tests separately cover several lifecycle and denial paths, but no recorded execution joins the real routed UI/API for all required entities or representative all-entity operations in a second property. Setting jsdom `innerWidth` also does not execute responsive CSS layout.

**Consequence:** persisted all-entity administration, complete cross-property Super Admin behavior, server authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a separately authorized run, execute create/read/edit/delete-or-retire for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Repeat representative all-entity operations in a second property as Super Admin and prove regular-admin server denial.

## Low (non-gating) — full accessibility conformance still needs manual verification

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

Static semantics, rendered jsdom assertions, and the logical-CSS check cannot establish complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
