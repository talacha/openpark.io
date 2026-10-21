# Review iteration 05 — issues only

Evidence scope: independently reviewed the plan, iteration-5 commits `be40389`/`295f6ad`, prior findings, changed code/tests, and affected pass, camera, policy, authorization, and browser-story paths. I used the recorded green full gate in `LOOP-SUMMARY.md:288-294` and did not rerun suites. Publication bookkeeping is consistent: the worktree is clean; `adversarial-loop`, the user checkout's `main`, and `origin/main` are all `295f6ad`; the iteration-5 summary records the gate and pushed tick SHA. The new persistent `Flow.passSeq` fixes the prior counter-remount and wrong-site supersession defect, but the following blockers remain.

## High — criteria 2/3: live-camera navigation can hide a failed pass lookup and enable an unmarked walk-in

**Location:** `apps/web/src/components/LiveCamera.tsx:51-56`; `apps/web/src/alpr/live.ts:25-30`; `apps/web/src/screens/Attendant.tsx:129-176,218,287-292,339-342`.

`LiveCamera` invokes `onQr` and then continues the same frame's plate read; the stabilizer can invoke `onPlate` while `usePass()` is awaiting the server. `onPlate` writes the plate and navigates away from `CheckInCapture`. The pending flag persists in `Flow`, but the rejection text does not: `passErr` is local to the now-unmounted capture component. If lookup later returns invalid/expired/wrong-site, `applyPassError` clears `flow.passPending` and `setPassErr` has no visible target. Confirm now has a plate, no pass, no error, and enables its button; its no-pass branch writes `/v1/sessions`.

**Consequence:** an attendant who scanned an invalid pass can unknowingly submit an ordinary walk-in rather than seeing and verifying the rejection. The scanned-pass workflow is silently bypassed and the stay can be treated incorrectly.

**Correction:** prevent plate navigation while pass verification is pending, or persist lookup outcome/error in `Flow` and surface it on Review/Confirm. A rejected scan must remain visible and require an explicit return/acknowledgment before a walk-in can be submitted. Add a rendered deferred-lookup regression where QR and plate callbacks race, rejection lands after navigation, and no `/v1/sessions` request is possible until the rejection is handled.

## Medium — criterion 1: a rejected clipboard operation prevents the QR fallback, and Share remains unverified in a browser

**Location:** `apps/web/src/screens/Resident.tsx:147-178`; `apps/web/src/App.tsx:64`; `apps/web/src/screens/GuestPass.tsx:19-45`; `apps/web/test/pass.test.ts:20-76`; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

The no-Web-Share fallback awaits `navigator.clipboard.writeText()` before it creates/clicks the QR download anchor. When Clipboard exists but rejects (permission policy, denied permission, or `NotAllowedError`), control jumps to the outer catch and the QR is never downloaded. The pure `planPassShare` tests cannot exercise that failure or the actual button. Recorded evidence also says the browser stories were not run, so file share, text share, emitted artifact, direct `/pass#t=…` navigation, rendered QR decoding, and lookup/redeem remain unverified in context.

**Consequence:** a reachable desktop/browser-policy branch reports failure and gives the resident nothing to send.

**Correction:** catch clipboard failure separately and always provide the QR download with honest status. Add rendered coverage for file-share, text-share, clipboard success/rejection, and download-only branches; then open the emitted guest URL directly at a mobile viewport, decode/scan its QR, complete lookup/redeem, and record browser/viewport.

## Medium — criterion 1: the required verify-code tamper-rejection branch has no execution evidence

**Location:** `apps/api/src/services/passes.ts:232-247`; `apps/api/test/passes.test.ts:146-155`.

The server contains a constant-time comparison against stored `verify_code`, but no recorded test reaches it. Current forged-token and edited-version cases invalidate the HMAC first; they prove signature rejection, not rejection of a still-valid signed token whose code no longer matches the database. The acceptance prompt explicitly requires HMAC **and** verify-code tamper rejection to be verified by execution, so source inspection alone is insufficient.

