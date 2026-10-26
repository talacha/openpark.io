# OpenPark — Open Source Parking Platform: System Design

## Summary

OpenPark takes the guesswork out of running a parking lot: at any moment it shows how many slots are free and in use, which car is in which slot, and at check-out exactly how long a guest stayed and what they owe. The code is free (AGPL-3.0); revenue comes from hosting, implementation and support.

| Question an operator asks | What OpenPark shows |
| --- | --- |
| How many slots are free right now? | Live count by site, zone and slot type |
| Which car is in slot B2-047? | Plate, make, model, colour, check-in time and the attendant who checked it in |
| What does this guest owe? | Stay measured to the minute between the check-in and check-out timestamps, priced by the site's rate plan |
| Who handled this car? | Every check-in, slot change, check-out and payment, with attendant, device and timestamp |

| App | Domain | Purpose |
| --- | --- | --- |
| Marketing site | openpark.io | Product, pricing and self-hosting guide; every call to action opens a free trial tenant on the app |
| Application | app.openpark.io | Multi-tenant admin console and attendant PWA; one tenant per client organisation |

| Decision | Choice | Why |
| --- | --- | --- |
| License | AGPL-3.0 core; Apache-2.0 for SDKs, JSON schemas and the plate-format registry | Clients self-host freely. A competitor running a hosted fork must publish its changes. Permissive schemas keep integrations frictionless. |
| Packaging | One set of OCI images; docker compose, Helm chart, community Terraform modules | No cloud lock-in: any container runtime, any cloud, or on-prem. |
| Tenancy | app.openpark.io is shared PostgreSQL with row-level security; a client can also get a dedicated stack | Same code path; one setting. |
| Portability | Full tenant export/import (JSON) | A client can move between app.openpark.io and self-hosted without a migration project. |
| AI | Optional, off by default, runs inside the deployment | No plate image leaves the client's infrastructure. |

Paid services: hosted plans on app.openpark.io, site survey and inventory load, support SLAs, camera and gate integration, payment adapters, and per-country plate-model fine-tuning.

## Architecture

A stateless TypeScript API over PostgreSQL does all the work; everything else is optional and swappable. The minimum install is four containers (web, API, Postgres, object storage); the AI profile adds two more.

&#91;embedded content: System architecture · 4 clients, 1 API, 4 backing services\]

Every client goes through the API; only the ALPR worker talks to the VLM, and both sit in a profile a tenant can leave off.

| Component | Technology | Notes |
| --- | --- | --- |
| Web app | TypeScript, React + Vite, installable PWA | One codebase, role-based routes for admin and attendant. Attendant view is offline-first (IndexedDB queue, idempotent replay). |
| API | Node.js 22, Fastify, Zod, OpenAPI 3.1 | Stateless, horizontally scaled. Types shared with the web app. |
| Database | PostgreSQL 16+ | Row-level security per tenant; LISTEN/NOTIFY for realtime. |
| Jobs | pg-boss (queue inside Postgres) | Imports, exports, webhooks, retention purges. No Redis to operate. |
| Realtime | Server-sent events | Live occupancy on every open screen. |
| Object storage | Adapter: S3-compatible, Azure Blob, GCS, local disk | Plate crops and exports. Profile pictures and enforcement evidence live in Postgres (`image_asset`). Local disk for single-node installs. |
| ALPR worker | Python 3.12, ONNX Runtime | Separate container behind HTTP. CPU by default; CUDA or OpenVINO optional. |
| VLM fallback | Any OpenAI-compatible server (llama.cpp, vLLM, Ollama) | Optional second-opinion reader and vehicle attributes. |
| Auth | Email + passkeys built in; OIDC/SAML to any IdP | Keycloak for self-hosters; Entra ID or Google for SaaS clients. |
| Observability | OpenTelemetry, Prometheus endpoint, JSON logs | Same signals in SaaS and self-hosted. |

**Tenancy.** Every row carries `tenant_id`; an RLS policy compares it with `current_setting('app.tenant_id')`, which the API sets per transaction. On app.openpark.io the tenant comes from the URL path (/t/{tenant-slug}/…), checked against the signed-in user's memberships; API keys carry their own tenant; self-hosted installs can map a custom domain. Single-tenant installs run the same path with one auto-created tenant.

