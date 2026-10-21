# Review iteration 03 — issues only

Evidence scope: reviewed iteration-3 commits `2b36ce1..9039c1c`, the plan and prior findings, changed callers/guards, relevant server policy and pass-validation paths, tests/E2E stories, recorded gate evidence, and publication refs. The worktree is clean; `adversarial-loop`, the user checkout's `main`, and `origin/main` are all `9039c1c`, and `LOOP-SUMMARY.md` records the green full gate and pushed SHA. I did not rerun the recorded full suites. The summary explicitly says the rendered/Playwright and manual accessibility checks were not run.

## High — criteria 2/3: confirmation can outrun pass lookup, and stale QR lookups can win

**Location:** `apps/web/src/components/LiveCamera.tsx:52,56`; `apps/web/src/screens/Attendant.tsx:119-137,141-150,260-264,313`.

`LiveCamera` can report a QR and a plate from the same running camera. `usePass()` awaits `/v1/passes/lookup`, while `onPlate()` immediately navigates to confirmation. Pass lookup has no pending state visible to `FlowState`/Confirm, whose button is disabled only by `busy || !flow.plate`; a fast tap therefore takes the ordinary `/v1/sessions` branch while `flow.pass` is still null. A later valid response cannot associate/redeem that pass. A different QR is also reported immediately, and there is no request generation/abort guard, so an older response can overwrite a newer accepted pass.

**Consequence:** a valid guest can be checked in as an ordinary paid stay with the pass left active, or the wrong pass can be redeemed after out-of-order scans.

**Correction:** make pass validation a sequenced pending operation shared by capture and confirm; pause/guard camera transitions on QR detection, ignore stale responses, and block confirmation until the current lookup settles. Add deferred rendered tests for QR→plate→early Confirm (only `/v1/passes/redeem` becomes possible after success) and two out-of-order QR responses (newest scan wins).

## Medium — criterion 1: Share and the public guest QR remain unverified in a rendered browser

**Location:** `apps/web/src/screens/Resident.tsx:147-179`; `apps/web/src/App.tsx:64`; `apps/web/src/screens/GuestPass.tsx:19-45`; `apps/web/test/pass.test.ts:65-75`; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

The source now passes a fragment URL and renders its token as a QR, but the recorded test only calls pure URL/parser helpers. No executed component/browser path proves that the resident button invokes each file-share/text-share/download branch, a directly opened link renders through the deployed SPA, and the displayed QR reaches lookup/redeem.

**Correction/verification:** add and record rendered/browser coverage for all three capability branches; inspect the actual shared/copied artifact, open the guest URL, decode/scan its rendered QR, and complete server lookup/redeem. Record browser and viewport.

## Medium — criterion 2/accessibility: prepopulate, focus, edit, and redemption remain unverified in context

**Location:** `apps/web/src/screens/Attendant.tsx:116-137,168-200,253-315`; `apps/web/test/attendant-flow.test.ts:13-49`; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

The new tests exercise pure state patches only. No rendered execution scans/enters a signed hinted pass, observes focus/live announcement and the visible editable plate, edits/removes/replaces it, redeems it, and verifies the persisted plate/pass association.

**Correction/verification:** add and record that component/browser integration story, including the pending-lookup race above.

## Medium — criteria 3/4: camera-to-field behavior still lacks check-in and checkout execution

**Location:** `apps/web/src/screens/Attendant.tsx:141-163,414-419`; `e2e/live-plate.mjs:9-22`; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

The fake-camera story was explicitly not run. The existing story covers only check-in, and no checkout fake-camera story exists; pure ALPR tests do not execute `getUserMedia` through React callbacks and controlled fields.

**Correction/verification:** run and record the mobile check-in story; add/run checkout coverage that opens a session, scans its plate, asserts the field and correct match without manual entry, and records browser, viewport, fixture/model, and result.

## Medium — criterion 5: policy UI persistence and a custom 12-hour amount are not executed

**Location:** `apps/web/src/screens/GuestPasses.tsx:16-25,43-53`; `apps/api/test/passes.test.ts:283-295,357-373`; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

The green API suite covers MXN/USD seeds, PATCH, default `$5,000.00` overstay notices, and a custom `$25.00` reminder, but never triggers a 12-hour overstay after changing the policy amount. The unrun guest-pass E2E only reads the UI default; it does not edit, save, and reload the field.

**Correction/verification:** trigger overstay after setting a non-default amount and assert guest, host, and supervisor messages use that currency-formatted amount plus the move-vehicle instruction while 10h/11h stays unchanged. Add/run a browser check that edits, saves, and reloads the policy field.

## Medium — criteria 6/7: rendered Admin CRUD and Super Admin cross-property operations remain unverified

**Location:** `e2e/crud.mjs:11-92`; `e2e/people-roles.mjs:17-88`; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

The browser stories were explicitly not run and remain desktop-only. The Super Admin story switches property but performs no edit/delete there, and no rendered test proves a regular administrator cannot read or mutate the second property.

**Correction/verification:** run and record the existing stories; add representative person/site/unit/slot CRUD at a narrow mobile viewport, cross-property Super Admin edit/delete, and a regular-admin cross-tenant denial.

## Low — accessibility: manual AT and visual checks remain outstanding

**Location:** changed Resident, GuestPass, and Attendant flows plus required admin screens; `.agents/reviews/LOOP-SUMMARY.md:163-173`.

Automated checks cannot establish full WCAG conformance, and no manual evidence was supplied.

**Verification:** record keyboard-only and VoiceOver/Safari behavior, focus order/live announcements, 200%/400% zoom and 320px reflow, light/dark contrast, and touch-target checks with versions and failures.
