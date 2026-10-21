# Review iteration 14 — issues only

Evidence scope: independently reviewed `plan.md`, `ARCHITECTURE.md`, `docs/DOMAIN.md`, `review-iter-13.md`, the prior verdict, current source/callers/guards, and the terminal-tick diff (`bc01a3d..9190657`, review/bookkeeping only). I relied on the recorded green gate in `LOOP-SUMMARY.md` (core build, seven-project typecheck, 212 passing tests with one pre-existing skip, and the CSS logical-properties check) and did not rerun suites. The worktree is clean; worktree HEAD, the user's local `main`, and `origin/main` all resolve to `9190657`, so the terminal tick was fast-forwarded/pushed and its summary entry exists. Criterion 5 remains correctly scoped: `overstayCharge` is still per-tenant and PATCH-editable with the matching admin/Super Admin UI guard; provisioning seeds `500000` only when the resolved currency is `MXN` and `0` otherwise; 12-hour guest/host/supervisor notices interpolate the currency-formatted policy amount and instruct moving the vehicle; 10/11-hour reminder paths remain separate; no payment enforcement was added.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:693-761,771-886`; commits `6b290f6`, `bc01a3d`, `4bd3556`, and `9190657`.

The summary records iteration 10 as the hard cap and later explicitly records that no further implementation tick may be queued. Production code was nevertheless changed and published in iteration 13 (`6b290f6`) after twelve review reports already existed. The terminal tick correctly made no production change, but it cannot undo the established cap violation; the extended clock did not extend the unchanged ten-iteration maximum.

**User-visible/consequential impact:** continuing this workflow would violate the governing user instruction and add unreviewed post-cap work.

**Correction:** stop this loop after this review. Preserve the already-published linear history—no reset, bookkeeping-only revert, force-push, or further implementation tick—and carry the product findings below into a separately authorized future run.

## High — criterion 7 / idempotency: tenant creation still permits keyless duplicate writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:166-168,181-184`; `apps/api/src/routes/people.ts:323-325`; `apps/api/src/services/tenants.ts:30-43`; `apps/api/test/closed-preview.test.ts:35-40,93-96,109-112`.

`POST /v1/platform/tenants` is `replaySafe`, not strictly `idempotent`. `definePlatformRoute` therefore accepts a missing key and directly executes the handler, and current route tests exercise keyless success. If the response is lost, a retry without a key runs `provisionTenant` again; with no explicit slug, its collision branch creates a random-suffixed second property.

**User-visible consequence:** one intended Super Admin action can create two live properties, owner memberships, starter inventories, policies, and audit histories.

**Correction:** require `Idempotency-Key` on tenant creation (`idempotent: true`), update all callers/tests, assert keyless requests are rejected, and prove an exact-key lost-response retry returns one tenant. Add a rendered Platform-form test for stable retry key and disabled in-flight submission.

## High — criterion 7 / data integrity: platform reservation and business mutation are not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent write recovery.  
**Location:** `apps/api/src/http.ts:184-208`; `apps/api/src/db.ts:14-34`; `apps/api/src/services/tenants.ts:30-69`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The platform reservation insert, tenant/member business mutation, and final status/response update are three independent autocommits. There is no lease, stale-reservation recovery, or durable operation identifier on the created resource. A process/database failure after the mutation commits but before finalization leaves `status=0` permanently. The same key then always returns `request_in_progress`; a fresh key reruns no-slug provisioning and can create a random-suffixed duplicate.

**User-visible consequence:** a successful property creation can be permanently stranded behind 409 responses or duplicated when the administrator retries.

**Correction:** atomically bind durable operation completion/result identity to the business mutation, or store a unique operation ID on the created resource so a stale reservation can reconstruct and replay the committed result. Add fault-injection coverage for failure after business commit but before response finalization, proving retry returns the single committed property.