**Marketing site (openpark.io).** A static site (Astro, Markdown content, same locales as the app) served from any CDN, with no database and no tracking cookies. It shares the design tokens and plate-chip components with the app so screenshots and live demos match. Its only dynamic call is the signup form, which posts to the app's public `/v1/signup` endpoint.

### From visitor to first check-in

1. Visitor clicks *Try it free* on openpark.io.
2. app.openpark.io/signup: email and passkey, organisation name, country. Country sets default locale, currency, timezone and plate regions.
3. A tenant is created with one demo site seeded from a sample inventory JSON, which the owner replaces by import.
4. The owner sets a rate plan (or keeps the country template) and invites attendants by email or QR code.
5. Attendants install the PWA from app.openpark.io and check in the first car.

| Deployment target | Shape |
| --- | --- |
| Single server or laptop | `docker compose up`; `--profile ai` adds the ALPR worker and VLM server |
| Kubernetes, any cloud or on-prem | Helm chart; bring your own managed Postgres if preferred |
| Managed cloud services | Terraform modules: AWS (ECS, RDS, S3), GCP (Cloud Run, Cloud SQL, GCS), Azure (Container Apps, PostgreSQL Flexible Server, Blob) |
| Edge box at the lot | ALPR worker on-site next to the cameras; talks to a cloud API and buffers when offline |

**Single-tenant package.** `packages/single-tenant` generates the property inventory, units, users, and community metadata from a conversational answer file, then installs one organisation with Supabase Auth and applies those imports through the real API. The source archive includes the app and deployment assets. The ALPR image instantiates its ONNX models during the build, so startup does not download them. Redis is included as a supporting service; jobs continue to use Postgres. The setup wizard is `skills/openpark-single-tenant/SKILL.md`, and `scripts/package-single-tenant.mjs` writes `dist/openpark-single-tenant/` and its archive without credentials, generated files, local data, or model binaries.

## Data model

Thirteen tables cover v1: a tenant owns sites, a site owns zones, a zone owns slots, a session ties one vehicle to one slot for one stay, and that session's event log records who did what, and when.

| Entity | Key fields | Notes |
| --- | --- | --- |
| `tenant` | slug, name, default\_locale, locales\[\], currency, plate\_regions\[\], ai\_mode | Root of every RLS policy |
| `site` | code, name, timezone, address, default\_rate\_plan\_id | A lot or building; times display in the site's timezone |
| `zone` | site\_id, code, name, level, sort | Floor, row or area |
| `slot` | zone\_id, code, type, attributes (jsonb), status, assignment, ext\_ref | `code` unique per site. Type: standard, compact, ev, accessible, moto, oversize, or tenant-defined. Status: available, occupied, reserved, out\_of\_service |
| `vehicle` | plate\_display, plate\_norm, plate\_region, plate\_class, body\_type, make, model, color, year | Unique on (tenant, plate\_region, plate\_norm) |
| `account` | name, contact, external\_ref | Permit holder; minimal personal data |
| `permit` | account\_id, vehicle\_ids\[\], slot\_id, kind, rate\_plan\_id, valid\_from, valid\_to | An assigned slot is a permit with `slot_id` set |
| `rate_plan` | site\_id, name, version, rules (jsonb), currency, tax\_mode, active\_from | Immutable once used: an edit creates a new version |
| `session` | site\_id, vehicle\_id, slot\_id, ticket\_code, in\_at, out\_at, in\_by, out\_by, rate\_plan\_id + version, fee, fee\_breakdown (jsonb), status | One open session per vehicle per site (partial unique index). `in_by` and `out_by` can be different attendants |
| `session_event` | session\_id, type, actor\_id, device\_id, gate, server\_at, device\_at, payload (jsonb) | Append-only timeline: check-in, slot moves, check-out, payment, edits, voids |
| `plate_read` | session\_id, device\_id, crop\_key, text\_raw, text\_norm, region, confidence, engine, latency\_ms, corrected\_to, decided\_by | Drives accuracy metrics and opt-in fine-tuning |
| `enforcement_case` | site\_id, session\_id, vehicle\_id, reasons, action, unit\_id, amount\_minor, currency, evidence\_key, fine\_issued\_at, immobilized\_at | Supervisor violation; linked reports require fine and immobilization before checkout, unlinked reports require immobilization |
| `enforcement_evidence` | case\_id, image\_key, actor\_id, created\_at | Append-only report photos; every image is optimized to WebP in Postgres |
| `image_asset` | tenant\_id, key, type, subject\_kind, subject, region, event, department\_number, mime, data, bytes, width, height, sha256 | Content-addressed WebP for profile pictures and enforcement evidence; `key` hashes the image's identity, so re-uploading replaces instead of accumulating |
| `device` | site\_id, kind (phone, ip\_camera, gate), lane, direction | Lane cameras and gates |
| `audit_event` | actor, action, entity, before, after, at | Append-only log for everything outside sessions: inventory imports, settings, users |

