# Review iteration 01 — issues only

Evidence scope: reviewed `d7b3ee3..0769e61`, the plan, changed callers/guards, relevant API/UI tests, the recorded green gate in `LOOP-SUMMARY.md`, and the published refs (`main`, `adversarial-loop`, and `origin/main` all at `0769e61`). The recorded full suites were not rerun.

## High — criterion 1: two supported fallback branches do not share a usable QR

**Location:** `apps/web/src/screens/Resident.tsx:159-166`; `apps/web/src/locales/en.json:210-211` and equivalent locale entries; `apps/web/test/pass.test.ts:20-49`.

When `navigator.share` exists but file sharing is unsupported, line 160 shares only `{title, text}`. That text contains guest/property/unit/verification-code metadata but neither the QR token nor a link that can render the QR, despite telling the guest to “Show this QR.” The verification code alone cannot be used by the attendant: `Attendant.tsx:115-121` sends the entered value as the signed token to `/v1/passes/lookup`. When Web Share is absent, the code only downloads an image locally; it does not send it, and if `navigator.clipboard.writeText` is absent it still reports that the message was copied. Thus a resident can complete the Share action on reachable browsers while the guest receives no usable pass. The added tests exercise only pure image/message helpers and never these browser branches.

**Correction:** ensure every branch gives the guest a usable QR, preferably by sharing/copying a guest-view URL that carries the short-lived signed token in the URL fragment and renders the QR client-side, while retaining file sharing where supported. At minimum, do not claim a copy occurred when Clipboard API is unavailable and make any download/manual-attach fallback explicit. Add a browser/component test that mocks (1) file-capable Web Share, (2) text-only Web Share, and (3) no Share/Clipboard API, and proves the resulting guest artifact can be scanned/redeemed.

## High — criterion 2 / data correctness: removing or replacing a hinted pass leaves its plate in the next check-in

**Location:** `apps/web/src/screens/Attendant.tsx:124-130,167,192`; `apps/web/test/pass.test.ts:45-49`.

`usePass()` updates `flow.plate` only when the newly scanned pass has a non-empty hint. The Remove action clears only `pass`. A reachable sequence—scan pass A with `ABC123`, remove it, then continue a normal check-in or scan pass B with no hint—leaves `ABC123` in `flow.plate`; the enabled Next/Confirm path can submit that stale plate, including redeeming pass B against pass A’s vehicle. The pure helper test does not exercise this state transition.

**Correction:** make pass selection/removal update the entire pass-derived state atomically. A newly accepted pass with no hint must clear a prior pass-derived plate/candidates/read metadata, and removing a pass must clear values sourced from it (track provenance if independently captured/manual values should survive). Add a UI/reducer integration test for hinted pass → remove → ordinary check-in and hinted pass → remove → no-hint pass, asserting the field/request cannot retain the old plate.

## Medium — criterion 2 / accessibility: successful scanning neither exposes the prefilled form nor manages/announces focus

**Location:** `apps/web/src/screens/Attendant.tsx:108-130,160-179`; `apps/web/test/pass.test.ts:45-49`.

On success, the scanner is unmounted by `setScanning(false)`, but focus is not moved and the replacement pass banner has no status/live semantics. With AI enabled, the code stays on the camera view, so the prefilled plate field is not visible until the attendant discovers and activates the Keypad toggle; the confirm screen itself displays the plate but does not provide an edit control. No recorded browser test checks that a scan visibly prepopulates an editable field, that the attendant can verify it, or that keyboard/screen-reader focus lands on the result. This does not establish the required in-context prepopulate/verify/submit flow.

**Correction:** after lookup, reveal or navigate to a clearly labeled editable prefilled plate control, announce the accepted pass, and deliberately focus the result/control without trapping focus. Add and record a browser test that scans/enters a signed pass with a plate hint, asserts the labeled plate input value, edits it, confirms, and verifies the submitted plate/pass association; include keyboard focus assertions.

