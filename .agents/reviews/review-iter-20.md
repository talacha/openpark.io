# Review iteration 20 — issues only

Evidence scope: independently reviewed `plan.md`, `review-iter-19.md`, the current bookkeeping diff `ba8306f..bc85725`, recorded verification, and the relevant route wrappers, transactions, UI callers, guards, tests, and browser scripts. No production, test, schema, locale, or migration file changed this tick, so I did not rerun the full gate: the same production tree has recorded passes for the core build, seven-project typecheck, 212 tests with one pre-existing skip, and `check:css` (`LOOP-SUMMARY.md:1192-1198`). The worktree was clean before this report; worktree `HEAD`, local `main`, and `origin/main` were all `bc85725`. Iteration 20 records the flagged work, docs-only change, gate status, and pushed tick SHA `e38da5a` at `LOOP-SUMMARY.md:1152-1201`, and `bc85725` published that SHA record, so per-tick publication/bookkeeping held.

Criterion 5 has no blocker: the per-tenant field remains PATCH- and Settings-editable (`apps/api/src/routes/passes.ts:74-88`; `apps/web/src/screens/GuestPasses.tsx:13-59`), provisioning uses `500000` only for resolved MXN currency and `0` otherwise (`apps/api/src/services/tenants.ts:23-25,65-69`), and the 12-hour guest/host/supervisor path formats the snapshotted/configured policy amount and includes the move-vehicle instruction while leaving 10/11-hour reminders separate (`apps/api/src/services/passes.ts:354-440`; `apps/api/src/notify/messages.ts:7-23`; `apps/api/test/passes.test.ts:281-366`). It records only an announced pending event, not billing or collection.

## Blocking — loop contract: the hard 10-iteration cap was exceeded

**Criterion/bar:** Autonomous loop stop condition.  
**Location:** `.agents/reviews/LOOP-SUMMARY.md:561-628,771-835,1152-1201`; commits `fddd34b`, `6b290f6`, `e38da5a`, and `bc85725`.

Iteration 10 is recorded as the hard cap, but production code was subsequently changed and published in iteration 13, and the workflow has now reached a twentieth implementer tick. This tick correctly changed only review/bookkeeping artifacts, but another implementation tick would continue violating the governing stop condition.

**Consequence:** further implementation in this workflow would be unauthorized post-cap work without the promised bounded review cycle.

**Correction:** stop this loop after this review. Preserve the published linear history—no reset, revert, force-push, or further implementation tick—and carry the product blockers below into a separately authorized run.

## High — criterion 7 / idempotency: tenant creation still accepts duplicate-prone keyless writes

**Criterion/bar:** Super Admin operations; secure, idempotent writes.  
**Location:** `apps/api/src/http.ts:165-176`; `apps/api/src/routes/people.ts:323-336`; `apps/api/src/services/tenants.ts:29-43`; `apps/api/test/closed-preview.test.ts:31-41,145-163`.

`POST /v1/platform/tenants` remains `replaySafe`, not `idempotent`. `definePlatformRoute` executes a `replaySafe` handler when `Idempotency-Key` is absent, route tests prove keyless creation is accepted, and `provisionTenant` auto-suffixes a colliding generated slug. A lost-response keyless retry can therefore provision a second live property.

**Consequence:** one intended Super Admin action can duplicate a property, owner, inventory, policy, and audit history.

**Correction:** require `Idempotency-Key` on tenant creation, update every caller/test to send one stable submission-scoped key, reject keyless requests, and test that a lost-response retry returns the original property while the UI prevents an in-flight duplicate submit.

## High — criterion 7 / data integrity: platform creation and replay finalization are not atomic or recoverable

**Criterion/bar:** Super Admin operations; correctness and idempotent recovery.  
**Location:** `apps/api/src/http.ts:180-208`; `apps/api/src/db.ts:12-34`; `apps/api/src/services/tenants.ts:29-72`; `apps/api/migrations/001_init.sql:278-287`; `apps/api/migrations/017_platform_idempotency.sql:7-15`.

The platform idempotency reservation, `create_tenant` call, tenant initialization transaction, and replay finalization are separate commits. There is no lease, durable operation-to-tenant identity, reconciliation, or compensation. A failure after `create_tenant` can leave a partial tenant and delete the reservation; a crash after the business commit but before finalization leaves `status=0` permanently.

**Consequence:** property creation can strand an unusable or partially initialized property; exact-key recovery can remain blocked while a fresh key can create a duplicate.

**Correction:** make creation, initialization, and replay completion one transaction, or persist a unique operation-to-tenant identity with resumable phases and stale-operation recovery. Add fault-injection tests after `create_tenant` and after the business commit but before replay finalization, proving retries converge on one complete property.

## Medium — criteria 6 and 7: local-auth onboarding can lose the only usable credential

**Criterion/bar:** Admin/Super Admin person CRUD; correctness and recoverability.  
**Location:** `apps/api/src/services/people.ts:15-37`; `apps/api/src/services/tenants.ts:43-55`; `apps/api/src/http.ts:117-119,206-208`; `apps/api/src/routes/people.ts:194-208,300-336`; `apps/web/src/screens/People.tsx:249-253`; `apps/web/src/screens/Platform.tsx:24-36`; `apps/web/src/screens/Auth.tsx:65-81,103-114`; `apps/api/test/api.test.ts:383-395`.