**Plate identity.** Four fields keep plates from every country matchable:

- `plate_display` — as printed, Unicode NFC, native script, separators kept.
- `plate_norm` — match key: uppercase, separators stripped, full-width and Eastern Arabic digits folded to ASCII.
- `plate_region` — ISO 3166-2 subdivision where plates are issued per state or province, otherwise ISO 3166-1 country.
- `plate_class` — private, commercial, motorcycle, temporary, diplomatic, dealer, government.

A **plate-format registry** (Apache-2.0 JSON, one file per region, community-maintained in the spirit of libphonenumber) holds each region's patterns, character set, line layout and confusable pairs (O/0, I/1, B/8). Validation, OCR post-correction, keypad layouts and display formatting all read from it.

## Slot inventory: JSON import and export

Each tenant edits its whole slot inventory as one versioned JSON document: export, edit in any editor, re-import with a diff preview and one-click rollback. Slot and site **codes** are the stable keys, never database IDs, so an export re-imported unchanged produces an empty diff.

```json
{
  "$schema": "https://schemas.openpark.io/inventory/v1.json",
  "schemaVersion": 1,
  "tenant": "demo-plaza",
  "exportedAt": "2026-10-20T14:00:00-06:00",
  "slotTypes": [
    { "code": "standard", "label": { "en": "Standard", "es-MX": "Estándar" } },
    { "code": "ev", "label": { "en": "EV charging", "es-MX": "Carga eléctrica" } },
    { "code": "moto", "label": { "en": "Motorcycle", "es-MX": "Motocicleta" } }
  ],
  "sites": [
    {
      "code": "TD-01",
      "name": "Torre Demo",
      "timezone": "America/Mexico_City",
      "zones": [
        {
          "code": "B2",
          "name": { "en": "Basement 2", "es-MX": "Sótano 2" },
          "level": -2,
          "slots": [
            { "range": "B2-001..B2-080", "type": "standard" },
            { "code": "B2-081", "type": "ev", "attributes": { "chargerKw": 11, "covered": true } },
            { "code": "B2-082", "type": "standard", "assignment": { "mode": "assigned", "permit": "ACME-EXEC-07" } },
            { "code": "B2-083", "type": "standard", "status": "out_of_service", "note": "Column repair" },
            { "range": "B2-M01..B2-M12", "type": "moto" }
          ]
        }
      ]
    }
  ]
}
```

**Format rules**

- Published JSON Schema (draft 2020-12, Apache-2.0) drives the import validator and gives editors autocompletion.
- `range` expands `PREFIX-start..PREFIX-end`, keeping the zero-padding width; any slot in a range can be overridden by a later entry with the same code.
- Labels accept a plain string or a locale map; `attributes` is free-form and preserved; `x-` keys are kept for client extensions.
- Exports can be filtered by site or zone and optionally expand ranges for spreadsheet users.

| Import mode | Behaviour |
| --- | --- |
| `merge` (default) | Upserts by site code + slot code. Slots absent from the file are left alone. |
| `replace` | The file becomes the inventory. Absent slots are retired (soft delete). Occupied or permit-assigned slots that would be removed are conflicts and block apply. |
| `dryRun` | Either mode with no writes; returns the diff only. |

**Import pipeline.** Upload or paste → schema validation with line-level errors → range expansion → diff against live state (added, changed, retired, conflicts) → preview screen → apply in one transaction → pre-import snapshot kept for rollback. Every apply writes an `audit_event` with the diff summary and requires the `inventory.import` permission.

## Attendant flows: check in and check out

Both flows are two taps when the read is good: capture, confirm. Any attendant can check out any car; the session keeps both attendants and both timestamps. Every write carries an idempotency key so a phone that lost signal can replay its queue safely.

**Check in**

