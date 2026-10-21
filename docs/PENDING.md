# Pending work (requested by the owner)

Status key: [x] done, [~] in progress, [x] not started. Updated as work lands.

## 1. Roles
- [x] API: multiple roles per member (`membership.roles`), permissions are the union; Super Admin is a platform flag. Migration 009.
- [x] API: supervisors notified per property when a car passes 10, 11 and 12 hours (`stay_alert`, cron).
- [x] API tests updated and green (82).
- [x] Web: role checkboxes instead of a dropdown, ordered Resident, Attendant, Supervisor, Admin, Super Admin, each with its description; Super Admin checkbox only for Super Admins.
- [x] Web: menu, route guards and `can()` work from a roles array.
- [x] Web: property toggle in the menu for Super Admins listing ALL properties.
- [x] Web: Super Admins (and admins) get Edit next to Remove on members; edit roles and assign a unit from the property. Buttons hidden without `users.edit`.
- [x] API: edit / withdraw pending invitations (`PATCH|DELETE /v1/invites/:email`).
- [x] Web: Edit and Delete on pending invitations (e.g. demo@openpark.io), Super Admin and admins only.

## 2. Guest pass QR
- [x] API: QR v2 `OPP2|…` with random verification code and every field needed to check a car in.
- [x] Web: fix QR generation (quiet zone, size, crisp), show the verification code under the QR.
- [x] Web: fix QR scanning (BarcodeDetector + jsQR fallback), parse OPP2 client-side to prefill check-in.
- [x] Camera auto-submits on a valid QR or a valid plate.

## 3. Plate scanner
- [x] In-browser reader (onnxruntime-web, models cached for offline garages), replaces "No ALPR worker is configured".
- [x] Live camera loop with multi-frame voting and auto-submit at check-in and check-out.

## 4. Review fixes
- [x] Translate API error codes and fee-line / timeline labels; "Body" label and options; keypad aria-labels.
- [x] Persist UI language to the profile; resident phone editing; label hidden file inputs.
- [x] Re-run e2e audit scripts and fix what they find.

## 5. Ship
- [x] Full test run (core, API, web, marketing, SDK, Python) and e2e.
- [x] Apply migrations 008, 009, 010 to Supabase; run advisors.
- [x] Commit (r@rob.cr) and push; verify the three Vercel deployments live.
- [ ] Verify the live deployment (after the push).
