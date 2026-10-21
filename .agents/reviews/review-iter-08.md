# Review iteration 08 — issues only

Evidence scope: independently reviewed the plan, iteration-7 findings, iteration-8 commit `598eca7`, all changed tests, and the relevant unchanged bootstrap, pass, attendant, camera, CRUD, authorization, and idempotency paths. I relied on the recorded green full gate in `.agents/reviews/LOOP-SUMMARY.md:488-493` and did not rerun it. The worktree is clean, and `adversarial-loop`, the user checkout's `main`, and `origin/main` all resolve to `6f4994f`, establishing the recorded fast-forward publish.

## Medium — criterion 1: the joined pass story still bypasses generation, sharing, public routing, and real server validation

**Location:** `apps/web/test/pass-e2e.test.tsx:29,54,109-128,154-161`; `apps/web/src/main.tsx:20-22`; `apps/web/src/app-context.tsx:122`; `apps/web/src/App.tsx:64`.

The new test does decode the SVG and drive the routed attendant success screen, but it starts from a fabricated `TOKEN`, mounts `GuestPass` directly rather than opening `/pass` through `App`/`AppProvider`, and mocks both `/v1/passes/lookup` and `/v1/passes/redeem` as successful. It never generates the token through the resident/API path or invokes the resident share artifact in the same flow. Thus the test's “live, signed” comment is not evidence that this displayed token passes the server's HMAC, verify-code, version, or expiry checks.

**Consequence:** the suite still does not establish that the artifact a resident actually shares survives unauthenticated app bootstrap and is accepted by the real gate endpoints as the same live two-hour pass.

**Correction/verification:** issue a live pass through the API, invoke the resident Share control, open its fragment URL through the real `/pass` route at a mobile viewport, decode the rendered QR, and perform real lookup/redeem. Assert exact token identity, two-hour expiry, and HMAC plus verify-code tamper rejection.

## Medium — criterion 2 plus accessibility: post-navigation pass rejection remains unexecuted in the routed screen and loses focus

**Location:** `apps/web/src/screens/Attendant.tsx:123-128,216-219,348-354`; `apps/web/test/pass-e2e.test.tsx:127-161`; `apps/web/test/attendant-flow.test.ts:107-125`.

The routed iteration-8 test covers only a successful lookup/redeem. The rejection that arrives after a camera read navigates to Confirm remains only in a pure state harness. Source inspection also establishes a real focus gap: `CheckInCapture` gives its rejection banner `tabIndex`, a ref, and a focus effect, while the corresponding `CheckInConfirm` banner has none. The `canConfirm` guard does correctly block the write, so this is not reported as a bypass.

**Consequence:** after the camera control unmounts and lookup rejects on Confirm, keyboard users lose their focus context and are not moved to the required acknowledgment control; the actual routed guard/announcement path is still unverified.

**Correction/verification:** make the Confirm rejection banner programmatically focusable and focus it when `passError` appears. Add a routed deferred-lookup test that triggers camera navigation, rejects on Confirm, asserts alert focus plus disabled/no `/v1/sessions` submission, then acknowledges and returns to capture.

## Medium — criteria 3 and 4: the shipped camera acquisition/model path is still not executed

**Location:** `apps/web/test/attendant-camera.test.tsx:11-24,68-71,78-99`; `e2e/live-plate.mjs:1-22`.

The new tests replace `LiveCamera` with a button that supplies an already-decoded plate. They execute the screen's `onPlate` callbacks but not `getUserMedia`, the ONNX/model decoder, a camera fixture, or a responsive browser. The existing check-in fake-camera story still has no recorded run, and checkout still has no camera browser story.

**Consequence:** whether an attendant can actually acquire and decode a plate through the shipped camera stack on check-in or checkout remains unverified.

**Correction/verification:** run and record `e2e/live-plate.mjs` at 390×844 with its real model and `.y4m` fixture. Add and run the equivalent checkout story, asserting the visible plate, `/v1/checkout/match` request/result, browser/model/fixture versions, and clean console.

## Medium — criteria 6 and 7: the new CRUD test omits three required entity flows and every cross-property mutation

**Location:** `apps/web/test/crud-roles.test.tsx:26,68-120`; `apps/web/src/screens/Parking.tsx:22,34-38,93-102,126,170`.

`crud-roles.test.tsx` executes create/edit/delete only for a unit. It mounts `People` solely to change a property selector and observe `/v1/platform/tenants/other/units`; it performs no person mutation, never mounts `Parking` for site or slot CRUD, performs no write in the second property, and does not execute a regular administrator's cross-property denial. No narrow viewport is configured.

**Consequence:** person/site/slot UI CRUD, narrow-mobile usability, Super Admin writes across properties, and the regular-admin property boundary remain unestablished in context.

**Correction/verification:** drive create/edit/delete for person, site, unit, and slot through the real screens at a narrow viewport. Switch a Super Admin to a second property and perform representative writes there, then execute regular-admin cross-property read/write denials against the API.

## Medium — cross-cutting security/data integrity: required CRUD writes are not idempotent

**Location:** `apps/api/src/http.ts:82-109`; `apps/api/src/routes/people.ts:92-107,194-210`; `apps/api/src/routes/slots.ts:25-38,165-184`; `apps/api/src/services/people.ts:22-36`; `apps/web/src/api.ts:58`.

The HTTP layer replays an idempotency key only when a route declares `idempotent`, but the required unit/person/site/slot creation routes do not. Although the web `post()` helper sends a key, these routes ignore it. This is a reachable failure, not merely missing test depth: if a local-auth person creation commits and its response is lost, retry reaches `already_member` rather than a replay; the generated one-time password from the first response is no longer available.

**Consequence:** network/intermediary retries can report failure after successful mutation and can strand local-auth onboarding; duplicate audit/side effects are not replay-safe either.

**Correction:** make the CRUD mutations replay-safe with server-enforced idempotency and client-stable submission keys. For local-user creation, use an invitation/password-setup or explicit recovery result rather than depending on replaying a redacted one-time secret. Add same-key replay tests proving one entity/audit mutation and a usable retry outcome.

## Low — accessibility: manual assistive-technology and visual verification remains outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, Parking/People/Units, and platform property switching; `.agents/reviews/LOOP-SUMMARY.md:447-495`.

No iteration-8 evidence covers keyboard-only traversal, VoiceOver/Safari, 200%/400% zoom, 320px reflow, light/dark contrast, or touch targets. Static semantics and `check:css` cannot establish full WCAG conformance.

**Verification:** record those manual checks with browser/AT versions and fix any failures; in particular verify the async pass-result announcements and focus transitions on physical mobile devices.