1. Capture: attendant taps *Check in*; the camera opens with AI on, a region-aware keypad with AI off. A lane camera can push the read instead.
2. Read: plate text, region and confidence; body type, make, model and colour suggested when the VLM is enabled.
3. Look up: vehicle record, active permit, any open session at this site.
4. Pick a slot: the permit's assigned slot if there is one; otherwise the best free slot by rule (body type to slot type, accessible permit, EV preference, zone nearest the entrance, zone balancing).
5. Confirm: attendant edits anything and taps *Confirm*. The session opens, the slot turns occupied, a ticket QR is shown or printed.
6. Broadcast: occupancy updates on every screen; `session.opened` webhook fires.

**Check out**

1. Capture the plate or scan the ticket QR.
2. Match: exact `plate_norm` among open sessions at the site, then ticket code, then fuzzy candidates (confusable-weighted edit distance of 1). Fuzzy matches are shown, never auto-closed.
3. Review: entry crop beside exit crop, slot, who checked the car in and when, exact duration, and the computed fee with its breakdown.
4. Confirm and take payment (cash, card-terminal adapter, or bill to account): the session closes with the check-out attendant and timestamp, the slot turns available, a receipt prints or is sent, `session.closed` fires, and an integrated gate opens.

| Exception | Caught by | Attendant sees |
| --- | --- | --- |
| Plate already inside | Open-session unique index | "Inside since 08:12 at B2-014": close the stale session and re-open, or correct the plate |
| Assigned slot taken by another car | Slot status vs permit | Violation flag with the offender's plate; a temporary slot is offered |
| Slot type or site full | Live occupancy | Next-best type, or *Full* with free counts per zone |
| Low-confidence read | Confidence below site threshold | Top candidates plus keypad; nothing saves until confirmed |
| No open session on exit | Match fails | Search by partial plate, ticket or time window; manual close needs a reason |
| Phone offline | PWA connectivity check | Actions queue locally and replay; slot conflicts go to a supervisor queue |

## Fees and the audit trail

The fee comes only from the session's two server timestamps and the rate-plan version pinned at check-in, so any attendant gets the same number and a supervisor can reproduce it months later.

| Rule | Example: Visitor hourly, v3 (MXN) |
| --- | --- |
| Grace period | Out within 10 min: no charge |
| First period | $30.00 for the first 60 min |
| Increment | $10.00 per started 15 min after that |
| Daily cap | $250.00 per 24 h from check-in |
| Lost ticket | $300.00 flat, supervisor confirms |
| Tax | IVA 16% included in prices |

```latex
\text{fee} = \min\left(\text{cap},\; P_1 + p \cdot \left\lceil \frac{t - T_1}{\Delta} \right\rceil \right)
```

In 08:12, out 14:09 is t = 357 min: 30 + 10 × ⌈297 / 15⌉ = 30 + 10 × 20 = $230.00, under the $250.00 cap.

- **Time source:** durations use server time in UTC, displayed in the site's timezone, so daylight-saving changes cannot shift a fee. A device's own clock is stored beside it for offline replays; a large gap needs supervisor approval.
- **Plan changes:** open sessions keep the version they started under; new check-ins take the new version.
- **Multi-day stays:** the cap applies per 24 h block from check-in.
- **Overrides:** discounts, waivers and lost-ticket fees need the supervisor role and a reason; the original and the override are both kept.

**Audit trail.** Every session has an append-only `session_event` timeline; corrections are new events, never edits.

| Event | What is recorded |
| --- | --- |
| `check_in` | Attendant, device, gate, server and device time, plate read, source (AI auto, AI assist, manual) |
| `slot_assigned`, `slot_moved` | From, to, by whom, why |
| `check_out` | Attendant (may differ from check-in), device, gate, server and device time, match method (plate, ticket, confirmed fuzzy match) |
| `payment` | Amount, method, receipt number, attendant shift |
| `fee_override`, `edit`, `void` | Supervisor, reason, values before and after |

Shift reports (cash taken per attendant), the Sessions log screen and CSV/JSON exports all read from this table.

## Localization

