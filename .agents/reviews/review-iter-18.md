# Review iteration 18 — issues only

Evidence scope: reviewed `plan.md`, `review-iter-17.md`, the current callers/guards and tests, and the bookkeeping-only tick `e18e074..6066bd7`. The production tree is unchanged, so I used the recorded green gate (core build, seven-project typecheck, 212 passing tests plus one pre-existing skip, and logical-CSS check) rather than rerunning suites. Before this report, the worktree was clean and worktree HEAD, local `main`, and `origin/main` all resolved to `6066bd7`; iteration 18 is appended to `LOOP-SUMMARY.md`, and its docs commits were fast-forwarded and normally pushed. Criterion 5 remains correctly scoped and test-backed: the per-tenant `overstayCharge` is PATCH/UI editable; resolved-MXN tenants seed `500000` and non-MXN tenants seed `0`; 12-hour guest, host, and supervisor notices interpolate the currency-formatted policy amount and direct moving the vehicle; 10/11-hour reminders remain separate; no payment enforcement was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:561-628,631-692,771-839,1045-end`; commits `6b290f6`, `bc01a3d`, `3bbb3ab`, and `6066bd7`.

Iteration 10 is explicitly recorded as the cap, but production code was changed and published in iteration 13 and the workflow has now run an eighteenth implementer tick. The current bookkeeping-only tick correctly makes no production change but cannot undo the cap violation.

**Consequence:** another implementation tick in this workflow would violate the governing stop condition.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation permits keyless duplicate-prone writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:166-176`; `apps/api/src/routes/people.ts:323-336`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:20-40`.

`POST /v1/platform/tenants` remains `replaySafe` rather than `idempotent`. `definePlatformRoute` therefore executes its handler when `Idempotency-Key` is absent, and the recorded route test succeeds without that header. Retrying a lost keyless request re-enters `provisionTenant`; with no requested slug its collision branch chooses a random suffix and creates another tenant.

**Consequence:** one intended Super Admin action can create duplicate properties, owners, inventory, policy, and audit history.

**Correction:** require `Idempotency-Key` on tenant creation, update every caller/test to send one stable key, reject keyless requests, and prove exact-key replay returns the single property. Cover a lost-response retry and disabled in-flight submission through the rendered Platform form.

## High — criterion 7 / data integrity: platform creation and idempotency are not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:12-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The platform reservation insert, `create_tenant` call, tenant initialization transaction, business result, and replay finalization remain separate commits. There is no lease, reconciliation, compensation, or durable operation-to-tenant identity. A failure after tenant creation or business commit can leave an incomplete tenant and/or `status=0` permanently; exact-key retry is then blocked while a fresh key can create a random-suffixed duplicate.

**Consequence:** a property can be stranded or partially initialized, and recovery can duplicate it.

**Correction:** atomically bind creation/initialization and idempotency completion, or persist a unique operation identity that can reconstruct or safely complete the one property. Add fault-injection tests after `create_tenant` and after business commit but before replay finalization.

## Medium — criteria 6 and 7: local-auth onboarding loses the only credential on replay

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/http.ts:117-119,206-208`; `apps/api/src/services/people.ts:15-37`; `apps/api/src/routes/people.ts:194-208,300-336`; `apps/web/src/screens/People.tsx:249-253`; `apps/web/src/screens/Platform.tsx:24-36`; `apps/web/src/screens/Auth.tsx:45-80,103-115`.

Local onboarding persists only the generated password hash, while both replay stores replace `temporaryPassword` with `null`. A lost first response therefore replays 201 without the sole credential. People/Platform then report an invitation even though local auth created no invitation, and the forgot/reset UI is exposed only for external auth.

**Consequence:** a created member—or a new property's only owner—can be unable to sign in.

**Correction:** add a recoverable setup/invitation or authenticated credential-reset flow with an explicit replay outcome while keeping secrets out of replay storage. Test lost-response retries for owner, tenant member, and platform member through successful first local sign-in.

## Medium — criterion 1: live resident share-to-gate behavior is not verified in context

**Criterion/bar:** Generate and share a tamper-protected, two-hour QR pass.  
**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/screens/GuestPass.tsx:16-45`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

Rendered tests execute Share branches and decode a guest QR, while API tests separately cover two-hour expiry, HMAC rejection, and stored `verify_code` mismatch. However, the joined test starts from a fabricated token, mounts `GuestPass` directly, replaces the scanner, and mocks lookup/redeem. No recorded execution joins server-generated bytes to the actual Share control, routed unauthenticated `/pass` bootstrap, decoded guest QR, and real gate validation.

**Consequence:** the exact artifact produced by the live resident flow has not been shown to survive sharing and redeem as the same valid pass.

**Correction/verification:** in a future authorized run, execute a routed mobile-browser story from live issue through Share, `/pass#t=…`, QR decode, and real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and stored `verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture at check-in and check-out; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `apps/web/src/components/LiveCamera.tsx:12-76`; `apps/web/src/screens/Attendant.tsx:170-225,461-466`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering; the existing real-camera script covers check-in only.

**Consequence:** actual camera acquisition and model decoding remain unverified in the shipped stack for both required flows, although downstream field wiring is covered.

**Correction/verification:** in a future authorized run, record 390×844 real-model fake-camera check-in and checkout stories, including visible filled fields, checkout match/result, model/browser/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive/security bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:11-60,81-283`; `e2e/crud.mjs:1-end`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`.

Rendered tests mock every API and complete a full lifecycle only for a unit; person is create-only, site/zone/slot lifecycle coverage is incomplete, cross-property coverage is one mocked member POST, and jsdom `innerWidth` does not exercise CSS layout. The available real-stack CRUD script is desktop-only and has no recorded run for this loop, person lifecycle, or Super Admin second-property operations.

**Consequence:** persisted all-entity administration, complete cross-property Super Admin behavior, server authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a future authorized run, execute complete create/read/edit/delete-or-retire lifecycles for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Perform representative all-entity operations in a second property as Super Admin and prove regular-admin server denial.

## Low — accessibility verification limitation

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

No evidence establishes complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom assertions, and the logical-CSS check cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