## Medium — criteria 6 and 7 / local-auth onboarding: replay loses the only usable credential

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/http.ts:117-119,206-208`; `apps/api/src/services/people.ts:21-37`; `apps/api/src/routes/people.ts:194-209,300-318,323-339`; `apps/web/src/screens/People.tsx:249-254`; `apps/web/src/screens/Platform.tsx:32-35`; `apps/web/src/screens/Auth.tsx:45-80,113`.

Local person/owner creation generates a one-time password and stores only its hash; the first successful response is the sole delivery channel. Both replay stores replace `temporaryPassword` with `null`. After a committed request whose response is lost, exact-key replay returns 201 without a credential, while People/Platform report an invitation even though local auth created none. The forgot/reset path is Supabase-only and the local login UI exposes no recovery path.

**User-visible consequence:** a created person—or a new property's only owner—can exist but be unable to sign in.

**Correction:** retain the no-secret-in-replay rule, but use a recoverable setup/invitation mechanism or provide an authenticated credential setup/reset action with an explicit replay outcome. Test lost-response retries for tenant owner, tenant member, and platform member creation through successful first local sign-in.

## Medium — criterion 1: the live resident share-to-gate chain remains unverified in context

**Criterion/bar:** Generate and share a secure two-hour QR pass.  
**Location:** `apps/web/test/pass-e2e.test.tsx:20-54,105-161`; `apps/web/src/screens/Resident.tsx:171-211`; `apps/web/src/screens/GuestPass.tsx`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-84,165-170,236-247`.

The rendered join begins with a fabricated token, mounts `GuestPass` directly rather than entering `/pass` through the real `AppProvider`/`App` bootstrap, replaces the camera UI, and mocks lookup/redeem. Separate recorded API tests establish two-hour expiry, HMAC rejection, and valid-HMAC/stored-`verify_code` mismatch rejection, but no recorded execution joins server-generated bytes to the actual Resident Share control, public fragment route, decoded guest QR, and real gate lookup/redeem.

**User-visible consequence:** the exact artifact produced and shared in the deployed flow has not been shown to survive unauthenticated bootstrap and redeem as that same pass.

**Correction/verification:** outside this capped loop, run a real routed mobile-browser story that issues a live pass, invokes the Resident Share control, opens `/pass#t=…`, decodes the displayed QR, and performs real lookup/redeem. Assert exact token identity, two-hour unused expiry, HMAC tamper rejection, and stored-`verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture at check-in and check-out; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:17-24,55-110`; `apps/web/src/components/LiveCamera.tsx:15-69`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. There is no recorded run through `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive browser rendering. The existing real-camera script covers check-in only; no checkout camera story or execution evidence exists.

**User-visible consequence:** actual camera acquisition and model decoding are unverified in the shipped stack for both required flows, even though downstream field wiring is tested.

**Correction/verification:** outside this capped loop, run and record the 390×844 real-model fake-camera check-in story and add/run its checkout equivalent. Assert visible filled plates, checkout match/result, model/browser/fixture versions, stopped tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive/security bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:81-283`; `e2e/crud.mjs:1-93`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-74`.

The rendered tests mock every API and complete full lifecycle only for a unit; person is create-only, site/zone/slot lifecycle coverage is incomplete, and cross-property coverage is one mocked member POST. The browser script has no recorded run, is desktop-sized, omits full person CRUD and representative all-entity writes in a second property, and does not prove a regular administrator's real server denial. Assigning `innerWidth` in jsdom does not execute CSS layout.

**User-visible consequence:** complete persisted administration, cross-property Super Admin operations, authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** outside this capped loop, run and record full create/read/edit/delete-or-retire lifecycles for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Perform representative all-entity operations in a second property as Super Admin, prove regular-admin server denial, and record browser/console/accessibility results.

## Low — accessibility verification limitation

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

No evidence establishes complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Static semantics, jsdom tests, and the logical-CSS check cannot establish full WCAG conformance.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