**Correction/verification:** add an API/service regression that issues a valid token, changes only stored `verify_code` without changing `qr_version` (or otherwise creates a valid-signature/stored-code mismatch), and proves lookup/redeem returns `pass_invalid`; retain the existing HMAC tamper assertions.

## Medium — criterion 2/accessibility: prepopulate, focus, edit, and redemption are still not executed in the real screen

**Location:** `apps/web/src/screens/Attendant.tsx:126-164,199-226,279-342`; `apps/web/test/attendant-flow.test.ts:6-151`; `apps/web/test/flow-remount.test.tsx:12-43`; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

The new executed-React test mounts only `Flow` and a counter probe. No component/browser path proves that a signed hinted pass fills the visible editable plate field, focuses and announces the accepted identity, survives edit/remove/replace, and submits `/v1/passes/redeem` with the persisted pass/plate association. The recorded evidence explicitly says these browser paths were not run.

**Correction/verification:** add and run a rendered integration/browser story for hinted and no-hint passes, focus/live announcement, edit/remove/replace, and final redemption; assert the resulting session is associated with the intended pass and edited plate.

## Medium — criteria 3/4: camera-to-field behavior still lacks check-in and checkout execution

**Location:** `apps/web/src/screens/Attendant.tsx:168-190,218,443-445`; `e2e/live-plate.mjs:9-22`; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

The existing fake-camera story covers only check-in and was not run; no checkout fake-camera story exists. Decoder/ALPR tests do not execute `getUserMedia`, the React callbacks, controlled plate fields, routing, or checkout matching.

**Correction/verification:** run and record the 390×844 fake-camera check-in story; add and run checkout coverage that opens a session, scans its plate, asserts the checkout plate field and correct match without manual entry, and records browser, fixture/model, viewport, and result.

## Medium — criterion 5/authorization/UX: supervisors are shown a policy editor the API forbids, and UI persistence remains unverified

**Location:** `apps/web/src/screens/GuestPasses.tsx:15-25,38-53`; `apps/web/src/app-context.tsx:113`; `apps/api/src/auth.ts:19-24`; `apps/api/src/routes/passes.ts:74-91`; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

`GuestPasses` enables policy fields and Save with `can('override')`. The client maps that to supervisors and admins, while the server deliberately omits `settings.edit` from supervisors and protects `PATCH /v1/pass-policy` with that permission. A supervisor therefore gets an apparently editable form whose save always fails. No rendered test changes the amount as an administrator, saves, reloads, and observes persistence; the existing unrun guest-pass story only reads the default.

**Consequence:** the Settings UI misrepresents authorization, and end-to-end editability of the required per-tenant policy is not established.

**Correction:** gate editing on the exact settings/admin capability (for example `me.superadmin || me.roles.includes('admin')`, or expose `settings.edit` accurately), keep supervisor controls disabled/absent, and add a browser test proving admin save/reload persistence plus supervisor denial/no PATCH attempt.

## Medium — criteria 6/7 and responsive authorization: Admin CRUD and Super Admin cross-property operations remain unverified

**Location:** `e2e/crud.mjs:11-117`; `e2e/people-roles.mjs:17-88`; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

The relevant browser stories were explicitly not run. The CRUD story is desktop-only; the Super Admin story switches property but performs no edit/delete there; and no rendered test proves a regular administrator cannot read or mutate the second property.

**Correction/verification:** run the existing stories; add representative person/site/unit/slot CRUD at a narrow mobile viewport, perform edit/delete after a Super Admin switches to a second property, and assert a regular administrator is denied that property's reads and mutations.

## Low — accessibility: manual assistive-technology and visual checks remain outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, and Admin/Super Admin screens; `.agents/reviews/LOOP-SUMMARY.md:277-287`.

Automated source, unit, and CSS checks cannot establish full WCAG conformance, and no manual evidence was supplied.

**Verification:** record keyboard-only and VoiceOver/Safari behavior, focus order/live announcements, 200%/400% zoom and 320px reflow, light/dark contrast, and touch-target checks with versions and any failures.
