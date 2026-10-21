# Review iteration 16 — issues only

Evidence scope: reviewed `plan.md`, `review-iter-15.md`, the current source/callers/guards, recorded tests, and the bookkeeping-only tick (`fc1a6b7..eb423bd`). I relied on the recorded green gate at the current production-code tree (core build, seven-project typecheck, all listed package tests passing with one pre-existing skip, and CSS logical-properties check) and did not rerun suites. The worktree was clean before these review artifacts, and worktree HEAD, local `main`, and `origin/main` all resolved to `eb423bd`; iteration 16 is appended to `LOOP-SUMMARY.md` and its docs tick was fast-forwarded/pushed. Criterion 5 remains correctly scoped in the inspected paths: `tenant.settings.passPolicy.overstayCharge` is PATCH/UI editable; provisioning seeds `500000` only when resolved currency is MXN and `0` otherwise; the 12-hour guest, host, and supervisor messages interpolate the currency-formatted policy value and direct moving the vehicle; 10/11-hour reminders remain separate; no payment enforcement was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:561-693,771-835,938-986`; commits `6b290f6`, `bc01a3d`, `4bd3556`, `916e5e8`, `fc1a6b7`, and `eb423bd`.

The summary identifies iteration 10 as the cap, yet production code was changed and published in iteration 13 and the workflow has now reached a sixteenth implementer tick. The current tick is bookkeeping-only and follows the prior stop correction, but cannot undo the cap violation.

**Consequence:** another implementation tick in this workflow would violate the governing stop condition.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation still accepts keyless duplicate-prone writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:166-178`; `apps/api/src/routes/people.ts:323-335`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:35-40,93-112`.

`POST /v1/platform/tenants` is `replaySafe`, not `idempotent`. `definePlatformRoute` therefore runs it when `Idempotency-Key` is absent, and existing successful route tests use no key. If a keyless response is lost, retry runs `provisionTenant` again; without an explicit slug, its collision branch creates a random-suffixed second property.

**Consequence:** one intended Super Admin operation can create duplicate properties, owners, inventories, policies, and audit histories.

**Correction:** make tenant creation strictly `idempotent`, update every caller/test to provide a stable key, reject keyless calls, and prove exact-key retry returns one property. Add rendered Platform-form coverage for a lost-response retry and disabled in-flight submission.

## High — criterion 7 / data integrity: platform idempotency is not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:27-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The reservation insert, tenant/member business mutation, and response finalization are separate autocommits. There is no lease, reconciliation path, or durable operation identity on the created resource. A failure after the business mutation commits but before finalization leaves `status=0` permanently; exact retry returns `request_in_progress`, while a fresh key can rerun no-slug provisioning.

**Consequence:** a successfully created property can be stranded behind permanent 409 responses or duplicated during recovery.

**Correction:** atomically bind idempotency completion/result identity to the business mutation, or persist a unique operation ID that lets a stale reservation reconstruct the committed result. Add fault-injection coverage for failure after business commit but before finalization, proving retry returns one committed property.

## Medium — criteria 6 and 7: local-auth onboarding loses the only credential on replay

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/http.ts:117-119,192-208`; `apps/api/src/services/people.ts:21-37`; `apps/api/src/routes/people.ts:194-208,300-335`; `apps/web/src/screens/People.tsx:249-254`; `apps/web/src/screens/Platform.tsx:32-35`; `apps/web/src/screens/Auth.tsx:45-80,113`.

Local person/owner creation stores only the generated password hash, while replay storage replaces `temporaryPassword` with `null`. If the first committed response is lost, replay returns 201 without the only credential. People/Platform then report an invitation even though local auth created no invitation, and the forgot/reset path is exposed only for external auth.

**Consequence:** a created member—or a new property's only owner—can exist but be unable to sign in.

**Correction:** provide a recoverable setup/invitation or authenticated credential-reset flow with an explicit replay outcome while keeping secrets out of replay storage. Test lost-response retries for tenant owner, tenant member, and platform member through successful first local sign-in.

## Medium — criterion 1: the live resident share-to-gate chain remains unverified in context

**Criterion/bar:** Generate and share a tamper-protected, two-hour QR pass.  
**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/screens/GuestPass.tsx`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

The rendered join starts with a fabricated token, mounts `GuestPass` directly, replaces the scanner, and mocks lookup/redeem. Separate recorded API tests cover two-hour expiry, HMAC rejection, and valid-HMAC/stored-`verify_code` mismatch rejection, but no recorded execution joins server-generated bytes to the actual Resident Share control, real unauthenticated `/pass` bootstrap, decoded guest QR, and real gate lookup/redeem.

**Consequence:** the exact pass artifact produced by the live flow has not been shown to survive sharing and redeem as that same pass.

**Correction/verification:** in a future authorized run, execute a routed mobile-browser story that issues a live pass, invokes Resident Share, opens `/pass#t=…`, decodes the rendered QR, and performs real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and stored-`verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture at check-in and check-out; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `apps/web/src/components/LiveCamera.tsx:12-76`; `apps/web/src/screens/Attendant.tsx:170-225,461-466`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering; the existing real-camera script covers check-in only.

**Consequence:** actual camera acquisition and model decoding remain unverified in the shipped stack for both required flows, although downstream field wiring is covered.

**Correction/verification:** in a future authorized run, run and record a 390×844 real-model fake-camera check-in story and add/run a checkout equivalent. Assert visible filled plates, checkout match/result, model/browser/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive/security bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:18-59,81-283`; `e2e/crud.mjs`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`.

Rendered tests mock every API and complete a full lifecycle only for a unit; person is create-only, site/zone/slot lifecycle coverage is incomplete, and cross-property coverage is one mocked member POST. Setting `innerWidth` in jsdom does not execute mobile CSS layout, and no real-stack browser run is recorded.

**Consequence:** persisted administration, complete cross-property Super Admin behavior, server authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a future authorized run, execute full create/read/edit/delete-or-retire lifecycles for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Perform representative all-entity operations in a second property as Super Admin, prove regular-admin server denial, and record browser, console, and accessibility results.

## Low — accessibility verification limitation

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

No evidence establishes complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom assertions, and the logical-CSS check cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
