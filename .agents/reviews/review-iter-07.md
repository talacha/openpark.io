# Review iteration 07 — issues only

Evidence scope: independently reviewed the approved plan, iteration-6 report/verdict, iteration-7 commits `2fd5a8e`/`60cdd17`, all changed tests/dependencies, and the relevant unchanged routing, provider, share, pass-validation, check-in/checkout, policy, role, and browser-story paths. I relied on the recorded green full gate at `.agents/reviews/LOOP-SUMMARY.md:438-445` and did not rerun it. The worktree is clean; `adversarial-loop`, the user checkout's `main`, and `origin/main` all resolve to `60cdd17`, so the recorded fast-forward/push is established. At 2026-10-21T14:34:14Z the run is about 10h42m old and remains within its 12-hour budget.

## Medium — criterion 1: the emitted guest artifact is still not opened, decoded, and redeemed through the real app

**Location:** `apps/web/test/share-pass.test.tsx:105-136`; `apps/web/test/guest-pass.test.tsx:11-52`; `apps/web/test/qr.test.ts:18-22`; `apps/web/src/App.tsx:58-59`.

The new tests execute both mocked `navigator.share` branches and mount `GuestPass` directly, which verifies the payload and rendered SVG. They do not mount the `/pass` route through `App`/`AppProvider`, decode that rendered SVG, invoke `/v1/passes/lookup`, or redeem it. The existing QR decoder test independently generates its own pixels; it does not consume the guest page's rendered artifact. No mobile browser execution is recorded.

**Consequence:** the resident-to-guest handoff is not verified at the integration points where unauthenticated routing/provider startup, QR rendering/decoding, and server redemption meet, so the requirement that the shared artifact actually works at the gate remains unestablished in context.

**Correction/verification:** run a narrow mobile-viewport browser story that generates/shares a live pass, captures the emitted fragment URL, opens it in an unauthenticated context, decodes/scans the displayed QR to the exact token, and completes lookup plus redemption. Record browser, viewport, and requests/results.

## Medium — criterion 2 plus accessibility/security: the rendered test stops before verify/edit/submit and does not execute scanner or post-navigation rejection paths

**Location:** `apps/web/test/attendant-screen.test.tsx:20-49,53-94`; `apps/web/src/screens/Attendant.tsx:131-166,170-179,272-300,326-346`.

`attendant-screen.test.tsx` deliberately sets `ai_mode='off'` and types the token into the pass-code input. It mounts only `CheckInCapture`; it never drives `QrScanner.onResult`, routes to `CheckInConfirm`, edits/removes/replaces the prefilled plate, clicks Confirm, or asserts `/v1/passes/redeem` rather than `/v1/sessions`. Its rejection resolves while capture remains mounted, not after a camera plate read navigates away; the post-navigation safety case remains only in the hand-built state harness.

**Consequence:** the acceptance-critical scan → visible prepopulation → attendant verification/edit → safe pass redemption path is still not executed in the real routed screens, and the persisted-rejection guard is not verified where it prevents a reachable walk-in submission.

**Correction/verification:** mount the actual nested routed capture/confirm screens with a mocked scanner and deferred lookup, or run a browser story. Cover hinted and no-hint scans, focus/live announcement, edit/remove/replace, camera navigation while lookup is pending, rejection after navigation, disabled Confirm/no `/v1/sessions` before acknowledgment, and final `/v1/passes/redeem` with the intended token and edited plate.

## Medium — criteria 3 and 4: camera-to-field check-in and checkout remain unexecuted

**Location:** `apps/web/src/screens/Attendant.tsx:170-179,225-226,459-460`; `e2e/live-plate.mjs:1-22`; `apps/web/test/attendant-screen.test.tsx:20-26`; `.agents/reviews/LOOP-SUMMARY.md:419-426`.

The iteration explicitly leaves the Playwright camera work unrun, and the new attendant test turns AI/camera rendering off. The existing fake-camera story covers only check-in and has no recorded run; repository search still finds no fake-camera checkout story. Source callbacks alone do not execute `getUserMedia`, model/fixture decoding, React state/navigation, the visible controlled field, or checkout matching.

**Consequence:** neither camera acceptance criterion is verified in the real responsive UI, and checkout has no end-to-end camera evidence at all.

**Correction/verification:** run and record `e2e/live-plate.mjs` at its 390×844 viewport with the model and `.y4m` fixture. Add and run a checkout fake-camera story that opens a known session, scans its plate without manual entry, asserts the visible plate value and `/v1/checkout/match` result, and records browser/model/fixture plus console output.

## Medium — criterion 5 authorization/UX: policy persistence after Settings save remains mocked away

**Location:** `apps/web/test/policy-editor.test.tsx:34-40,55-77`; `apps/web/src/screens/GuestPasses.tsx:16-27`; `apps/api/src/routes/passes.ts:74-88`.

The rendered test now proves an admin can edit the amount and that the component issues `PATCH /v1/pass-policy` with `600000`; it also proves the supervisor charge input is disabled and Save is absent. But `policyResult.data` is fixed and `reload` is a no-op, so the test does not perform the prior report's required save/reload check or observe the persisted tenant value returning to the UI. API tests establish policy persistence and configured notification formatting separately, not through this Settings path.

**Consequence:** the configured policy's round trip through the real Settings data flow is still unverified; a broken reload/rehydration boundary could leave the administrator seeing stale data after a successful save.

**Correction/verification:** make the rendered test's API layer stateful (or run a browser test): persist the PATCHed value, have `reload()` return a new policy result, remount/reload the screen, and assert `6000` is displayed for that tenant. Keep the supervisor case and assert every editable policy control is disabled and no PATCH is issued.

## Medium — criteria 6 and 7 plus responsive authorization: Admin CRUD and Super Admin cross-property operations remain unverified in context

**Location:** `e2e/crud.mjs:11-84`; `e2e/people-roles.mjs:17-83`; `.agents/reviews/LOOP-SUMMARY.md:419-426`.

No iteration-7 test covers these criteria, and the iteration record explicitly says the browser stories were not run. The existing CRUD story remains 1280px-only; the Super Admin story switches property without performing representative person/site/unit/slot mutations there; no rendered story proves a regular administrator is denied the second property's reads and writes.

**Consequence:** user-facing CRUD completeness, narrow-mobile usability, platform-wide mutation, and the regular-admin tenant boundary are not verified together through the real UI/API authorization path.

**Correction/verification:** run the existing stories; add representative person/site/unit/slot create-edit-delete coverage at a narrow mobile viewport, perform representative mutations after a Super Admin switches to a second property, and assert a regular administrator cannot read or mutate that property's entities.

## Low — accessibility: manual assistive-technology and visual checks remain outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, and Admin/Super Admin screens; `.agents/reviews/LOOP-SUMMARY.md:427-429`.

Static semantics, focus assertions, locale parity, and logical-CSS checks cannot establish full WCAG conformance; no manual evidence was supplied.

**Verification:** record keyboard-only and VoiceOver/Safari behavior, focus order/live announcements, 200%/400% zoom, 320px reflow, light/dark contrast, and touch-target checks with versions and any failures.
