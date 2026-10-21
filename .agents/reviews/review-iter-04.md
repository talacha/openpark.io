# Review iteration 04 — issues only

Evidence scope: reviewed iteration-4 implementation commit `519d377`, documentation commit `e1c9079`, the plan, prior findings, changed tests, and the relevant pass-flow routes/callers. I read the recorded green gate rather than rerunning it. Publication is consistent: the worktree is clean and `adversarial-loop`, the user checkout's `main`, and `origin/main` are all `e1c9079`; `LOOP-SUMMARY.md` records the iteration, green gate, and pushed tick SHA. The summary explicitly records that rendered/Playwright and manual accessibility checks were not run.

## High — criteria 2/3: the lookup sequence resets across the capture → confirm → edit route lifecycle

**Location:** `apps/web/src/App.tsx:90-95`; `apps/web/src/screens/Attendant.tsx:116,128-148,327-328`; `apps/web/test/attendant-flow.test.ts:59-77,110-119`.

`Flow` persists above the nested check-in routes, but `passSeq` is a ref owned by `CheckInCapture`. A camera plate can route an in-flight lookup to Confirm; the enabled “Back to edit” control then unmounts and remounts `CheckInCapture`, resetting its sequence to zero while the old request closure remains able to update the persistent flow. A new pass lookup in the remounted capture therefore has an independent sequence: if pass B resolves and then the older pass A resolves, both compare as current in their own refs and A overwrites B. The unit harness has only one `latestSeq` closure and cannot reproduce the route remount. There is a second same-mount hole at line 129: a newer wrong-site QR returns before incrementing the sequence, so it does not supersede an older in-flight lookup.

**Consequence:** after explicitly scanning a newer pass, the attendant can see and redeem an older guest's pass, associating the vehicle/session with the wrong host and leaving the intended pass active.

**Correction:** move the monotonically increasing lookup generation (and optional abort controller) into `Flow`, so it survives child-route remounts; invalidate the previous generation at the start of every non-empty scan before local wrong-site rejection, and clear pending state for a current local rejection. Add a regression that starts A, navigates Confirm → edit, starts B in the remounted capture, resolves B then A, and proves B remains attached; also prove a newer wrong-site scan invalidates A. A rendered test should assert the eventual submit calls only `/v1/passes/redeem` with B.

## Medium — criterion 1: resident Share and the guest QR are still unverified in a rendered browser

**Location:** `apps/web/src/screens/Resident.tsx:156-174`; `apps/web/src/App.tsx:64`; `apps/web/src/screens/GuestPass.tsx:24-45`; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

The source has file-share, text-share, clipboard/download, and public guest-page branches, but this iteration again ran no component or browser path. Pure helper tests do not establish that the actual button calls each reachable capability branch, that a deployed direct `/pass#t=…` navigation serves and renders the SPA, or that the rendered QR scans through lookup/redeem.

**Correction/verification:** add and run rendered/browser coverage for file-capable Web Share, text-only Web Share, and no-Share fallbacks; inspect the emitted shared/copied artifact, open its guest URL directly, decode/scan the rendered QR, and complete lookup/redeem. Record browser and mobile viewport.

## Medium — criterion 2/accessibility: prepopulate, focus, edit, and redemption remain unverified in context

**Location:** `apps/web/src/screens/Attendant.tsx:119-150,182-212,253-328`; `apps/web/test/attendant-flow.test.ts:7-119`; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

The recorded tests exercise extracted state helpers, not React, routing, focus, or network submission. No executed UI path proves that a signed hinted pass fills the visible editable plate field, focuses/announces the accepted banner, survives edit/remove/replace, redeems rather than opening a walk-in, and persists the correct plate/pass association.

**Correction/verification:** add and run a component/browser integration story covering those observations and the lifecycle race above, then assert the persisted session and pass association.

## Medium — criteria 3/4: camera-to-field behavior still lacks check-in and checkout execution

**Location:** `apps/web/src/screens/Attendant.tsx:153-175,203,428-430`; `e2e/live-plate.mjs:9-22`; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

The fake-camera story was explicitly not run. The existing story covers check-in only, and there is no checkout fake-camera story. Pure decoder/ALPR tests do not execute `getUserMedia`, the React callbacks, controlled plate fields, routing, or checkout matching.

**Correction/verification:** run and record the 390×844 fake-camera check-in story; add and run checkout coverage that opens a session, scans its plate, asserts the checkout plate field and correct match without manual entry, and records browser, fixture/model, viewport, and result.

## Medium — criterion 5: the configurable overstay policy editor is still unverified in the UI

**Location:** `apps/web/src/screens/GuestPasses.tsx:23-25,43-53`; `apps/api/test/passes.test.ts:310-340`; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

The new API test resolves the prior server-side gap: a non-default `750000` value reaches all three currency-formatted 12-hour notices and the event while the reminder behavior stays distinct. However, no rendered execution edits the Settings field, saves it through `PATCH /v1/pass-policy`, reloads, and observes the persisted value; the existing unrun guest-pass story only reads the MXN default.

**Correction/verification:** add and run a browser test as an authorized administrator that changes the amount, saves, reloads, and confirms the same major-unit value; also verify a role without `settings.edit` cannot edit/save it.

## Medium — criteria 6/7 and responsive authorization: Admin CRUD and Super Admin cross-property operations remain unverified

**Location:** `e2e/crud.mjs:11-92`; `e2e/people-roles.mjs:17-88`; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

The relevant browser stories were again not run. They remain desktop-only; the Super Admin story switches property but performs no edit/delete there, and no rendered test proves a regular administrator cannot read or mutate the second property.

**Correction/verification:** run the existing stories; add representative person/site/unit/slot CRUD at a narrow mobile viewport, perform edit/delete after a Super Admin switches to a second property, and assert a regular administrator receives a denial for that property's read and mutation paths.

## Low — accessibility: manual assistive-technology and visual checks remain outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, and Admin/Super Admin screens; `.agents/reviews/LOOP-SUMMARY.md:224-233`.

Automated source and CSS checks cannot establish full WCAG conformance, and no manual evidence was supplied.

**Verification:** record keyboard-only and VoiceOver/Safari behavior, focus order/live announcements, 200%/400% zoom and 320px reflow, light/dark contrast, and touch-target checks with versions and any failures.