The product **surfaces two user-selectable languages: Spanish — Mexico (es-MX, the default) and English**. Localization is controlled in code (there is no Localization admin screen); the language switcher offers exactly these two (`SELECTABLE_LOCALES` in `apps/web/src/i18n.tsx`). Additional catalogs — Spanish (es-ES), Portuguese (pt-BR), French, German and Arabic — remain in the repo to keep ICU-parity and right-to-left coverage (Arabic is retained as the day-one RTL proof), but are **not user-selectable**. A stored preference outside the surface set folds transparently (`foldToSurface`: any `es-*` → es-MX, everything else → en); `resolveLocale` is unchanged so BCP-47 mapping and the parity tests still exercise every catalog.

- **Strings:** ICU MessageFormat in JSON files per locale and namespace (plurals, select, gender). Translation runs on Weblate, which is itself open source and self-hostable.
- **Layout:** CSS logical properties only (`margin-inline-start`, not `margin-left`); `dir` set from the locale; only directional icons mirror. Arabic exercises RTL on every release.
- **Formatting:** `Intl` for dates, numbers, currency and relative time; times render in the *site's* timezone, not the device's.
- **Tenant terminology:** per-tenant overrides layered on the base locale, so one client says *cajón*, another *lugar* or *plaza*. Slot-type and zone labels are localized inside the inventory JSON.
- **Per-user locale:** people switch between the two surfaced languages on the device without changing the tenant default.
- **Data stays as captured:** plates always show in their native script; make and model names are never translated; colours, body types and slot types are enums with translated labels.
- **Keypads:** manual plate entry offers the character set of the site's enabled plate regions, from the plate-format registry.
- **CI guard:** a pseudo-locale build (accented, 40% longer strings) catches truncation and hard-coded text before release.

## AI plate reading (optional)

