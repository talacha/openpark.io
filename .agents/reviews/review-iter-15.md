# Review iteration 15 — issues only

Evidence scope: reviewed `plan.md`, `ARCHITECTURE.md`, `docs/DOMAIN.md`, `review-iter-14.md`, the current source/callers/guards, and the close-tick diff (`916e5e8..8eb69bd`, summary bookkeeping only). I relied on the recorded green gate in `LOOP-SUMMARY.md` (core build, seven-project typecheck, all listed package tests passing with one pre-existing skip, and the CSS logical-properties check) and did not rerun suites. The worktree is clean and worktree HEAD, local `main`, and `origin/main` all resolve to `8eb69bd`, so the close tick was fast-forwarded/pushed and its summary entry exists. No production code changed after review 14, so its unresolved product paths remain current. Criterion 5 remains correctly scoped in the inspected source: the per-tenant policy is PATCH-editable and admin/Super Admin-editable in the UI; provisioning seeds `500000` only for resolved `MXN` currency and `0` otherwise; the 12-hour guest, host, and supervisor bodies interpolate the currency-formatted policy amount and instruct moving the vehicle; the 10/11-hour reminder path is separate; no payment enforcement was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:561-693,771-835,887-935`; commits `6b290f6`, `bc01a3d`, `4bd3556`, `916e5e8`, and `8eb69bd`.

The summary identifies iteration 10 as the cap and later records a stop, but production code was still changed and published in iteration 13 (`6b290f6`) after twelve review reports existed. The subsequent close ticks made no production change, but cannot undo that cap violation; the extended clock did not change the ten-iteration maximum.

**Consequence:** another implementation tick in this workflow would violate the governing instruction and add post-cap work.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, bookkeeping revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation still accepts keyless duplicate-prone writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:166-169,173-178`; `apps/api/src/routes/people.ts:323-335`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:35-40,93-112`.

`POST /v1/platform/tenants` is `replaySafe`, not `idempotent`. `definePlatformRoute` therefore runs it when `Idempotency-Key` is absent, and existing route tests use keyless success. If such a response is lost, a keyless retry calls `provisionTenant` again; without an explicit slug, its collision branch creates a random-suffixed second property.

**Consequence:** one intended Super Admin operation can create two properties, owner memberships, inventories, policies, and audit histories.

**Correction:** make tenant creation strictly `idempotent`, update every caller/test to provide a stable key, reject keyless calls, and prove exact-key retry returns the one property. Add rendered Platform-form coverage for a lost-response retry and disabled in-flight submission.

## High — criterion 7 / data integrity: platform idempotency is not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:27-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The reservation insert, tenant/member mutation, and response finalization are separate autocommits. There is no lease, reconciliation path, or durable operation identity on the created resource. A failure after the business mutation commits but before the final update leaves `status=0` permanently. The same key then always returns `request_in_progress`; a fresh key can rerun no-slug provisioning and create a random-suffixed duplicate.

**Consequence:** a successfully created property can be stranded behind permanent 409 responses or duplicated during recovery.

**Correction:** atomically bind idempotency completion/result identity to the business mutation, or persist a unique operation ID on the resource so a stale reservation can reconstruct the committed result. Add fault-injection coverage for failure after business commit but before finalization, proving retry returns one committed property.

## Medium — criteria 6 and 7 / local-auth onboarding loses the only credential on replay

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/http.ts:117-119,192-208`; `apps/api/src/services/people.ts:21-37`; `apps/api/src/routes/people.ts:194-208,300-318,323-335`; `apps/web/src/screens/People.tsx:249-254`; `apps/web/src/screens/Platform.tsx:32-35`; `apps/web/src/screens/Auth.tsx:45-80,113`.

Local person/owner creation stores only the generated password hash, making the first response the sole credential-delivery channel. Both replay stores replace `temporaryPassword` with `null`. After a committed request whose response is lost, replay returns 201 without a credential, while People/Platform report an invitation even though local auth created no invitation. The forgot/reset path and login recovery affordance are Supabase-only.

**Consequence:** a created person—or a new property's only owner—can exist but be unable to sign in.

**Correction:** retain the no-secret-in-replay rule, but provide a recoverable setup/invitation or authenticated credential-reset mechanism with an explicit replay outcome. Test lost-response retries for tenant owner, tenant member, and platform member creation through successful first local sign-in.

## Medium — criterion 1: the live resident share-to-gate chain remains unverified in context

**Criterion/bar:** Generate and share a tamper-protected, two-hour QR pass.  
**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/screens/GuestPass.tsx`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

The rendered join starts with a fabricated token, mounts `GuestPass` directly, replaces the scanner UI, and mocks lookup/redeem. Separate recorded API tests cover two-hour expiry, HMAC rejection, and valid-HMAC/stored-`verify_code` mismatch rejection, but no recorded execution joins server-generated bytes to the actual Resident Share control, real unauthenticated `/pass` bootstrap, decoded guest QR, and real gate lookup/redeem.

**Consequence:** the exact pass artifact produced by the deployed flow has not been shown to survive sharing and redeem as that same live pass.

**Correction/verification:** in a future authorized run, execute a routed mobile-browser story that issues a live pass, invokes the Resident Share control, opens `/pass#t=…`, decodes the rendered QR, and performs real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and stored-`verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture at check-in and check-out; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,55-110`; `apps/web/src/components/LiveCamera.tsx:12-76`; `apps/web/src/screens/Attendant.tsx:170-225,461-466`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. There is no recorded run through `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering. The existing real-camera script covers check-in only; there is no checkout camera story or execution evidence.

**Consequence:** actual camera acquisition and model decoding remain unverified in the shipped stack for both required flows, although downstream field wiring is covered.

**Correction/verification:** in a future authorized run, run and record the 390×844 real-model fake-camera check-in story and add/run a checkout equivalent. Assert visible filled plates, checkout match/result, model/browser/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive/security bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:18-59,81-283`; `e2e/crud.mjs`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`.

Rendered tests mock every API and complete a full lifecycle only for a unit; person is create-only, site/zone/slot lifecycle coverage is incomplete, and cross-property coverage is one mocked member POST. The browser story has no recorded run, is not a complete narrow-screen all-entity lifecycle, and does not prove a regular administrator's denial through the real server. Setting `innerWidth` in jsdom does not execute CSS layout.

**Consequence:** persisted administration, complete cross-property Super Admin operations, authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a future authorized run, execute full create/read/edit/delete-or-retire lifecycles for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Perform representative all-entity operations in a second property as Super Admin, prove regular-admin server denial, and record browser, console, and accessibility results.

## Low — accessibility verification limitation

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

No evidence establishes complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom assertions, and the logical-CSS check cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