Local onboarding stores only a generated password hash and returns the plaintext once, while both replay stores replace `temporaryPassword` with `null`. The apparent forgot/reset routes do not disprove the path: they are linked and implemented only for external auth, and a local `/forgot` submission falls into the login request. A lost first response therefore loses the only credential.

**Consequence:** a created tenant member, cross-property member, or new property's only owner can be unable to sign in without direct database intervention.

**Correction:** in a separately authorized run, add a recoverable expiring setup/invitation flow or authenticated credential-reset flow without storing plaintext secrets. Define replay behavior explicitly and test lost-response retries for all three creation paths through successful first local sign-in.

## Medium — criterion 1: live resident share-to-gate behavior remains unverified in context

**Criterion/bar:** Generate and share a tamper-protected QR that expires after two unused hours.  
**Location:** `apps/web/test/pass-e2e.test.tsx:105-161`; `apps/web/src/screens/Resident.tsx:147-194`; `apps/web/src/screens/GuestPass.tsx:19-45`; `apps/web/src/App.tsx:58-65`; `apps/api/src/services/passes.ts:63-95,165-247`; `e2e/guest-pass.mjs:1-158`.

Rendered tests exercise Share/public-QR/attendant behavior and API tests separately execute two-hour expiry, HMAC rejection, and stored `verify_code` mismatch. The joined rendered test nevertheless starts from a fabricated token, mounts `GuestPass` directly, substitutes the scanner, and mocks lookup/redeem. The real-stack browser script issues and redeems a live pass but does not invoke Share or route through the public guest page. No recorded execution joins the complete shipped path.

**Consequence:** the exact server-issued artifact produced by the live Share control has not been shown to survive the routed guest handoff and redeem as the same valid pass.

**Correction/verification:** in a separately authorized run, execute and record a 390×844 routed browser story from live pass issue through the real Share control, `/pass#t=…`, rendered QR decode, and real lookup/redeem. Assert exact token identity, default two-hour unused expiry, HMAC-field tamper rejection, and stored `verify_code` mismatch rejection.

## Medium — criteria 3 and 4: the shipped camera/model path remains unexecuted

**Criterion/bar:** Camera plate capture filling check-in and check-out fields; mobile/performance correctness.  
**Location:** `apps/web/test/attendant-camera.test.tsx:17-24,55-110`; `apps/web/src/components/LiveCamera.tsx:16-76`; `apps/web/src/screens/Attendant.tsx:224-226,461-465`; `e2e/live-plate.mjs:1-23`.

Rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. No recorded run executes `getUserMedia`, the shipped ONNX loader/decoder, a camera fixture, and responsive rendering for both flows; the existing browser script covers check-in only and has no recorded execution in this review run.

**Consequence:** actual camera acquisition/model decoding may fail before the covered downstream field wiring, and checkout camera behavior remains unverified in the shipped stack.

**Correction/verification:** in a separately authorized run, record 390×844 real-model fake-camera stories for check-in and checkout, including visible filled fields, checkout match/result, browser/model/fixture versions, stopped media tracks after navigation, and a clean console.

## Medium — criteria 6 and 7: complete CRUD and cross-property behavior remain unverified through the real stack

**Criterion/bar:** Admin CRUD for person/site/unit/slot; Super Admin operations across properties; responsive and authorization bars.  
**Location:** `apps/web/test/crud-roles.test.tsx:81-239`; `apps/web/src/screens/People.tsx:225-343`; `apps/web/src/screens/Parking.tsx:24-250`; `apps/web/src/screens/Platform.tsx:14-96`; `e2e/crud.mjs:1-end`.

The rendered suite mocks every API and completes a full lifecycle only for a unit; person is create-only, site/zone/slot coverage is incomplete, and cross-property coverage is one mocked member POST. The browser script exercises unit/site/zone/slot operations at 1280px but not complete person CRUD, second-property all-entity operations, or the regular-admin server boundary, and no recorded run establishes narrow responsive behavior.

**Consequence:** persisted all-entity administration, representative all-entity Super Admin behavior across properties, server authorization boundaries, and narrow-screen usability remain unverified in context.

**Correction/verification:** in a separately authorized run, execute create/read/edit/delete-or-retire for person, site/building, unit, and slot through the real routed UI/API at a narrow viewport. Repeat representative all-entity operations in a second property as Super Admin and prove regular-admin server denial.

## Low (non-gating) — full accessibility conformance still needs manual verification

**Criterion/bar:** Accessibility.  
**Location:** Resident Share/GuestPass, attendant pass/camera flows, policy editor, People/Units/Parking, Platform creation, and property switching.

Static semantics, rendered jsdom assertions, and the logical-CSS check cannot establish complete keyboard-only traversal, VoiceOver/Safari focus and announcements, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets.

**Verification:** perform and record those manual checks with browser/AT versions and correct any failures.