Recommendation: embed the **fast-plate-ocr** `cct-s-v2-global-model` (MIT) behind an **open-image-models** YOLOv9-tiny plate detector — the default pair in [FastALPR](https://github.com/ankandrew/fast-alpr) — and route hard cases to a small **Qwen3.5** vision-language model (Apache-2.0). The ONNX pair is fast enough for CPUs; the VLM covers the formats a fixed-slot OCR misses and also reads make, model and colour.

| Role | Model | License | Why it fits |
| --- | --- | --- | --- |
| Plate detection | [open-image-models](https://pypi.org/project/open-image-models/) `yolo-v9-t-384-license-plate-end2end` (`-640` for wide lanes) | Code MIT; YOLOv9 lineage is [GPL-3.0](https://roboflow.com/model-licenses/yolov9) — compatible with an AGPL core, confirm before bundling | ONNX; mAP50 0.92 at 384 px, 0.958 at 640 px |
| Plate OCR (primary) | [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) `cct-s-v2-global-model` | MIT | Project's recommended default; 0.68 ms per plate on an RTX 3090; optional region head predicts the issuing country; fine-tuning notebook included; exports to ONNX, TFLite, CoreML |
| Fallback reader + vehicle attributes | [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) (Qwen3.5-2B for CPU-only sites) | Apache-2.0 | Native vision-language model; reads two-line, square motorcycle, non-Latin and paper plates; returns plate, region, body type, make, model and colour as strict JSON |
| Alternative fallback | Qwen3-VL-2B-Instruct | Apache-2.0 | OCR in 32 languages; built for low light, blur and tilt |
| Optional make/model fast path | [vehicle-classifier](https://huggingface.co/jordo23/vehicle-classifier) (EfficientNet-B4, 8,949 make-model-year classes) | Check the model card before shipping | Runs without a GPU; trained on VMMRdb, so expect weaker results outside North America |

The earlier fast-plate-ocr global model covered 65+ countries at 93.3% plate accuracy ([model zoo](https://ankandrew.github.io/fast-plate-ocr/latest/inference/model_zoo/)); the v2 models publish per-country validation results, which should be checked against each client's regions before go-live.

**"All plate types" is a stack, not a model.** No single open model reads every format on Earth. Coverage comes from four layers:

1. Global OCR with a region head for the common case.
2. The plate-format registry validates the read and corrects confusables (O/0, I/1) only where the region's pattern allows.
3. The VLM handles what the OCR cannot: low confidence, failed format check, multi-line or square plates, scripts outside the OCR's charset.
4. Attendant corrections become labelled data (opt-in per tenant) for per-country fine-tuning — a paid service.

&#91;embedded content: Plate-reading pipeline · one decision, two modes\]

In Auto mode a confident, format-valid read commits on its own; everything else lands with the attendant, whose corrections feed the opt-in training set.

| Mode | Behaviour | Typical use |
| --- | --- | --- |
| Off (default) | Keypad entry only | Small lots, no cameras |
| Assist | AI pre-fills every field; attendant confirms each read | Start here; builds the labelled set |
| Auto | Reads at or above the site threshold (default 0.95) open and close sessions with no tap; below it, falls back to Assist | Lane cameras with gates |

**Accuracy guards.** Each capture takes 3–5 frames and votes per character; a read is accepted only when frames agree and the format validates. Every model upgrade is benchmarked on the tenant's last 30 days of confirmed reads and ships only if it wins. Model files are pinned by hash.

**Privacy.** Plates are personal data under GDPR, Mexico's LFPDPPP and California's CCPA, so the defaults are conservative: store the plate crop, not the full frame; purge images after 30 days (tenant-configurable); log every image view; never call an external AI API. Training-data export is off unless the tenant opts in.

**Hardware.** The detector + OCR pair runs on CPU for attendant-paced traffic; GPU or OpenVINO helps for multi-lane video. The VLM wants a GPU for interactive latency; Qwen3.5-2B quantized is the CPU-only option, at slower fallback reads. Phase 2 tests running the ONNX pair inside the attendant PWA with onnxruntime-web for fully offline reads.

## API, integrations and security

Everything the UI does is a public REST call (OpenAPI 3.1, versioned under `/v1`), so integrators and the official TypeScript and Python SDKs (Apache-2.0) use the same surface.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/signup` | Create a trial tenant (called by openpark.io) |
| POST | `/v1/sessions` | Check in |
| POST | `/v1/sessions/{id}/checkout` | Check out a known session; returns fee and breakdown |
| POST | `/v1/checkout` | Check out by plate or ticket code |
| GET | `/v1/sessions?status=&from=&to=&attendant=&zone=` | Sessions log |
| GET | `/v1/sessions/{id}/events` | One session's audit timeline |
| POST | `/v1/sessions/{id}/payments` | Record a payment against a closed session |
| GET | `/v1/slots?site=&status=&type=` | Slot availability |
| PATCH | `/v1/slots/{code}` | Status change, e.g. out of service |
| GET, POST | `/v1/rate-plans` | List plans; a change creates a new version |
| POST | `/v1/rate-plans/{id}/quote` | Fee for a given in and out time, without a session |
| GET | `/v1/inventory/export?site=&zone=` | Inventory JSON |
| POST | `/v1/inventory/import?mode=merge&dryRun=true` | Validate and diff; returns a job |
| POST | `/v1/inventory/import/{job}/apply` | Apply a previewed diff |
| POST | `/v1/inventory/import/{job}/rollback` | Restore the pre-import snapshot |
| POST | `/v1/alpr/read` | Image in, ranked plate candidates out |
| GET | `/v1/enforcement/inspect?site=&entry=` | Supervisor vehicle validity, expected box, responsible unit, and required action |
| POST | `/v1/enforcement/flags` | Create a violation report with optional evidence, or required evidence for unlinked immobilization |
| GET | `/v1/enforcement/reports?site=&status=` | List report status, required actions, and photo history |
| POST | `/v1/enforcement/cases/{id}/fine` | Issue the linked department's 5,000 MXN fine once |
| POST | `/v1/enforcement/cases/{id}/evidence` | Append a photo or confirm immobilization |
| GET | `/v1/reports/shifts?date=` | Sessions and cash per attendant shift |
| GET | `/v1/events` | Server-sent events: occupancy, sessions, low-confidence reads |

**Integrations.** Webhooks (HMAC-SHA256 signed, retried with backoff) for `session.opened`, `session.closed`, `slot.changed`, `read.needs_review`. Gates and barriers via webhook or MQTT. IP cameras via RTSP or ONVIF snapshots into the ALPR worker. Payment adapters (Stripe, Mercado Pago) and ESC/POS receipt printers are plug-ins.

**Security.** Postgres RLS isolates tenants even if application code misses a filter. Writes require an `Idempotency-Key`. API keys are scoped per tenant and per site. Plate images and enforcement evidence are served only through short-lived signed URLs. The audit log is append-only. Profile pictures are optional: an uploaded one is stored as WebP and served through a signed URL; when there is none, the screen asks Gravatar for the picture registered to the person's email. Only the SHA-256 of the address (never the address) is sent, with no referrer, and Gravatar's `d=404` means an address without a profile returns no image, so the initials stay. When `GRAVATAR_API_KEY` is set, the API calls Gravatar's v3 profile endpoint server-side instead (the key never reaches the browser) and caches the answer; without it, the public avatar URL is used.

A person can hold several roles; access is the union. Roles, least to most access:

| Role | Can |
| --- | --- |
| Resident | Lives in the complex (belongs to a unit) and issues guest parking passes by QR code |
| Attendant | Check in, check out, take payment, scan plates and QR codes, mark a slot out of service |
| Supervisor | Everything an Attendant can, plus override fees, void sessions, manage guest passes, and enforce parking violations; is notified per community when a car passes 10, 11 and 12 hours |
| Admin | Configures one community (the surfaced name for a property): sites, zones, slots, units, people (verifying residents' unit access), bulk import/export, and — under Advanced — rates, integrations and AI. Localization is code-controlled, not an admin screen. |
| Super Admin | A platform-wide flag, not a role of a community: configures every community and switches between them |

See `docs/DOMAIN.md` for the vocabulary and how the entities relate.

## Screens and roadmap

Fourteen screens across the two apps cover v1; all are mocked up in the companion design canvas.

| Screen | App | User | Purpose |
| --- | --- | --- | --- |
| Landing page | openpark.io | Prospect | Value proposition, how it works, deployment options, free trial |
| Occupancy dashboard | app | Admin | Live occupancy by zone, free by type, fees collected, recent activity |
| Sessions log | app | Admin, auditor | Every stay with both attendants, timestamps, duration and fee; per-session event timeline |
| Slot inventory | app | Admin | Zone map and table; edit type, status, assignment |
| Inventory import / export | app | Admin | Paste or upload JSON, validate, review diff, apply, roll back |
| Rate plans | app | Admin | Versioned pricing rules and a fee simulator |
| AI plate reading settings | app | Admin | Mode, threshold, engines, plate regions, retention |
| Bulk import/export | app | Admin | One screen with entity tabs (Communities, Slots, Units, Users): validate, review diff, apply, roll back — no secrets in any export or diff |
| Vehicle enforcement | app | Supervisor | Scan plate, ticket, or pass; show validity and assigned box; create violation reports and append photo evidence |
| Attendant home | app | Attendant | Check in / Check out, live free count, recent activity, and pending fine and immobilization actions required before checkout |
| Check-in capture | app | Attendant | Camera with live plate box, read and confidence |
| Check-in confirm | app | Attendant | Vehicle details, suggested slot, ticket |
| Low-confidence review | app | Attendant | Candidate plates and keypad (Assist mode) |
| Check-out | app | Attendant | Who checked the car in and when, duration, fee breakdown, payment |
| Attendant home, es-MX | app | Attendant | Same screen localized, with terminology overrides |

&#91;embedded content: Roadmap · 4 phases, 4 gates, not to scale\]

Each phase ships only when its gate is met; dates are set after the pilot site is chosen.

Open questions: which payment adapters ship first (cash and a card-terminal adapter are assumed for v1); whether a customer self-service portal (permits, receipts) belongs in scope; pricing of the hosted plans shown on openpark.io.

## Sources

- [fast-plate-ocr on GitHub](https://github.com/ankandrew/fast-plate-ocr) — model table, latency, MIT license, region head
- [fast-plate-ocr model zoo](https://ankandrew.github.io/fast-plate-ocr/latest/inference/model_zoo/) — recommended default, legacy global model coverage
- [FastALPR](https://github.com/ankandrew/fast-alpr) — detector + OCR pairing
- [open-image-models on PyPI](https://pypi.org/project/open-image-models/) — plate detector precision, recall, mAP
- [Roboflow: YOLOv9 licensing](https://roboflow.com/model-licenses/yolov9) — GPL-3.0 lineage
- [Qwen3.5-4B model card](https://huggingface.co/Qwen/Qwen3.5-4B) — Apache-2.0, vision-language
- [Qwen3-VL overview](https://ai-tldr.dev/models/qwen3-vl/) — sizes, Apache-2.0, OCR languages
- [vehicle-classifier model card](https://huggingface.co/jordo23/vehicle-classifier) — EfficientNet-B4, VMMRdb, 8,949 classes