## Medium — criteria 3 and 4: no recorded execution verifies camera-to-field behavior in both flows

**Location:** `apps/web/src/components/LiveCamera.tsx:34-60`; `apps/web/src/screens/Attendant.tsx:134-145,406-408`; `apps/web/test/alpr.test.ts:31-48`; `e2e/live-plate.mjs:1-21`; `.agents/reviews/LOOP-SUMMARY.md:45-51`.

The recorded gate covers pure ALPR/decoder tests, not `getUserMedia` plus the React callbacks. The existing fake-camera E2E covers check-in only and was not recorded as run this iteration; there is no equivalent checkout camera E2E. Source inspection shows plausible callbacks, but the review mandate forbids accepting these user requirements from source alone.

**Correction/verification:** run and record the existing fake-camera check-in story, and add/run a fake-camera checkout story that opens an actual session, scans its plate, asserts the checkout plate field receives the read, and reaches the correct review without manual plate entry. Record browser/device, viewport, model fixture, and results in the next loop summary.

## Medium — criterion 5: supervisor notification at the 10h/11h thresholds lacks execution coverage

**Location:** `apps/api/src/routes/misc.ts:139`; `apps/api/src/services/passes.ts:484-505`; `apps/api/test/passes.test.ts:31,257-288`.

The cron route calls `processStayAlerts()`, but no test invokes that function or the combined cron route. The existing reminder test’s `runCron()` calls only `processPassReminders()`: it proves guest reminders at 10h/11h and supervisor delivery at 12h, not the requirement that supervisors are notified once a vehicle exceeds 10h. This is a required behavior with only source-level evidence.

**Correction/verification:** add an integration test through authenticated `/v1/cron/pass-reminders` (or directly through the combined job orchestration) that advances an open stay to 10h and 11h, observes the supervisor recipient and threshold text, proves idempotency, and confirms the 12h pass path is not duplicated. Keep the existing guest reminder assertions unchanged.

## Medium — criteria 6 and 7 / UX: user-facing CRUD and cross-property operation were not exercised in a rendered app

**Location:** `.agents/reviews/LOOP-SUMMARY.md:45-51`; `e2e/crud.mjs`; `e2e/people-roles.mjs`; `e2e/menu.mjs`; `apps/api/test/units-import.test.ts:161-210`; `apps/api/test/identity.test.ts:173-235`.

The green API suite executes the underlying CRUD and super-admin authorization paths, and web unit tests cover menu construction, but the evidence contains no browser run proving an Administrator can complete person/site/unit/slot CRUD through the UI or a Super Admin can switch properties and perform those operations there. Existing Playwright stories are outside the reported gate and were not reported as run. Consequently the user-facing and responsive parts of criteria 6/7 remain unverified in context.

**Correction/verification:** run and record `e2e/crud.mjs`, `e2e/people-roles.mjs`, and `e2e/menu.mjs` at desktop and narrow mobile viewports; extend them where necessary to perform one edit/delete after a Super Admin switches to a second property and to prove a regular property admin cannot cross that boundary.

## Low — accessibility bar: manual AT, reflow, contrast, and touch review remains outstanding

**Location:** touched resident/attendant screens (`apps/web/src/screens/Resident.tsx`, `apps/web/src/screens/Attendant.tsx`) and the admin forms reviewed above; `.agents/tasks/plan.md:182-190`.

`check:css` verifies logical-direction properties, not WCAG contrast, zoom/reflow, focus order, screen-reader announcements, or touch-target usability. No manual assistive-technology or expert accessibility result was recorded. Full WCAG conformance therefore cannot be claimed from this automated review.

**Verification:** after the concrete focus/status fix above, manually test current VoiceOver + Safari and keyboard-only operation, 200%/400% zoom and 320px reflow, light/dark contrast, and mobile touch targets; record browser/AT versions and remaining failures rather than claiming blanket conformance.
