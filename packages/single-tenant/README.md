# OpenPark single-tenant installation

This package installs one OpenPark organisation with its own property inventory, units, users, Supabase Auth, embedded ONNX plate reader, and supporting services. It uses the same application code as the main OpenPark repository.

## Included

- OpenPark API and web app with one tenant created by the installer
- Supabase local services for authentication and Postgres
- One-shot database migration
- ONNX plate detector and OCR models embedded in the ALPR image at build time
- Optional VLM container for a second-opinion reader
- Redis as a supporting service. OpenPark jobs use Postgres and do not require Redis

No credentials, model binaries, generated files, or local data are included in the source archive.

## Prerequisites

- Docker with Compose
- Supabase CLI
- Node.js 22 or newer
- Enough disk space and network access for the initial container and model builds

Check the tools:

```bash
docker compose version
supabase --version
node --version
```

## 1. Describe the property

Copy `answers.example.json` somewhere writable and edit it:

```json
{
  "property": {
    "type": "residential",
    "name": "Ahuizotl Residences",
    "country": "MX",
    "timezone": "America/Mexico_City",
    "owner": { "email": "admin@example.com", "name": "Property Administrator" }
  },
  "buildings": [],
  "staff": []
}
```

For each building, provide:

- `code` and `siteCode`: unique identifiers
- `name`: display name
- `units`: `prefix`, first unit number (`start`), and apartment `count`
- `floors`: each floor's code, display name, numeric level, and slot counts

Slot types are `standard`, `accessible`, `moto`, and `ev`. Set a type to `0` when it is not used. “All standard” means every other type is `0`. Every floor needs at least one slot.

`staff` contains invited accounts, not passwords. Supported roles are `resident`, `attendant`, `supervisor`, and `admin`. The owner is defined in `property.owner`, not duplicated in `staff`.

## 2. Generate the installation files

From the extracted package root:

```bash
node packages/single-tenant/generate.mjs path/to/answers.json
```

The generator writes `packages/single-tenant/generated/`:

- `inventory.json`: sites, floors, and slot allocations
- `units.json`: apartment codes, names, and site associations
- `users.json`: staff invitations and roles
- `community.json`: the single community
- `tenant.json`: owner and property metadata used by the installer
- `compose.yaml`: OpenPark services
- `supabase/config.toml`: local auth configuration

Generation is deterministic apart from the export timestamp. Existing output is protected from accidental overwrite; use `--force` only after reviewing the new answers. Use `--out /another/directory` for a separate output location.

## 3. Install

Choose an admin password of at least 10 characters and provide it only to the installer process:

```bash
export OPENPARK_ADMIN_PASSWORD='replace-with-your-own-password'
node packages/single-tenant/install.mjs
```

The installer will:

1. Start Supabase.
2. Generate database and application secrets in memory.
3. Build OpenPark and the ALPR image with models embedded.
4. Run migrations and wait for the API to become healthy.
5. Create one organisation and apply all generated imports.
6. Disable self-service signup.

Secrets are not written into the source package or the generated JSON files. Do not print the service-role key or share the generated environment.

Open `http://localhost:8080`. Sign in with `property.owner.email` and the password supplied to the installer. Staff accounts in `users.json` are invitations; accept them through the invitation flow. Supabase's local email inbox is at `http://localhost:54324`.

## 4. Verify

```bash
curl http://localhost:8080/healthz
docker compose -f packages/single-tenant/generated/compose.yaml ps
supabase status --workdir packages/single-tenant/generated/supabase
```

In the app, check that each site has the expected floors and slot types, and each apartment is present. The plate reader is available through the attendant camera flow. Models are already in the ALPR image; it does not download them on startup.

## Stop and restart

Stop only the OpenPark containers:

```bash
docker compose -f packages/single-tenant/generated/compose.yaml down
```

Stop Supabase separately:

```bash
supabase stop --workdir packages/single-tenant/generated/supabase
```

To start the existing installation again:

```bash
supabase start --workdir packages/single-tenant/generated/supabase
docker compose -f packages/single-tenant/generated/compose.yaml up -d
```

`down` preserves volumes. `down -v` deletes tenant data and should only be used for an intentional reset.

## Backup and restore

Back up the database:

```bash
docker exec supabase_db_openpark-single-tenant pg_dump -U postgres -d postgres > openpark-backup.sql
```

Restore after recreating the database volume:

```bash
docker exec -i supabase_db_openpark-single-tenant psql -U postgres -d postgres < openpark-backup.sql
```

Keep backups private: they contain tenant, vehicle, resident, and enforcement data.

## Upgrade

Extract the newer package over a separate directory, review changes, then rebuild:

```bash
docker compose -f packages/single-tenant/generated/compose.yaml up -d --build
```

Migrations run automatically before the API starts. Keep a backup before upgrading.

## Security

- Change every generated secret before exposing the installation to anyone.
- Self-service signup is disabled after the first tenant is created.
- Put the web service behind TLS. Do not expose Supabase Studio, the database, Redis, or the VLM port publicly.
- Keep `.env.local` files, service-role keys, admin passwords, and backups out of version control.
- One organisation is created per installation. Additional organisations must be a separate deployment with separate data volumes and secrets.
