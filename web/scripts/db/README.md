# Database scripts (Stage 1 — Foundations)

Runnable migration, seed, and verification scripts for the Support Portal
PostgreSQL database. **Stage 1 ships code only** — nothing here runs
automatically and no live credentials are bundled. You execute the scripts
yourself against a database you control.

## What these scripts do

| Script | npm command | Effect |
| --- | --- | --- |
| `migrate.ts` | `npm run db:migrate` | Applies the repo-root `schema.sql` **once** (fresh-install baseline), then every `scripts/db/migrations/*.sql` in filename order — all recorded in a `schema_migrations` ledger. Idempotent: re-running is a no-op. |
| `seed.ts` | `npm run db:seed` | **Bootstrap only.** Seeds currently-supported client accounts + one business unit each (slug = ClickUp customer code), global status mappings, and one SLA calendar scaffold; retires the legacy `pepkor` account via `is_active = FALSE`. **No SLA policies.** Idempotent. |
| `verify.ts` | `npm run db:verify` | Read-only. Confirms extensions, enum types, tables, and **structural tenancy invariants** (client-count-agnostic). Exits non-zero on any failure. Writes nothing. |

### Onboarding & retiring clients

`seed.ts` is for **initial bootstrap** of the clients supported today — it is **not**
the exhaustive or permanent client list, and the runtime never depends on it (the
sync resolver reads `business_units` live).

- **Onboard a new client** with a migration or an administrative `INSERT` into
  `accounts` + `business_units` (business unit `slug` = the ClickUp customer code).
  No resolver/sync code change is needed; the next sync attributes it automatically.
- **Until onboarded**, any unknown/legacy ClickUp code deterministically
  quarantines as `BU_UNDETERMINED` — never guessed or silently mapped.
- **Retire a client** with `is_active = FALSE` (preserves historical data);
  `loadBuBySlug` and the session both ignore inactive rows.

Prefer migrations/admin data changes over continually editing `seed.ts` for
ongoing onboarding.

### How migrations work (Stage 8a)

The runner has a two-part model, all recorded in the `schema_migrations` ledger:

1. **Baseline** — the repo-root `schema.sql` (authoritative DDL for **fresh**
   installs) is applied exactly once, on an empty database. If it later differs
   from the applied checksum that is informational only: applied databases
   evolve via migration files, while `schema.sql` is kept in sync for fresh
   installs.
2. **Migrations** — `scripts/db/migrations/*.sql`, applied in filename order,
   each in a transaction and checksummed. Re-running is a no-op; **editing an
   already-applied migration file is a hard error** (add a new file instead).
   Write migration files idempotently (`IF NOT EXISTS`) so they also no-op on a
   fresh install whose `schema.sql` already contains the change.

To evolve the schema: add `scripts/db/migrations/NNNN_description.sql` **and**
fold the same DDL into `schema.sql`.

## Prerequisites

- Node.js 20+
- A PostgreSQL 14+ database (local, or Vercel Postgres)
- Dependencies installed: `npm install` (adds `pg`, `tsx`, `dotenv`, `@types/pg`)

## Configuration

From the `web/` directory:

```bash
cp .env.example .env
# edit .env and set DATABASE_URL (Stage 1 needs only DATABASE_URL)
```

Only `DATABASE_URL` is required for these scripts. ClickUp and Microsoft Graph
credentials are **not** needed until later stages and are not validated here.

TLS is chosen automatically: disabled for `localhost`/`127.0.0.1`, enabled
otherwise (managed providers). Force-disable with `PG_DISABLE_SSL=true` for a
local non-SSL server.

## Run locally

Spin up a throwaway Postgres (Docker example):

```bash
docker run --rm --name pattern-pg -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 -d postgres:16

# in web/.env
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

Then, from `web/`:

```bash
npm install
npm run db:migrate
npm run db:seed
npm run db:verify
```

To start over in development:

```bash
docker exec -it pattern-pg psql -U postgres -c \
  "DROP DATABASE IF EXISTS postgres WITH (FORCE);" # or drop/recreate a named DB
# then re-run migrate / seed / verify
```

## Run against Vercel Postgres

1. Create a Postgres store in the Vercel dashboard (Storage → Create → Postgres).
2. Use the **pooled** connection string (the host contains `-pooler`) as
   `DATABASE_URL`. You can pull project env vars locally with:

   ```bash
   vercel env pull .env
   ```

   (ensure the pulled value is the pooled string with `sslmode=require`).
3. From `web/`, run the same commands. They connect over TLS automatically:

   ```bash
   npm run db:migrate
   npm run db:seed
   npm run db:verify
   ```

These are operational scripts intended to be run from your machine or CI against
the target database. They are **not** wired into the app runtime, Vercel build,
or any cron — that comes in later stages.

## Expected `db:verify` result

```
PASS  extensions                  all 3 present
PASS  enum types                  all 6 present
PASS  tables                      all 16 present
PASS  accounts (pepkor)           expected 1, found 1
PASS  business_units              expected 6, found 6
PASS  status_mappings             expected 6, found 6
PASS  sla_calendars               expected 1, found 1
PASS  sla_policies (none yet)     expected 0, found 0
PASS  business requirement unmapped  correctly absent
```
