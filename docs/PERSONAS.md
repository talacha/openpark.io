# OpenPark personas and journeys

Who uses OpenPark, how each person maps to the code, and the journeys available to them. This is the
product lens over the vocabulary in [docs/DOMAIN.md](./DOMAIN.md); where the two overlap, the words
agree. Access is defined by `can()` in `apps/api/src/auth.ts`; the menu and route guards
(`apps/web/src/menu.ts`, `apps/web/src/App.tsx`) show a subset of what a person may do.

## Personas

A **User** (`app_user` + `membership`) is a registered account with access to one or more units in one
or more communities. A user holds one or more cumulative **roles** in a community, least to most
access: **Resident → Attendant → Supervisor → Admin**. **Super Admin** is not a role but a
platform-wide flag on the account. A user can hold several roles; their permissions are the union.
Users can self-sign up, but an admin or super admin verifies the unit access before a resident is
considered verified (only a verified resident may issue passes).

| Persona | Who they are | Code mapping | Primary journeys |
| --- | --- | --- | --- |
| **Resident** | Lives in the community and issues guest parking passes for a unit they belong to. | `membership.roles` contains `resident`, plus a **verified** unit (`membership.unit_verified`); only a verified resident may issue passes. | Edit profile · Issue new parking pass · Share pass · Previous passes |
| **Operator / Parking Attendant** | Works the gate: checks cars in and out, takes payment, scans plates and QR codes. | `membership.roles` contains `attendant`. | Attendant home (capacity bar, recent activity) · Check in · Check out · Queue |
| **Supervisor** | Everything an Attendant does, plus fee overrides, voids and the monitoring console; is alerted when a car overstays. | `membership.roles` contains `supervisor`. | All Attendant journeys · Occupancy dashboard · Stays · Slots · Guest passes · Overstay alerts |
| **Admin** | Configures a single property: communities, slots, units, users, rates, integrations and AI. | `membership.roles` contains `admin`. | Communities (Sites/Zones/Slots) · Units · Users · Bulk import / export · Advanced (Rates, Integrations, AI) |
| **Super Admin** | A platform-wide operator who can act in any property and switch between them. Never a membership role. | `app_user.is_superadmin` flag. | Platform (property list + switcher) · any property's journeys · place users in any property's units |

## Journeys by persona

Routes are those in `apps/web/src/App.tsx`; the leading `/t/:slug` is the current property's slug.

### Resident — `/t/:slug/r`

The single Resident home screen; an admin or super admin may open it to see what residents see
(`hasResidentView` in `menu.ts`), though a verified unit is needed to issue a pass.

- **Edit profile** — name, phone, and opt-in to guest check-in/check-out notifications.
- **Issue new parking pass** — the "New Guest Parking Pass" section; one active pass per unit.
- **Share pass** — share the pass QR / link with the guest.
- **Previous passes** — passes issued for the unit, including those issued by an attendant linked to
  the unit, not only by the resident.

Permission: `pass.own`.

### Operator / Parking Attendant — `/t/:slug/a`

- **Attendant home** (`/a`) — side-by-side Check In / Check Out, live free count and capacity bar,
  collapsible recent activity.
- **Check in** (`/a/checkin`) — Camera / Manual Entry; plate or QR scan prefills the confirm form
  (`/a/checkin/confirm`), low-confidence reads go to review (`/a/checkin/review`).
- **Check out** (`/a/checkout`) — Camera / Manual Entry; scan a plate or QR to confirm the vehicle is
  leaving.
- **Queue** (`/queue`) — shared staff screen for check-in-by-link.

Permissions: `checkin`, `checkout`, `payment`, `slot.status`, `pass.redeem`.

### Supervisor — Attendant journeys plus the Platform view

- Everything an Attendant can do, plus:
- **Occupancy dashboard** (`/dashboard`), **Stays** (`/sessions`), **Slots** (`/slots`),
  **Guest passes** (`/passes`).
- **Overstay alerts** — notified per property when a guest car passes the policy thresholds. The
  thresholds are **policy-derived**, not fixed: reminders fire at `policy.reminderHours` and the
  overstay at `policy.maxStayHours` (10 h / 11 h / 12 h are only the shipped defaults). The 12 h
  overstay message states the configured charge, currency-formatted from
  `tenant.settings.passPolicy.overstayCharge`, never a literal.

Additional permissions over Attendant: `fee.override`, `session.void`, `pass.admin`.

### Admin — property configuration

- **Communities → Sites / Zones / Slots** (`/parking`) — the estate structure.
- **Units** (`/units`) — homes in the community; residents belong to a unit.
- **Users** (`/users`) — accounts and their roles; an admin verifies a resident's unit before the
  resident can issue passes.
- **Bulk import / export** (`/bulk`) — one screen with entity tabs **Sites · Slots · Units · Users**;
  for each tab: export JSON, paste or upload, validate, review the diff, apply, roll back. (The legacy
  per-entity routes `/inventory` and the `/units` export still exist but are not the Admin journey.)
- **Advanced** — Rate plans (`/rates`), Integrations (`/integrations`), AI plate reading (`/ai`).
- There is **no** Localization route: locales are controlled in code (see the note below).

Permissions: everything except `tenant.delete`.

### Super Admin — `/platform`

- **Platform** (`/platform`) — list every property and switch between them; *Enter* opens any
  property and all of its journeys.
- Place users in any property, choosing the property and one of its units.

Super Admin bypasses every permission check (`can()` returns true for any permission).

## Vocabulary and locales

The surfaced vocabulary is **Community** (a collection of houses or units), **Slot** (a parking
space, with level and status), **Unit** (a home) and **User** (an account with access to one or more
units). The surfaced locales are **es-MX (default)** and **English**; localization is controlled in
code, not as an Admin screen. Docs and product use these words and these two locales so the two agree.
