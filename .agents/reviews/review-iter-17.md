# Review iteration 17 — issues only

Evidence scope: reviewed `plan.md`, `review-iter-16.md`, the current callers/guards and tests, and the bookkeeping-only tick (`6d37fd5..e18e074`). I used the recorded green gate for the unchanged production tree (core build, seven-project typecheck, 212 passing tests plus one pre-existing skip, and logical-CSS check) and did not rerun suites. Before writing this review, the worktree was clean and worktree HEAD, local `main`, and `origin/main` all resolved to `e18e074`; iteration 17 is appended to `LOOP-SUMMARY.md`, and its docs tick was fast-forwarded and normally pushed. Criterion 5 remains correctly scoped: `tenant.settings.passPolicy.overstayCharge` is PATCH/UI editable; only resolved-MXN tenants seed `500000`, while others seed `0`; 12-hour guest, host, and supervisor notices interpolate the currency-formatted policy amount and direct moving the vehicle; 10/11-hour reminders remain separate; no payment enforcement was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:562-627,630-690,771-835,989-1043`; commits `6b290f6`, `bc01a3d`, `4bd3556`, `916e5e8`, `fc1a6b7`, `6d37fd5`, and `e18e074`.

The summary marks iteration 10 as the cap, but production code was changed and published in iteration 13 and the workflow has now run a seventeenth implementer tick. This tick is bookkeeping-only and follows the requested stop correction, but cannot undo the cap violation.

**Consequence:** another implementation tick in this workflow would violate the governing stop condition.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation permits keyless duplicate-prone writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:166-178`; `apps/api/src/routes/people.ts:323-335`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:31-40,93-112`.

`POST /v1/platform/tenants` is `replaySafe`, not `idempotent`. `definePlatformRoute` therefore bypasses the replay store when the header is absent, and current successful route tests explicitly exercise keyless creation. A keyless retry after a lost response runs `provisionTenant` again; when no slug was supplied, its collision branch creates a random-suffixed second property.

**Consequence:** one intended Super Admin action can create duplicate properties, owners, inventory, policy, and audit history.

**Correction:** make tenant creation strictly `idempotent`, update every caller/test to provide one stable key, reject keyless requests, and prove exact-key replay returns the single property. Cover the Platform form’s lost-response retry and disabled in-flight submission.

## High — criterion 7 / data integrity: platform creation and idempotency are not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:12-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The platform reservation insert, `provisionTenant` mutation, and replay-response finalization are separate autocommits; `provisionTenant` also commits `create_tenant` before its tenant initialization transaction. There is no lease, reconciliation, compensation, or durable operation identity on the created property. A failure after property creation/business commit but before finalization can leave an incomplete property and/or `status=0` permanently. Exact-key retry then returns `request_in_progress`, while a fresh key can create a random-suffixed duplicate.

**Consequence:** a created property can be stranded or partially initialized and recovery can duplicate it.

**Correction:** atomically bind creation/initialization and idempotency completion, or persist a unique operation identity that lets a stale reservation reconstruct or safely complete the one property. Add fault-injection tests at post-`create_tenant` and post-business-commit/pre-finalization boundaries.

## Medium — criteria 6 and 7: local-auth onboarding loses the only credential on replay

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/http.ts:117-119,192-208`; `apps/api/src/services/people.ts:15-37`; `apps/api/src/routes/people.ts:194-208,300-335`; `apps/web/src/screens/People.tsx:249-254`; `apps/web/src/screens/Platform.tsx:24-36`; `apps/web/src/screens/Auth.tsx:45-80,113`.

Local person/owner creation stores only the generated password hash; the first response is the sole credential-delivery channel. Both replay stores replace `temporaryPassword` with `null`. If the committed first response is lost, replay returns 201 without a usable credential, while People/Platform report an invitation even though local auth created none; forgot/reset is exposed only for external auth.

**Consequence:** a created member—or a new property’s only owner—can be unable to sign in.

**Correction:** keep secrets out of replay storage, but add a recoverable setup/invitation or authenticated credential-reset flow with an explicit replay outcome. Test lost-response retries for tenant owner, tenant member, and platform member through successful first local sign-in.

## Medium — criterion 1: live resident share-to-gate behavior is not verified in context

**Criterion/bar:** Generate and share a tamper-protected, two-hour QR pass.  
**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/screens/GuestPass.tsx`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

The rendered join starts with a fabricated token, mounts `GuestPass` directly, replaces the scanner, and mocks lookup/redeem. Recorded API tests separately cover two-hour expiry, HMAC rejection, and valid-HMAC/stored-`verify_code` mismatch, but no recorded execution joins a server-generated pass to the actual Resident Share control, real unauthenticated `/pass` bootstrap, decoded guest QR, and real gate lookup/redeem.

**Consequence:** the exact artifact produced by the deployed flow has not been shown to survive sharing and redeem as the same live pass.

**Correction/verification:** in a future authorized run, execute a routed mobile-browser story from live issue through Share, `/pass#t=…`, QR decode, and real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and stored-`verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture at check-in and check-out; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `apps/web/src/components/LiveCamera.tsx:12-76`; `apps/web/src/screens/Attendant.tsx:170-225,461-466`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering; the existing real-camera script covers check-in only.

**Consequence:** actual camera acquisition and model decoding remain unverified in the shipped stack for both required flows, although downstream field wiring is covered.

**Correction/verification:** in a future authorized run, run and record a 390×844 real-model fake-camera check-in story and add/run a checkout equivalent. Assert visible filled plates, checkout match/result, model/browser/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive/security bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:18-59,81-283`; `e2e/crud.mjs`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`.

Rendered tests mock every API and complete a full lifecycle only for a unit; person is create-only, site/zone/slot lifecycle coverage is incomplete, and cross-property coverage is one mocked member POST. Setting `innerWidth` in jsdom does not execute CSS layout, and no real-stack browser run is recorded.

**Consequence:** persisted all-entity administration, complete cross-property Super Admin behavior, server authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a future authorized run, execute complete create/read/edit/delete-or-retire lifecycles for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Perform representative all-entity operations in a second property as Super Admin and prove regular-admin server denial.

## Low — accessibility verification limitation

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

No evidence establishes complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom assertions, and the logical-CSS check cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
