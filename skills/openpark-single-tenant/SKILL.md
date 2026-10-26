---
name: openpark-single-tenant
description: Conversationally configure and install one OpenPark property, including inventory, units, users, Supabase Auth, embedded plate-reading models, and supporting services. Use when a user asks for a single-tenant OpenPark setup, an on-premises installation, a property setup wizard, or help generating inventory and deployment files.
allowed-tools: Read Write Edit Bash
---

# OpenPark single-tenant setup wizard

Use the real generator and installer in `packages/single-tenant`. Do not create a parallel demo app or hand-write a second inventory generator.

## Conversation

Ask one concise question at a time. Infer sensible defaults and let the user correct them. Do not turn the conversation into a long form.

1. **Property identity and owner**
   - Property type: residential, office, retail, or mixed
   - Property name, country, and timezone
   - Owner name and email
   - Default when appropriate: Mexico, `America/Mexico_City`

2. **Buildings and apartments**
   - Number of buildings/sites and their names
   - Apartment count and naming prefix for each building
   - First apartment number, default 101
   - Use `siteCode` values that are short, unique, uppercase identifiers

3. **Parking layout**
   - Floors per building, names, and numeric levels
   - Slots per type on each floor: standard, accessible, motorcycle (`moto`), and EV charging (`ev`)
   - “All standard” means every other type is zero
   - Every floor must have at least one slot; every building needs at least one apartment

4. **Staff**
   - Attendant and supervisor names/emails and any additional staff
   - Residents can be included with unit codes and `unitVerified` when known
   - Do not invent people, email addresses, units, slot counts, or reservations

5. **Review**
   - Summarize sites, floors, slot counts by type, apartment counts, and staff in a compact list
   - Ask for confirmation before generating or changing files
   - Show which answer values will change when the user requests a correction, then regenerate the summary

Never ask for an admin password in chat. At installation time, tell the user to set `OPENPARK_ADMIN_PASSWORD` themselves to at least 10 characters. Never print service-role keys, database passwords, JWT secrets, or admin passwords.

## Generate

Start from `packages/single-tenant/answers.example.json` and preserve only values confirmed by the user. Write the answers to a user-approved JSON file, then run:

```bash
node packages/single-tenant/generate.mjs path/to/answers.json
```

The generator writes:

- `generated/inventory.json`
- `generated/units.json`
- `generated/users.json`
- `generated/community.json`
- `generated/tenant.json`
- `generated/compose.yaml`
- `generated/supabase/config.toml`

Validate the reported site, apartment, slot, and staff counts. Read the generated files if any value is uncertain. Existing output is not overwritten without `--force`; ask before using it.

## Install

Only install after explicit user confirmation and these prerequisites are available: Docker with Compose, Supabase CLI, and Node 22+.

Ask the user to set `OPENPARK_ADMIN_PASSWORD`, without echoing it, then run:

```bash
node packages/single-tenant/install.mjs
```

The installer starts Supabase, embeds the ONNX models during the ALPR build, runs migrations, creates one tenant, applies the imports, and disables self-service signup. Do not expose service-role keys or generated secrets in output.

If installation is long-running, run it in the background and inspect actual status rather than guessing. If Supabase or Docker fails, report the exact blocker and do not claim the tenant was created.

## Verify and report

Verify rather than assuming:

```bash
curl http://localhost:8080/healthz
docker compose -f packages/single-tenant/generated/compose.yaml ps
```

Confirm the expected sites, floors, slot types, and apartments through the API or app. Report:

- App URL: `http://localhost:8080`
- Owner email from `tenant.json`, never the password
- Imported site, apartment, slot, and staff counts
- Health and model-readiness results
- Any remaining external-service blocker

Redis is included as a supporting service, but OpenPark jobs use Postgres and do not require Redis. The ALPR image contains its models at build time, so startup does not download them.
