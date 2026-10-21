# EPD feedback implementation across resident, attendant, navigation, and admin flows

The branch adds the requested personas, collapsible navigation, resident profile/pass work, attendant flows, unit verification, bulk administration, and two-locale surface. The verified-unit gate is enforced in `createPass`, occupancy additions retain site scoping, the QR decoder stays lazy, locale parity is recorded green, and the OPP2 signing/revalidation path is unchanged. Acceptance-critical failures remain in consent persistence, keyboard access, QR-to-confirm navigation, admin terminology, and bulk data restoration. Recorded build/test/CSS gates are green, but no real-browser mobile/camera evidence was recorded.

Watch for: **[confirmed, high]** bulk rollback deletes or fails to restore pre-import data; **[confirmed, high]** “Communities” bulk operations actually mutate Sites; **[confirmed, high]** profile editing silently re-enables guest notifications; **[confirmed, high]** resident disclosures and collapsed-menu controls regress keyboard access; **[confirmed, medium]** successful pass scans do not advance to confirmation.

**Verdict**: NEEDS_CHANGES

## High-level view

**[confirmed]** Resident consent is write-only in the UI and defaults to enabled whenever the editor mounts. The pass disclosures are removed from the tab order, and query/hash deep-link state is sampled only on mount, so keyboard use and already-mounted sidebar navigation both fail.

**[confirmed]** The attendant flow correctly persists pending/rejected pass state, but a valid QR only changes the capture tab when it has a plate hint and never routes to confirmation. “Other” authorizers can also be left incomplete while Confirm remains enabled, dropping the requested host attribution.

**[confirmed]** User rollback deletes invitations by uploaded email without knowing which rows the job created, while Site rollback cannot restore slots or unit associations retired by replace mode. The Bulk UI separately labels that Site pipeline “Communities,” contradicting the documented `Community = tenant` model.

**[confirmed]** The server-derived verification gate, HMAC-signed OPP2 token, configured/currency-formatted overstay amount, MXN-only `500000` default inherited from `main`, and announcement-only policy remain intact. New upload/preview writes do not all use replay protection, and the recorded evidence does not exercise the changed surface in a real 390px browser or through the shipped camera/model path.

<details>
<summary>Issues (12)</summary>

1. **[high, confirmed] Non-restorative bulk rollback** — User rollback can delete pre-existing invitations, and Site rollback cannot restore retired slots, detached units, or cleared notes. Snapshot exact before-state and restore only job-owned changes; add changed/pre-existing-row rollback tests and confirm the destructive UI action.
2. **[high, confirmed] “Communities” mutates Sites** — The Communities tab calls `/v1/sites/*`, so replace mode can retire parking facilities while never importing the tenant/community entity. Implement Community-level bulk operations or relabel Sites and explicitly complete the unmet Community requirement.
3. **[high, confirmed] Notification opt-out resets to enabled** — `/v1/me` omits `notify_guest_events`, while the editor initializes `true` and always submits it. Return and rehydrate the preference so unrelated profile edits cannot re-enable notifications.
4. **[high, confirmed] Keyboard-inaccessible controls** — Resident disclosure buttons are removed from tab order; collapsed-menu selects/sign-out remain focusable while visually clipped; new tab widgets expose incomplete tab semantics. Restore visible keyboard traversal and implement the full ARIA tabs pattern or use ordinary button groups.
5. **[medium, confirmed] Resident deep links only work on mount** — `?edit=1` and `#new` seed state once, so same-route sidebar navigation does not open/focus the requested section. Synchronize state to router location and test in-place navigation both ways.
6. **[medium, confirmed] QR scan stops before confirmation** — A valid pass lookup never navigates to `/checkin/confirm`; hinted passes only expose the capture keypad and no-hint passes remain on Camera. Route every successful scan to the prefilled confirmation form and test both token shapes.
7. **[medium, confirmed] “Other” host can be omitted** — Partial Other details produce `host: undefined`, and confirmation remains enabled because host state is not validated. Require a selected unit or complete name plus E.164 phone before submission.
8. **[medium, confirmed] User terminology remains People/Person** — UI catalogs and newly written docs still surface People/Person despite AC-5.1.3 requiring User. Update source-of-truth vocabulary and all user-facing labels.
9. **[medium, confirmed] Persona bulk route is stale** — `docs/PERSONAS.md` points admins to `/inventory` plus units export instead of the new `/bulk` route and its four tabs. Correct the journey map and mark legacy routes explicitly if retained.
10. **[medium, confirmed] New writes bypass replay protection** — Avatar upload and Site/User preview-job creation do not declare `idempotent`/`replaySafe`; Bulk uses raw requests without stable submission keys. Add payload-scoped keys and server replay handling for every new mutation.
11. **[low, confirmed] Avatar MIME changes orphan objects** — The key extension changes across PNG/JPEG/WebP uploads and the previous object is never deleted. Safely delete the superseded key after the new reference commits.
12. **[medium, confirmed] Mobile/camera evidence is absent** — FEAT records contain green automated gates but no real-browser 390px, keyboard/AT, or shipped getUserMedia/ONNX checkout run; no `e2e/` file was extended. Record the specified browser stories and manual accessibility checks.

