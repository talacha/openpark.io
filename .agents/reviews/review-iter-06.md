# Review iteration 06 — issues only

Evidence scope: independently reviewed the approved plan, prior report/verdict, iteration-6 commits `fb4aa39`/`f6b8033`, changed production code and tests, relevant unchanged callers/guards, browser stories, and the recorded verification/publish evidence. I relied on the recorded green full gate in `.agents/reviews/LOOP-SUMMARY.md:362-372` and did not rerun it. The worktree is clean, and `adversarial-loop`, the user checkout's `main`, and `origin/main` all resolve to `f6b8033`; the fast-forward appears in the user checkout reflog. The following acceptance-critical verification blockers remain.

## Medium — criterion 1: Web Share and the public guest QR remain unverified as an end-to-end share artifact

**Location:** `apps/web/src/screens/Resident.tsx:159-180`; `apps/web/src/screens/GuestPass.tsx:20-45`; `apps/web/test/share-pass.test.tsx:59-83`; `apps/web/test/pass.test.ts:68-72`; `.agents/reviews/LOOP-SUMMARY.md:345-353`.

The new executed-React tests establish only the no-Web-Share download path. They do not execute either `navigator.share` branch, inspect the shared file/text/URL payload, render `/pass#t=…`, decode its rendered QR, or complete lookup/redemption. The helper round-trip test proves fragment parsing only. The iteration record explicitly says the full-stack browser path was not run.

**Consequence:** the required resident-to-guest share workflow is still not verified in the browser where Web Share, routing, QR rendering, camera decoding, and redemption interact.

**Correction/verification:** extend the rendered `SharePass` coverage for file-share and text-share success/cancel/failure and assert the payload contains the guest fragment URL. Then run a mobile-viewport browser story that shares or captures that URL, opens it unauthenticated, decodes/scans the rendered QR, and completes `/v1/passes/lookup` plus `/v1/passes/redeem`; record browser and viewport.

## Medium — criterion 2 plus accessibility: scanned-pass prepopulation, rejection handling, edit, and submit remain unverified in the actual screen

**Location:** `apps/web/src/screens/Attendant.tsx:131-166,216-221,286-358`; `apps/web/test/attendant-flow.test.ts:59-151`; `.agents/reviews/LOOP-SUMMARY.md:345-353`.

The regression uses a hand-built state-machine harness rather than mounting `CheckInCapture`/`CheckInConfirm`; it cannot prove that real camera/typed callbacks, routing, focus/live announcements, button disabling, and API branch selection use those transitions correctly. No executed component/browser path shows a hinted pass filling the visible editable plate field and then sending its token and the verified/edited plate to `/v1/passes/redeem`. Likewise, no rendered deferred-lookup test proves a rejection arriving after navigation is displayed and prevents `/v1/sessions` until acknowledgment.

**Consequence:** the acceptance-critical scan → prepopulated form → attendant verification → pass redemption path, including the iteration-6 safety behavior, remains unverified in context.

**Correction/verification:** mount the real routed screens with deferred API responses or add a Playwright story. Cover hinted and no-hint passes, accepted-banner focus/live announcement, edit/remove/replace, the QR/plate rejection race, disabled Confirm before acknowledgment, no walk-in request during that state, and final redemption associated with the intended pass and edited plate.

## Medium — criteria 3 and 4: camera-to-field behavior still has no recorded check-in run and no fake-camera checkout test

**Location:** `apps/web/src/screens/Attendant.tsx:170-179,225-226,459-460`; `e2e/live-plate.mjs:9-22`; `.agents/reviews/LOOP-SUMMARY.md:345-353`.

Source wiring sends camera reads to the check-in flow and checkout field, but the existing 390×844 fake-camera check-in story was not run. Repository search finds no fake-video checkout story; the only checkout browser flow types a ticket manually. Unit ALPR tests do not execute `getUserMedia`, model/fixture decoding, React callbacks, controlled fields, route transitions, or checkout matching.

**Consequence:** both camera acceptance criteria remain unverified in the real responsive UI, and checkout camera scanning has no end-to-end execution evidence at all.

**Correction/verification:** run and record `e2e/live-plate.mjs` with its model/fixture at 390×844. Add and run a fake-camera checkout story that opens a known session, scans its plate, asserts the visible checkout plate field and correct match without manual input, and records browser, viewport, fixture/model, and console result.

## Medium — criterion 5 plus authorization/UX: policy save/reload and supervisor read-only behavior remain unverified in the rendered Settings UI

**Location:** `apps/web/src/app-context.tsx:42-46`; `apps/web/src/screens/GuestPasses.tsx:16-27,36-54`; `apps/web/test/policy-access.test.ts:11-27`; `apps/api/src/routes/passes.ts:74-88`; `.agents/reviews/LOOP-SUMMARY.md:345-353`.

The pure `canEditPassPolicy` test verifies the new role predicate, but it does not mount `GuestPasses`, prove that all controls and Save are disabled/absent for a supervisor, or prove that no PATCH is attempted. No browser test changes the amount as an administrator, saves it, reloads, and observes the persisted per-tenant value. The API policy test does not exercise the Settings UI.

**Consequence:** the required editable per-tenant policy path and its corrected supervisor UX are not established end to end.

**Correction/verification:** add/run a rendered or browser test that changes the overstay amount as an administrator, saves and reloads it, and observes persistence. In a supervisor session assert the inputs are disabled, Save is absent, and no `PATCH /v1/pass-policy` request occurs.

## Medium — criteria 6 and 7 plus responsive authorization: Admin CRUD and Super Admin cross-property operations remain unverified in context

**Location:** `e2e/crud.mjs:11-84`; `e2e/people-roles.mjs:17-83`; `.agents/reviews/LOOP-SUMMARY.md:345-353`.

The iteration record explicitly says these browser stories were not run. The existing CRUD story is desktop-only. The Super Admin story switches to another property but does not edit/delete person, site, unit, or slot there, and no rendered story proves a regular administrator is denied that second property's reads and mutations.

**Consequence:** user-facing CRUD completeness, narrow-mobile usability, Super Admin cross-property mutation, and the regular-admin property boundary are not verified together with the real UI and API.

**Correction/verification:** run the existing stories, add representative person/site/unit/slot create-edit-delete coverage at a narrow mobile viewport, perform representative mutations after a Super Admin switches to a second property, and assert a regular administrator cannot read or mutate that property's entities.

## Low — accessibility: manual assistive-technology and visual checks remain outstanding

**Location:** Resident Share/GuestPass, Attendant pass/camera flows, policy editor, and Admin/Super Admin screens; `.agents/reviews/LOOP-SUMMARY.md:354`.

Automated tests and the logical-CSS check cannot establish full WCAG conformance, and no manual evidence was supplied.

**Verification:** record keyboard-only and VoiceOver/Safari behavior, focus order and live announcements, 200%/400% zoom, 320px reflow, light/dark contrast, and touch-target checks with versions and any failures.
