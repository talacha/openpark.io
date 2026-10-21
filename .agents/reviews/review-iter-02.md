# Review iteration 02 — issues only

Evidence scope: reviewed iteration-2 commits `c39ccb3..cd95692`, the plan and prior report, changed callers and guards, relevant tests/E2E stories, the recorded full-gate result, and publication refs. The worktree is clean and `adversarial-loop`, local `main`, the user checkout's `main`, and `origin/main` are all `cd95692`; `LOOP-SUMMARY.md` records the green gate and pushed SHA. The recorded full suites were not rerun. The summary explicitly says the browser E2E stories were not run.

## High — criterion 1: text-only Web Share still does not give the guest a QR

**Location:** `apps/web/src/screens/Resident.tsx:147-170`; `apps/web/src/pass.ts:67-87`; `apps/web/test/pass.test.ts:35-64`.

When Web Share exists but file sharing does not, `SharePass` calls `nav.share({ title, text })` and returns. The text now contains the signed `OPP2|…` token, but it contains neither a QR image nor a guest-view link that renders one. A guest receiving that text on another device cannot present it to the attendant camera; the attendant text input could redeem the token only if the long token were separately transferred onto the attendant device. The pure helper tests do not execute `SharePass` or prove a guest can present the result. This reachable branch therefore still reports a successful share without sharing the required scannable QR pass.

**Correction:** share a guest-facing URL that carries the signed token in the URL fragment and renders the QR client-side (avoiding token leakage to server logs), or otherwise transfer the QR artifact instead of returning after text-only share. Add a component/browser test for file-share, text-only-share, and no-Share fallbacks and prove the received artifact reaches scanner/redeem.

## High — criteria 2/3: concurrent QR lookup can erase a camera-read plate

**Location:** `apps/web/src/components/LiveCamera.tsx:49-57`; `apps/web/src/alpr/live.ts:27-30`; `apps/web/src/screens/Attendant.tsx:119-142,147-156,201,302-322`.

`LiveCamera` deliberately decodes a QR and returns ALPR reads from the same frame loop. `usePass()` captures `flow`, awaits `/v1/passes/lookup`, then computes and unconditionally writes `plate: patch.plate`; meanwhile `onPlate()` can write the live plate and navigate to confirm. With a valid no-hint pass and a slower lookup, `onPlate` can win first, after which the lookup computes from its stale pre-read snapshot and overwrites the current plate with `''`. The confirm screen has no plate editor and its Confirm button is disabled only by `busy`, not an empty plate. The new helper tests cover serial snapshots only, so they cannot detect this race.

**Consequence:** ordinary camera/network timing can move a valid pass check-in to an uneditable confirmation screen with the scanned plate erased.

**Correction:** apply pass acceptance atomically against the latest `FlowState` (for example, a reducer/functional update), guard or cancel stale/competing camera and lookup completions, and preserve a latest independently captured plate for a no-hint pass. Disable confirmation without a plate and provide an edit/back path. Add a deferred-lookup regression test in which `onPlate` completes before the no-hint pass response.

## Medium — criterion 2/accessibility: prepopulate, focus, edit, and submit remain unverified in a rendered flow

**Location:** `apps/web/src/screens/Attendant.tsx:113-143,174-216`; `apps/web/test/pass.test.ts:66-94`; `.agents/reviews/LOOP-SUMMARY.md:103-114`.

The accepted-banner focus and keypad reveal are source-level improvements, but recorded execution remains pure mapping/provenance tests. No rendered test enters/scans a signed hinted pass, observes focus and the visible editable plate, edits it, submits, and verifies the stored plate/pass association. Thus the required in-context prepopulate/verify/submit behavior and keyboard/screen-reader transition are not established.

**Correction/verification:** add and record a browser/component integration test covering signed hinted-pass acceptance, banner focus, visible plate editing, redemption, persisted association, and replacement/removal transitions.

## Medium — criteria 3/4: camera-to-field behavior still has no recorded check-in/checkout execution

**Location:** `.agents/reviews/LOOP-SUMMARY.md:103-114`; `e2e/live-plate.mjs:10-20`; `apps/web/src/screens/Attendant.tsx:201,423-425`.

The implementer explicitly did not run the fake-camera stories. The existing `live-plate.mjs` covers check-in only, and no fake-camera checkout story exists; pure ALPR tests do not execute `getUserMedia` through the React callbacks and fields.

**Correction/verification:** run and record the fake-camera check-in story; add/run a checkout story that opens a session, scans its plate, asserts the checkout field value, and reaches the correct review without manual entry. Record browser, viewport, fixture/model, and result.

## Medium — criteria 6/7: rendered admin CRUD and cross-property Super Admin operation remain unverified

**Location:** `.agents/reviews/LOOP-SUMMARY.md:103-114`; `e2e/crud.mjs:11-112`; `e2e/people-roles.mjs:17-91`; `e2e/menu.mjs:43-117`.

The required stories were explicitly not run. In addition, `crud.mjs` and `people-roles.mjs` use desktop contexts; `people-roles.mjs` switches a Super Admin to another property but performs no CRUD there, and no browser assertion proves a regular admin cannot cross that tenant boundary. API and menu unit coverage cannot establish the rendered, responsive workflows.

**Correction/verification:** run and record the existing stories; extend them at a narrow mobile viewport for representative person/site/unit/slot CRUD, perform edit/delete after switching a Super Admin to a second property, and assert a regular admin cannot read or mutate that property.

## Low — accessibility: manual AT, contrast, zoom/reflow, and touch review is still outstanding

**Location:** `apps/web/src/screens/Resident.tsx`, `apps/web/src/screens/Attendant.tsx`, and the admin screens above; `.agents/reviews/LOOP-SUMMARY.md:103-114`.

The recorded automated gate cannot establish full WCAG conformance, and no manual accessibility evidence was supplied.

**Verification:** after the blocking UI fixes, record VoiceOver/Safari and keyboard-only testing, 200%/400% zoom and 320px reflow, light/dark contrast, focus order, live announcements, and mobile touch-target checks, including browser/AT versions and any failures.
