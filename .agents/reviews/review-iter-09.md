# Review iteration 09 — issues only

Evidence scope: independently reviewed the plan, iteration-8 findings, iteration-9 commit `f95bc0d`, its changed production paths and tests, and the unchanged callers/guards needed to establish consequences. I relied on the recorded green full gate in `LOOP-SUMMARY.md` and did not rerun it. The worktree is clean, and `adversarial-loop`, the user checkout's `main`, and `origin/main` all resolve to `db53f1c`; the iteration-9 summary entry records pushed tick `f95bc0d`. The prior Confirm rejection issue is resolved by the focusable alert/effect at `Attendant.tsx:283-286,353-357` and routed assertions at `attendant-confirm-focus.test.tsx:92-103`.

## Medium — criterion 1: the shared pass is still not verified from real generation through the real gate

**Location:** `apps/web/test/pass-e2e.test.tsx:29,41,54,109-128,127-161`; `apps/web/src/App.tsx:64`; `apps/web/src/main.tsx:20-22`; `apps/web/src/app-context.tsx:99,122`.

The joined test still starts from a fabricated `TOKEN`, mounts `GuestPass` directly, and mocks lookup/redeem success. It does not execute resident generation/share, the actual `/pass` route through `AppProvider`, or server HMAC, verify-code, version, and expiry validation for the rendered artifact. The separate green server tests do not join those stages.

**Consequence:** there is no in-context proof that the artifact a resident actually sends survives unauthenticated bootstrap and is accepted by the real gate as that same live two-hour pass.

**Correction/verification:** issue a live pass through the API, invoke the real resident Share control, open its fragment URL through `/pass` at a mobile viewport, decode the rendered QR, and perform real lookup/redeem. Assert exact token identity, two-hour expiry, and HMAC plus verify-code tamper rejection.

## Medium — criteria 3 and 4: the shipped camera acquisition/model path remains unexecuted

**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,68-71,75-102`; `e2e/live-plate.mjs:1-21`.

The rendered tests replace `LiveCamera` with a button that emits an already-decoded plate. They never execute `getUserMedia`, the shipped ONNX/model loader and decoder, a camera fixture, or a responsive browser. The existing fake-camera browser story still has no recorded run and covers check-in only.

**Consequence:** actual camera acquisition and plate decoding remain unverified for both check-in and check-out.

**Correction/verification:** run and record the 390×844 fake-camera check-in story with the real model and `.y4m` fixture; add and run the equivalent checkout story. Assert the visible plate, `/v1/checkout/match` request/result, browser/model/fixture versions, and a clean console.

## Medium — criteria 6 and 7: required entity CRUD and cross-property writes remain unexecuted

**Location:** `apps/web/test/crud-roles.test.tsx:68-122`; `apps/web/src/screens/People.tsx:225-315`; `apps/web/src/screens/Parking.tsx:34-98`.

The rendered CRUD test still performs create/edit/delete only for a unit. `People` is used only to switch a property selector and observe a units read; `Parking` is never mounted, no person/site/slot mutation is driven, no write is performed in the second property, no API denial is executed for a regular admin, and no narrow viewport is used.

**Consequence:** person/building/slot UI CRUD, mobile usability, Super Admin writes across properties, and the regular-admin property boundary remain unverified in context.

**Correction/verification:** drive create/edit/delete for person, site, unit, and slot through the real screens at a narrow viewport. Switch a Super Admin to a second property and perform representative writes there, then execute regular-admin cross-property read/write denials against the API.

## Medium — cross-cutting security/data integrity: the CRUD idempotency fix does not survive a real client retry and still excludes people

**Location:** `apps/web/src/api.ts:55-58`; `apps/web/src/screens/People.tsx:38-43,225-235`; `apps/web/src/screens/Parking.tsx:34-38,83-98`; `apps/api/src/http.ts:89-123`; `apps/api/src/routes/people.ts:92,194-208,300-315`; `apps/api/test/api.test.ts:270-290`.

`replaySafe` correctly replays an explicitly repeated key, but each real `post()` invocation defaults to a fresh `crypto.randomUUID()` and the forms retain no submission key across a lost response or double submit. A user retry therefore does not hit the stored response and still reaches `unit_exists`/`site_exists`/equivalent. `POST /v1/users` and `POST /v1/platform/tenants/:slug/members` are not replay-safe/idempotent at all, so their client-sent keys are ignored. If local-auth person creation commits but the first response is lost, the only temporary password is lost and retry reaches `already_member`. The new API test manually reuses one key and covers only unit creation, so it does not disprove these paths.

**Consequence:** ordinary retry/double-tap paths can still report failure after successful CRUD, duplicate side effects/audits, and strand a newly created person without a recoverable credential.

**Correction:** retain a submission-scoped key in each CRUD form and reuse it until that payload succeeds or is deliberately changed, while disabling pending submit controls. Require or honor that key on tenant and platform person creation too, but replace raw one-time-password replay with an invitation/password-setup or explicit credential-recovery flow. Add lost-response UI retry tests and same-key unit/site/slot/person API tests proving one mutation/audit and a usable onboarding outcome.

## Low — accessibility: manual assistive-technology and visual verification remains outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, Parking/People/Units, and platform property switching.

The new routed focus test closes the identified Confirm-alert defect, but no evidence covers keyboard-only traversal, VoiceOver/Safari, 200%/400% zoom, 320px reflow, light/dark contrast, or physical touch targets. Full WCAG conformance still requires those manual checks with browser/AT versions and fixes for any failures.
