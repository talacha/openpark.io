# OpenPark domain model

One vocabulary for the product, the screens and the API. Where the database or code uses an older word, the right-hand column says so; the
screens and docs use the **term**. For who uses the product and the journeys each person has, see [docs/PERSONAS.md](./PERSONAS.md).

## Language

| Term | Meaning | Code / table |
| --- | --- | --- |
| **Community** | A collection of houses or units — a housing complex or a car-park operator's estate. The unit of isolation: people, rates and data never cross communities. Has an optional address and optional notes. (Surfaced name for what the schema still calls a *property*.) | `tenant` (settings.address, settings.notes) |
| **Site** | One parking facility of a community (a car park, a gate). Has a time zone, an address and the plate-reading confidence it needs to auto-accept. | `site` |
| **Zone** | A level or area of a site (Basement 1, Visitors). Owns the slot's **level**. | `zone` |
| **Slot** | One parking space in a zone. Has a type (standard, accessible, EV…), a **level** (from its zone), a **status** (operational/available, reserved, out of service — plus the runtime *occupied*, set only by check-out) and a note. Only `available` slots are assignable at the gate. | `slot` |
| **Unit** | A home (apartment, house) in the community. A resident belongs to a unit, not to a slot. Has a code, a name, a floor, a note and optionally a site. | `unit` |
| **User** | A registered account with access to one or more units in one or more communities. Holds one or more **roles**. Users can self-sign up, but an admin or super admin must **verify** a resident's unit grant (`membership.unit_verified`) before it counts: only a verified resident may issue guest passes; staff-placed grants are verified on creation, bulk-imported and self-signup grants await an admin's verify. | `app_user` + `membership` |
| **Role** | Cumulative access, least to most: **Resident**, **Attendant**, **Supervisor**, **Admin**. A person can hold several. | `membership.roles` |
| **Super Admin** | A platform-wide flag on a person: can configure every community and switch between them. Not a role of a community. | `app_user.is_superadmin` |
| **Invitation** | A pending offer of roles (and a unit) to an email address; claimed at first sign-in. May carry Super Admin. | `membership_invite` |
| **Guest pass** | A resident's QR for one visitor, valid for a limited time, one active per unit. Carries a random verification code. | `pass` |
| **Stay** | One visit of a car: check-in to check-out, with its events, fee and payment. | `session`, `session_event` |
| **Vehicle** | A car known by its plate (and body type, make, model, colour). | `vehicle` |
| **Plate read** | One reading of a plate image, on the device or the server, and what the attendant decided. | `plate_read` |
| **Rate plan** | Versioned pricing rules (grace, first period, increments, daily cap, tax). Editing creates a new version; a plan used by a stay is never changed. | `rate_plan` |
| **API key** | A credential for another system, scoped to the community (and optionally one site) with a role. Shown once. | `api_key` |
| **Webhook** | A URL told about events (car checked in/out, slot changed, plate needs review, guest overstay), signed with a secret shown once. | `webhook_endpoint`, `webhook_delivery` |
| **Account, Permit** | A customer and their monthly/reserved parking right. Modelled in the schema, not yet exposed. | `account`, `permit` |
| **Device** | A phone, camera or gate at a site. Modelled, not yet exposed. | `device` |

## Relationships

```
Community ─┬─ Site ─┬─ Zone ── Slot
           │        └─ Stay ── Vehicle        (a stay occupies one slot at one site)
           ├─ Unit ── Guest pass ── Stay        (a pass is redeemed into a stay)
           ├─ User ── (roles, unit)             (Resident ⇒ exactly one unit)
           │      └─ Invitation                 (roles, unit, Super Admin)
           ├─ Rate plan ── Site (default)       (a stay pins the plan version it was priced with)
           └─ API key · Webhook
Super Admin ── any Community
```

Rules the data enforces: a Resident must have a unit; a community keeps at least one Admin; one active guest pass per unit; a retired site or
slot stays as history; a unit with residents, invitations or passes cannot be deleted; a zone with slots cannot be deleted.