</details>

<details><summary>Details</summary>

## Resident consent and navigation state do not round-trip

**[high, confirmed]** `PATCH /v1/me/profile` persists `app_user.notify_guest_events`, and notifications consume it, but `GET /v1/me` neither selects nor returns it (`apps/api/src/routes/auth.ts:73-83`). `EditProfile` initializes `notify` to `true` and always submits that value (`apps/web/src/screens/Resident.tsx:227-243`). An opted-out resident therefore sees a checked toggle and re-enables alerts by editing only their name, phone, or avatar. Return `notifyGuestEvents`, initialize from it, and cover false→reload→unrelated-edit.

**[high, confirmed]** Both closed Resident disclosure buttons use `tabIndex={-1}` (`Resident.tsx:46-53`), making issue-pass and history content unreachable by sequential keyboard navigation. Keep the button tabbable; use a separate programmatic fallback target if deep-link focus needs `tabIndex={-1}`.

**[medium, confirmed]** `wantEdit` and `wantNew` become `useState` initial values only (`Resident.tsx:85-90`). React Router retains `ResidentHome` when only search/hash changes, so sidebar child links used while already on `/r` never update `editing` or `newOpen`; tests only mount directly at the destination. Synchronize to router location, preserve edit-over-new precedence, focus the profile form, and test same-component navigation.

## Collapsed navigation creates invisible focus stops

**[high, confirmed]** `menu-label` is added directly to property/site/locale selects and Sign out (`apps/web/src/components/AppMenu.tsx:58-103`), then collapsed CSS clips every `.menu-label` to 1×1 without removing controls from focus order (`apps/web/src/styles.css:51-56`). Keyboard users tab through invisible controls with no visible focus; existing tests only click and inspect attributes. Remove hidden controls from focus order or provide visible icon equivalents and test actual traversal.

**[high, confirmed]** Attendant and Bulk widgets declare `role="tab"` without `tabpanel`, `aria-controls`, roving focus, or Left/Right handling (`Attendant.tsx:35-42`, `Bulk.tsx:29-34`). Implement the ARIA tabs pattern or expose ordinary buttons instead of unsupported semantics.

## QR and host capture do not reach the required confirmed state

**[medium, confirmed]** A successful pass lookup applies state and calls `setCamera(false)` only for `q?.plate`; it never navigates to `/checkin/confirm` (`apps/web/src/screens/Attendant.tsx:286-300`). Hinted QR scans stop at the capture keypad and no-hint scans remain on Camera, contradicting AC-4.2.2 and `docs/PERSONAS.md`. Navigate every valid scan to confirmation, prefill verified values, manage focus, and test hinted/no-hint transitions.

**[medium, confirmed]** `HostControl` emits `null` with partial Other fields, its inputs are not required, and `canConfirm` ignores host (`Attendant.tsx:414-470,500-596`). Confirm serializes `host: undefined`, which the optional API contract accepts. Make a unit or complete Other identity mandatory in both UI validity and server validation.

## Bulk rollback cannot restore the state it changes

**[high, confirmed]** User rollback deletes `membership_invite` for every email in the uploaded document (`apps/api/src/routes/people.ts:331-345`) without storing whether the invite predated the job. An unchanged prior invite is deleted; a changed invite is deleted instead of regaining its roles, unit, super-admin, and verification fields. Persist before-state plus applied-row identities and restore only job changes.

**[high, confirmed]** Site replace retires omitted sites and all their slots, then nulls linked units (`apps/api/src/services/sites.ts:98-103`). Its `exportSites` snapshot contains only active site scalars, so rollback can revive a site but not its slots or unit links. `jsonb_strip_nulls` also prevents null/absent notes from clearing an imported note (`sites.ts:90-95,110-119`). Snapshot dependent state and nullable settings, restore them transactionally, and cover retirement rollback. The danger rollback button also needs confirmation (`apps/web/src/screens/Bulk.tsx:114-116`).

## Admin vocabulary and routes contradict the implemented resources

**[high, confirmed]** Community is defined as `tenant`, with Site beneath it (`docs/DOMAIN.md:10-12`; design D1), but Bulk’s “Communities” tab uses `/v1/sites/export` and `/v1/sites/import` and downloads `communities.json` (`apps/web/src/screens/Bulk.tsx:8-18`). It cannot carry community name/address/notes/identity, and replace mode retires Sites. Align label, API resource, and acceptance semantics before enabling replace.

**[medium, confirmed]** `nav.users` and `users.title` remain People/equivalents, while the new domain/persona docs define Person and People (`docs/DOMAIN.md:15-17,65-67,87-101`; `docs/PERSONAS.md:3-12`). This misses the explicit User terminology change across UI and docs.

**[medium, confirmed]** The new persona document maps Admin bulk work to `/inventory` plus units export (`docs/PERSONAS.md:69-72`), while this branch adds `/bulk` with Communities/Slots/Units/Users tabs. Update the route-level journey and distinguish intentionally retained legacy routes.

## Replay and object lifecycle gaps remain on new writes

**[medium, confirmed]** `POST /v1/me/avatar`, `/v1/sites/import`, and `/v1/users/import` do not declare `idempotent` or `replaySafe` (`routes/people.ts:80-98,303-315`; `routes/slots.ts:260-274`). Bulk preview uses raw `request` without a stable key (`apps/web/src/screens/Bulk.tsx:57-72`), so retries create duplicate jobs/audit work. Use submission-scoped payload fingerprints and replay handling on every new mutation.

**[low, confirmed]** Avatar keys include the MIME-derived extension, but replacement never deletes the prior key (`routes/people.ts:89-97`). Changing image format grows orphaned storage despite the one-object-per-user design; delete the superseded object only after safely committing the new reference.

## Recorded gates omit real mobile and camera behavior

**[medium, confirmed]** FEAT-005 records green core build, seven-project typecheck, API 126, web 125 plus one pre-existing skip, and logical-CSS checks; I did not rerun them. No FEAT records a real-browser ~390px run, keyboard/AT traversal, or shipped `getUserMedia`/ONNX execution. FEAT-004’s design called for checkout extension of the live-plate story, but the branch changes no `e2e/` file. Not tested: narrow reflow/touch, camera acquisition/model loading and cleanup, real collapsed-menu focus order, rendered contrast, and checkout camera behavior.

## Preserved trust and policy boundaries

The branch leaves OPP2 signing/parsing unchanged. `unitVerified` comes from the membership resolver, `createPass` rejects unverified non-`pass.admin` callers, and lookup/redeem rereads persisted pass state instead of trusting token hints. Overstay copy uses `{hours}` and currency-formatted `{amount}` across maintained source catalogs; no billing or collection was added, and the inherited provisioner still defaults only MXN tenants to `500000`.

</details>

<details><summary>File map</summary>

- `apps/api/migrations/018_epd_feedback.sql` — profile, issuer, authorizer, and verification schema/functions.
- `apps/api/src/{http,server,routes,services}` — membership context, profile/avatar, pass gate, attendant queries, and bulk pipelines.
- `apps/web/src/components/{AppMenu,Shell}.tsx`, `menu.ts`, `styles.css` — collapsed navigation and responsive styling.
- `apps/web/src/screens/{Resident,Attendant,Bulk,Parking,People,Slots,Settings}.tsx`, `attendant-flow.ts`, `App.tsx` — resident, operator, and admin behaviors.
- `apps/web/src/i18n.tsx`, `apps/web/src/locales/*.json` — surfaced locale folding and catalog updates.
- `apps/api/test/*`, `apps/web/test/*` — recorded API, state, and rendered regression coverage.
- `ARCHITECTURE.md`, `docs/{DOMAIN,PERSONAS}.md`, `.agents/tasks/task-epd-feedback/features/*.json` — product documentation and verification records.

Full diff: `git diff main...epd-feedback`

</details>