## Field types (what the forms use)

| Entity | Field | Type | Control |
| --- | --- | --- | --- |
| Site | code | identifier `[A-Za-z0-9_-]`, immutable | text |
| | name | text ≤ 100 | text |
| | timezone | IANA zone | select |
| | address | text ≤ 300, optional | text |
| | aiThreshold | number 0.5–1 | number, step 0.01 |
| Zone | code / name | identifier / text | text |
| | level | integer −20…200, optional | number, step 1 |
| Slot | code | identifier | text |
| | zone | reference | select |
| | type | one of the community's slot types | select |
| | status | available · reserved · out of service (occupied is set by check-in) | select |
| | note | text ≤ 300 | text |
| Unit | code | identifier, immutable | text |
| | name / note | text ≤ 100 / ≤ 500 | text |
| | site | reference, optional | select |
| | floor | integer −20…300, optional | number, step 1 |
| User | email | email | email |
| | roles | set of Resident, Attendant, Supervisor, Admin (+ Super Admin) | checkboxes |
| | unit | reference, required for Resident | select (or a link to Units when there are none) |
| Rate plan | money | integer minor units | number, step 0.01 |
| | minutes | integer | number |
| Guest pass | guest phone | E.164 | tel |
| | guest email | email | email |
| Settings | plate regions | set of registry regions | checkboxes |
| | retention | integer days | number |
| Webhook | url | URL | url |
| | events | set of five event names | checkboxes |
| API key | role | Attendant, Supervisor, Admin | select |

## Where each entity is managed

| Entity | Screen (Admin menu unless noted) | Create | Edit | Remove |
| --- | --- | --- | --- | --- |
| Community | Platform (Super Admin) | yes | suspend / resume | – |
| Site | Sites & slots | yes | yes | retire (blocked while cars are inside) |
| Zone | Sites & slots | yes | yes | yes, when empty |
| Slot | Sites & slots; Import / export for bulk | yes | yes (zone, type, status, note) | retire (blocked while occupied) |
| Unit | Units; JSON import / export for bulk | yes | yes | yes, when unused |
| User | Users | yes (Super Admin can pick the community and its units) | yes | yes |
| Invitation | Users | with the user form | yes (roles, unit, Super Admin) | yes |
| Rate plan | Rate plans | yes (a new version) | new version | – (versions are immutable) |
| Guest pass | Resident view; Guest passes (Platform view) | yes | regenerate | cancel |
| Stay | Attendant flow; Stays (Platform view) | check-in | fee override, void | – |
| API key | Integrations | yes | – | revoke |
| Webhook | Integrations | yes | yes (URL, events, pause) | yes |
| Vehicle, Account, Permit, Device | not exposed yet | | | |

## How the screens connect

- The **menu** is built from the person's roles (see `apps/web/src/menu.ts`); Super Admins also get a **Community** switcher listing every community.
- **Units** → resident names link to **Users**; a user's unit code links back to **Units**; a form that needs a unit but finds none says so and links to Units. **Users** shows each resident's verification state and a *Verify unit access* action; only a verified resident may issue passes.
- **Communities & parking** → a Community settings panel edits the optional address and notes; bulk changes link to **Bulk import/export** (entity tabs: Community, Sites, Slots, Units, Users); a site's AI threshold is the same value as in **AI plate reading**.
- **Platform** (Super Admin) → *Enter* opens any community; **Users** lets a Super Admin place a user in any community with one of its units.
- API errors are shown in the person's language from the error code; fee lines and timeline events are translated from their codes.

## Locales

The product surfaces two user-selectable languages: **Spanish — Mexico (es-MX, default)** and **English**. Localization is controlled in code — there is no Localization admin screen. Other catalogs (es-ES, pt-BR, fr, de, ar) stay in the repo to keep ICU-parity and right-to-left coverage but are not user-selectable; a stored preference outside the surface set folds to es-MX (any Spanish) or English.
