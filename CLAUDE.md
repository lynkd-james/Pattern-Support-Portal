# CLAUDE.md — Pattern Support Portal

Guidance for Claude Code (and any future agent) working in this repository. Read this first.

---

## 1. What this is

A production-grade **Customer Support Portal** for **Pattern Retail** (a South African SaaS for stock allocation and business intelligence). It gives enterprise clients (e.g. Pepkor Speciality Group brands) **read-only** visibility of their support tickets **without ever exposing ClickUp or internal systems**.

Tickets originate in Outlook, are worked in ClickUp, and are surfaced to customers through a separate, sanitised projection. The portal never touches ClickUp at request time.

---

## 2. Tech stack

- **Frontend:** Next.js (App Router), React, TypeScript, Tailwind CSS, shadcn/ui
- **Backend:** Next.js API routes (Node), PostgreSQL via `pg` (Neon-backed / Vercel Postgres, pooled)
- **Auth:** Microsoft Entra ID (Azure AD) — live since Stage 8a (`AUTH_PROVIDER=entra`; multi-tenant app, tenant pinned at provisioning, DB-backed sessions — see `docs/auth.md`). A placeholder provider remains for dev only.
- **Integrations:** ClickUp REST v2, Microsoft Graph (app-only) for the Outlook support mailbox
- **Hosting:** Microsoft Azure / Vercel; scripts run under `tsx`
- **TypeScript:** `strict: true`, `target ES2017`, `module esnext`, `moduleResolution bundler`, path alias `@/* → ./src/*`

---

## 3. Repository layout

```
/ (repo root)
├── schema.sql                 # authoritative PostgreSQL schema (V2, MVP) — single source of DDL
├── data-model-v1.md / v2.md   # data-model design notes
├── docs/projection.md         # projection layer design
├── assets/                    # brand assets
└── web/                       # the Next.js application (run all npm scripts from HERE)
    ├── .env.example           # documented config surface (copy to .env; never commit .env)
    ├── package.json           # scripts (see §6)
    ├── scripts/
    │   ├── db/                # migrate.ts, seed.ts, verify.ts, migrations/*.sql (+ README)
    │   ├── sync/              # clickup.ts, outlook.ts (manual sync entrypoints)
    │   ├── projection/        # run.ts (transform internal → customer)
    │   ├── sla/               # run.ts (SLA engine → chained projection)
    │   └── sessions/          # cleanup.ts (expired-session cleanup)
    └── src/
        ├── middleware.ts      # cookie-presence page redirects — UX ONLY, never the security boundary
        ├── app/               # App Router: pages (/dashboard, /login) + /api routes
        │   └── api/           # tickets, tickets/[id], session, auth/*, jobs/[step] (cron), admin/* (Stage 10a)
        ├── components/dashboard/  # CUSTOMER UI: DashboardPage, FilterBar, SummaryCards, TicketTable
        ├── components/admin/      # ADMIN UI (Stage 10b): AdminShell, six console pages, ui/ primitives, useAdminData
        ├── lib/               # client-safe: api.ts, types.ts, display.ts, summary.ts, authCookies.ts
        │   └── admin/         # ADMIN client lib (Stage 10b): contracts.ts (THE /api/admin/* DTOs,
        │                      #   shared server+UI), api.ts (fetch client), types.ts, format.ts
        │                      #   components/admin + lib/admin are in the import-boundary guard
        └── server/            # SERVER-ONLY (never import into client code)
            ├── db.ts, env.ts, logger.ts, apiError.ts (sanitised error envelopes)
            ├── clickup/       # client.ts, types.ts
            ├── graph/         # client.ts, types.ts (Microsoft Graph app-only)
            ├── sync/          # resolve.ts (pure), clickupSync.ts, ackEmail.ts, outlookSync.ts
            ├── projection/    # transform.ts, visibility.ts (pure), labels.ts
            ├── sla/           # calendar.ts (pure), sla.ts (pure), compute.ts (engine)
            ├── jobs/          # pipeline.ts (advisory-lock orchestrator), sessionCleanup.ts
            ├── auth/          # SHARED auth: identity.ts + policy.ts (pure), provider.ts, realm.ts, flow.ts, handlers.ts, sessionStore.ts, audit.ts
            │   └── providers/ # per-provider adapters: entra.ts, entraClaims.ts (pure), google*, msal.ts (per-app factory)
            ├── customer/      # CUSTOMER realm: session.ts (factory), portalSession.ts, authRealm.ts, queries.ts
            └── admin/         # ADMIN realm (Stage 10a): authRealm.ts, adminSessionStore.ts, session.ts, adminAudit.ts, queries.ts
                               #   customer/** and admin/** NEVER import each other (import-boundary.test.ts)
```

---

## 4. Architecture — the dual-layer model

Data flow (one direction, never skipped):

```
Outlook (supportdesk mailbox)
  → ClickUp (support workspace)
    → Sync service        → internal_tickets / internal_ticket_events   (INTERNAL layer)
    → Outlook ack sync    → internal_tickets.acknowledged_at
    → SLA engine          → internal_tickets (milestones + due-times + SLA states)
    → Projection engine   → customer_tickets / customer_ticket_timeline (CUSTOMER layer)
      → Customer API (/api/*) reads ONLY the customer layer
        → Dashboard
```

Two physically separate layers:

- **INTERNAL layer** (`internal_tickets`, `internal_ticket_events`): full-fidelity system of record. The sync service and SLA engine write here. **Never exposed to customers.**
- **CUSTOMER layer** (`customer_tickets`, `customer_ticket_timeline`): a **derived projection** containing only explicitly approved, customer-safe fields. The portal API reads **only** this layer, and only rows `WHERE visibility_state = 'published'`.

There is **no runtime field-masking** from ClickUp to the client. Data crosses the boundary only through the transformation layer, and only when `visibility_state` allows. The customer layer is always fully rebuildable from the internal layer; it is never a source of truth.

**Layer separation (clean architecture):** UI ← API ← data. UI components never read ClickUp or the internal layer. API routes resolve tenant scope, then call `customer/queries.ts`, which contains **no business logic** (no SLA math, no status mapping) — it returns stored projection values mapped 1:1 to the frozen API contract.

---

## 5. Non-negotiable invariants

These are hard rules. Do not violate them without an explicit, reviewed decision.

**Security / tenancy**
1. Customers must **never** access ClickUp or internal data directly.
2. Every customer read is filtered by tenant scope (`account_id` + optional `business_unit_id`) **and** `visibility_state = 'published'`.
3. The **client never sends an account id.** Scope is always resolved server-side by the `SessionProvider`. `RequestScope = { accountId, businessUnitIds }` is produced server-side only.
4. No internal comments / internal-only fields ever reach the customer layer. `customer_summary` is the **only** authored free-text field eligible to become the customer-facing description.
5. `visibility_state` defaults to `internal_only` (the safe default). `cancelled` tickets are hidden; `done` tickets are shown.
6. All server config/secrets live in `src/server/**` behind a `typeof window !== "undefined"` guard. Never import `server/*` into client code. Never log secrets (`logger.ts` emits structured JSON only).

**Data integrity**
7. **Never guess. Quarantine instead.** Genuinely ambiguous classification (missing custom id, **no** mapped business unit, missing/unsupported/multiple SLA priority, unmapped status) → the ticket is quarantined, not fabricated. See `sync/resolve.ts` `QuarantineReason`. **NOTE (Stage 9a):** *multiple* business units is **no longer** a quarantine — it is a legitimate shared ticket (see §7 tenancy + `docs/shared-tickets.md`); only **zero** matches quarantine (`BU_UNDETERMINED`).
8. **Config is data-driven, never hardcoded.** Status mappings live in `status_mappings`; SLA targets live in `sla_policies`. Engines read them — they must not embed business values. The SLA engine is **request-type agnostic**: it consumes only the resolved policy (e.g. A&R requests are handled as standard P2 purely via their priority label, with zero special-casing in the engine).
9. Syncs are **incremental + idempotent**, driven by a watermark in `sync_runs` (one `source_system` per subsystem: `clickup`, `outlook`, `transform`, `sla`, `sessions`). Upserts are keyed by `clickup_task_id`; first-write-wins on milestones.
10. Engines **write only on actual change** to avoid churning the projection's `updated_at` watermark.
11. Core logic modules are **pure and deterministic** (no DB/network): `sync/resolve.ts`, `projection/visibility.ts`, `sla/calendar.ts`, `sla/sla.ts`. Keep them that way so they stay unit-testable.
12. `internal_ticket_events` is **immutable/append-only** and never written by the projection (customer-visibility is *computed*, not stored on the event).

---

## 6. Development workflow

Run all `npm` scripts from **`web/`**. Copy `.env.example` → `.env` first.

```bash
# Database
npm run db:migrate        # apply ../schema.sql
npm run db:seed           # idempotent reference data (accounts, BUs, status_mappings, calendar, sla_policies)
npm run db:verify         # read-only structural invariants (gates CI; exits non-zero on failure)

# Ingestion & pipeline (manual entrypoints; ALSO scheduled via Vercel Cron —
# vercel.json → /api/jobs/{clickup,outlook,sla,projection,sessions}, one step
# per invocation, staggered every 15 min, CRON_SECRET-guarded, advisory-locked)
npm run sync:clickup      # ClickUp → internal_tickets
npm run sync:outlook      # supportdesk mailbox → internal_tickets.acknowledged_at
npm run sla               # SLA engine → then CHAINS the projection (CLI only; scheduled steps run separately)
npm run project           # transform internal → customer (incremental)
npm run project:rebuild   # full re-projection (recovery; preserves ADMIN visibility decisions)
npm run sessions:cleanup  # delete sessions invalid for > 7 days
npm run admin:bootstrap   # create the first admin_users row (Stage 10a; explicit args)
npm run env:check         # read-only per-subsystem production-readiness report

# App
npm run dev | build | start | lint

# Tests (Stage 9a; permanent regression suite, Vitest)
npm test                  # unit tier — pure, no DB, seconds (tests/unit/**)
npm run test:integration  # workflow tier — isolated scratch DB (tests/integration/**)
```

**Staged, review-first delivery.** Work proceeds one stage at a time; **each stage is a single cohesive commit**. Design first → verify dependencies → implement cleanly → typecheck (`tsc --noEmit`) → validate → commit. Commit message convention: `Stage N: <summary>` (see `git log`).

**Do not** expand scope, split a stage's cohesive commit, or make architectural changes without a demonstrated defect. Prefer simplicity over over-engineering in V1.

---

## 7. Data model (see `schema.sql` for the authoritative DDL)

**Enums:** `priority_level` (`P1`–`P4`; **P4 = no SLA commitments** — valid work outside contractual SLAs, e.g. client queries/module assistance/internal tasks; deliberately has NO `sla_policies` row, so the engine yields `NOT_APPLICABLE` via its normal no-policy path — never special-cased), `portal_stage`, `sla_state` (`NOT_APPLICABLE`/`PENDING`/`AT_RISK`/`MET`/`BREACHED`), `visibility_state` (`internal_only`/`ready_for_customer`/`published`/`hidden_from_customer`), `audit_source`, `sync_status`.

**Tenancy:** `accounts` → `business_units`. Current model: **each ClickUp `Customer` code is its own independent client = one account + one business unit**, where `business_units.slug` = the ClickUp `Customer` code (the sync's attribution key). `status_mappings` and `sla_policies` are **global** (`account_id`/`business_unit_id` NULL). The legacy single `pepkor` account is retired via `is_active = FALSE` (non-destructive). The runtime resolves business units live — onboard a new client with a seed row / admin INSERT, not by editing engine code. `db:verify` uses **structural invariants** (e.g. "every active account has ≥1 active BU", "no duplicate active slug"), **not fixed client counts**.

**Shared tickets (Stage 9a, `docs/shared-tickets.md`).** A ticket may be visible to **multiple business units across different accounts** (a fix affecting Ayana *and* Refinery). Visibility is a set: `internal_ticket_business_units` (junction) is the **sole source of which BUs — and thus accounts — may see a ticket**. One canonical `internal_tickets` row; the projection **fans out one `customer_tickets` row per visible BU**, so per-account isolation (invariant #2) is unchanged — each viewer reads only their own scoped row. `internal_tickets.account_id`/`business_unit_id` are **ORIGIN** (reporting only, never visibility): populated iff the visibility set has exactly one member, else **NULL** (no fabricated origin; a NULL-origin ticket structurally matches only global SLA policies). Terminology: **tickets** = canonical internal records; **exposure** = customer-visible projections. Projection lifecycle: a row exists only while its visibility scope exists — de-listed BU ⇒ row **hard-deleted** (history lives in `audit_events`); unpublished ⇒ hidden tombstone. Two projection guarantees: **determinism** (published/current surface is a pure function of internal state) and **preservation** (surviving rows keep stable identity). Four executable `db:verify` invariants encode the model.

**Core tables:** `internal_tickets`, `internal_ticket_business_units`, `internal_ticket_events`, `customer_tickets`, `customer_ticket_timeline`, `status_mappings`, `sla_calendars`, `sla_calendar_holidays`, `sla_policies`, `portal_users`, `portal_user_business_units`, `magic_link_tokens`, `portal_sessions`, `audit_events`, `sync_runs`.

**SLA model (Stage 7).** Business-hours only, Mon–Fri 08:00–17:00 **Africa/Johannesburg** (UTC+2, no DST). Response = `created_at → acknowledged_at`; Resolution = `created_at → closed_at`. No pause behaviour. Seeded global targets: **P1 2h/24h, P2 8h/48h, P3 24h/120h** (business hours), **at-risk threshold 80%**; **P4 has no policy by design** (no SLA — the UI renders `NOT_APPLICABLE` as "No SLA"). States: milestone reached → `MET`/`BREACHED`; else `BREACHED` if past due, `AT_RISK` past the threshold, else `PENDING`; no matching policy → `NOT_APPLICABLE`. Values live in `sla_policies` only.

---

## 8. Integration notes

- **ClickUp:** REST v2. Token is sent **raw** in the `Authorization` header (no `Bearer`). Archived tickets are retrieved **per-list** via `/list/{id}/task?archived=true` (the `/team/{id}/task` endpoint has no `archived` param) — controlled by `CLICKUP_INCLUDE_ARCHIVED` (default true). `CLICKUP_TEAM_ID` and `CLICKUP_SUPPORT_FOLDER_ID` are **required** (fail fast; no fallbacks).
- **Microsoft Graph:** app-only (client credentials), application permission `Mail.Read`, ideally scoped to the support mailbox. Reads the "ticket has been logged" acknowledgement email from `GRAPH_SUPPORT_MAILBOX` (default `supportdesk@lynkd.co.za`) to set `acknowledged_at`. If a ticket has no ack email, 0 updates is correct — not a defect.
- **Session & identity (Stage 8a/8b):** `getSessionProvider()` switches on the enabled provider set. `PortalSessionProvider` resolves the httpOnly session cookie against `portal_sessions` (SHA-256 stored; sliding idle + absolute cap + user/account-active checks **on every request**); no valid session → typed 401. `PlaceholderSessionProvider` (`PORTAL_ACCOUNT_SLUG`) is dev-only and refuses production without `ALLOW_PLACEHOLDER_AUTH=true`. Identity is **provider-agnostic** (Stage 8b, `docs/identity-providers.md`): every identity is `(identity_provider, issuer_namespace, subject_identifier)` — namespace pinned at provisioning, subject bound at first login, triple is the sole key thereafter. Adapters (`server/auth/providers/`) are pure claim normalisers emitting `AuthenticatedIdentity`/`IdentityDeny`; provider claim vocabulary (tid/oid/hd/sub) never leaks past them; bootstrap-trust rules live in `auth/policy.ts`. Entra login: multi-tenant auth-code + PKCE via msal-node. Middleware is cookie-presence UX only — **never** the security boundary. See `docs/auth.md`.

---

## 9. Configuration (env; all server-only)

Required: `DATABASE_URL` (pooled). ClickUp: `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_SUPPORT_FOLDER_ID` (+ optional `CLICKUP_CUSTOMER_FIELD_NAME`, `CLICKUP_SLA_PRIORITY_FIELD_NAME`, `CLICKUP_SYNC_OVERLAP_MS`, `CLICKUP_INCLUDE_ARCHIVED`). Graph: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (+ optional `GRAPH_SUPPORT_MAILBOX`, `GRAPH_SYNC_OVERLAP_MS`). Auth (Stage 8b): `AUTH_ENABLED_PROVIDERS` (comma set: `entra`|`google`|`placeholder`; placeholder exclusive; legacy `AUTH_PROVIDER` honoured as alias until Stage 8d), `AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`, `PORTAL_BASE_URL` (+ optional `AUTH_ENTRA_AUTHORITY`, `SESSION_IDLE_HOURS`, `SESSION_MAX_HOURS`, `ALLOW_PLACEHOLDER_AUTH`). Admin auth (Stage 10a): `AUTH_ADMIN_ENTRA_CLIENT_ID`, `AUTH_ADMIN_ENTRA_CLIENT_SECRET`, `AUTH_ADMIN_ENTRA_TENANT_ID` (separate single-tenant staff app). Jobs (Stage 8d): `CRON_SECRET` (guards `/api/jobs/*`; absent → fail closed). Publishing: `AUTO_PUBLISH_ENABLED` (default `false` → tickets park at `ready_for_customer`, not projected). Dev scope: `PORTAL_ACCOUNT_SLUG` (placeholder provider only). Tuning: `PGPOOL_MAX`, `PG_DISABLE_SSL`, `SCHEMA_SQL_PATH`. `env.ts` validates **per subsystem** (DB scripts must not require ClickUp/Graph/auth secrets).

---

## 10. Stage status & roadmap

Committed on `main`:

- **Stage 1** — DB foundations (client, config, migration, seed, verify) ✓
- **Stage 2** — ClickUp ingestion into the internal layer ✓
- **Stage 3** — Customer projection pipeline ✓
- **Stage 4** — Customer API + session scoping ✓
- **Stage 5** — Mock data removed; dashboard is live-only ✓
- **Stage 6** — Outlook acknowledgement ingestion (`acknowledged_at`) ✓
- **Stage 7** — Business-hours SLA engine + milestone computation (`e682a2f`) ✓
- **Stage 8a** — Microsoft Entra ID authentication: multi-tenant + tenant pinning, DB-backed sessions, ordered migrations, legacy probe-route removal, sanitised API error envelopes (see `docs/auth.md`) ✓
- **Stage 8b** — Provider-agnostic identity model (`identity_provider` / `issuer_namespace` / `subject_identifier`; adapters + central policy layer; behaviour-preserving Entra refactor — see `docs/identity-providers.md`) ✓

- **Stage 8c** — Google Workspace authentication: `providers/google.ts` (jose: discovery/PKCE/JWKS), parallel `/api/auth/google/*` routes via extracted handler factories, two-button login, `hd` namespace pinning (real-token validated), `email_verified` require-true policy ✓

- **Stage 8d** — Scheduled pipeline: advisory-lock orchestrator (`jobs/pipeline.ts`), `CRON_SECRET`-guarded `/api/jobs/{step}` (one step per invocation, staggered 15-min crons in `vercel.json`), bounded Outlook backfill (real-mailbox validated: 6,539 msgs / 7 invocations), expired-session cleanup, ops runbook `docs/operations.md` with measured baselines. Hosting decision: **Vercel Cron confirmed** (worst observed step 31 s vs 300 s budget) ✓
- **Stage 9a** — Shared tickets across customer accounts: `internal_ticket_business_units` junction as sole visibility source, projection fan-out per BU, honest-NULL origin, `MULTIPLE_BUSINESS_UNITS` quarantine removed, four executable `db:verify` invariants, permanent Vitest regression suite (unit + scratch-DB integration) — see `docs/shared-tickets.md` ✓
- **Stage 10a** — Internal admin realm: separate `admin_users` + `admin_sessions` (isolated from customer identities), separate single-tenant admin Entra app, realm-parametrised auth handlers (reuse the OIDC mechanics, not the identity), `/api/admin/*` read-only internal-layer API (stats, tickets, sync-runs, audit, quarantine), admin bootstrap script, structural realm isolation (distinct cookie + table; enforced in middleware + API + tests), import-boundary guard — see `docs/admin-portal.md`. Live-validated 2026-07-09 (real Entra sign-in; full 10-point realm-isolation matrix incl. session coexistence) ✓
- **Stage 10b** — Admin dashboard UI: six read-only console pages (`/admin` overview with registry-driven metric cards, tickets explorer with URL-as-filter-state, ticket detail with labelled customer-exposure panel, quarantine, sync runs, audit) over `/api/admin/*` only (client components + fetch — never the DB, never server imports); additive API extensions (filters/sort, `stats.sync` per-source watermarks, per-run quarantine counts, audit `entityLabel`, `/api/admin/reference`, `/api/admin/session`) with contracts defined once in `lib/admin/contracts.ts`; import boundary extended over the UI trees. Live-validated 2026-07-09 (browser walkthrough + curl matrix; shared-ticket fan-out validated structurally — no shared row in dev data) ✓

Next:

- **Auth carry-overs** (see docs/identity-providers.md §10): legacy `AUTH_PROVIDER` alias removal, bound-path provider assertion, multi-domain `hd` verification, runtime `MISSING_NAMESPACE` validation, Internal-vs-External Google OAuth strategy.
- Later phases: SLA analytics & reporting; admin & scaling features.
- **Account grouping (known future requirement):** SG / LAR / CUMi umbrella views (a group contact seeing all their brands' tickets). The current one-account-per-code model does not support it. Likely shape: nullable `account_group_id` + group-scoped portal users. Do not build preemptively. **When built, revisit `customer_tickets_account_number_key` UNIQUE(account_id, ticket_number)** — it would collide if one account ever holds two BUs both sharing a ticket (harmless today: one BU per account).
- **Non-Microsoft client identity:** if a client without an Entra tenant appears, add a second `SessionProvider` (Entra External ID preferred; magic-link revival for no-IdP clients). Do not adopt an identity broker preemptively.

---

## 11. Working style expected in this repo

- **Design first, then code.** For any feature, state: data-model impact, API design, UI design, and security considerations before implementing.
- **Evidence-based.** Tag conclusions as *Verified from code*, *Inferred*, or *Assumption*. Don't assert behaviour you haven't checked.
- **Incremental & cohesive.** One feature/layer at a time; one stage = one commit. Ask clarifying questions when requirements are unclear rather than guessing.
- **Security, scalability, maintainability first.** Never weaken the dual-layer boundary or tenant isolation for convenience.

---

## 12. Gotchas

- **Line endings (OneDrive):** this repo lives under OneDrive, which can silently rewrite files to CRLF. That produces whole-file diffs (equal insertions/deletions) that are pure noise. Detect with `git diff -w` (empty ⇒ line-ending churn only); discard with `git restore`. The repo uses **LF**. Consider a `.gitattributes` with `* text=auto eol=lf`.
- **Platform-specific `node_modules`:** if `node_modules` was installed on another OS, native deps (e.g. `esbuild` used by `tsx`) will fail to run. Run `npm ci` on the target platform.
- **`db.ts` / `env.ts` are server-only** and throw if imported in the browser. Keep client-safe helpers in `src/lib/**`.
- **SLA is time-dependent:** the engine full-scans open tickets each run (states advance PENDING → AT_RISK → BREACHED as the clock moves) but writes only on change. Run it on a schedule (Stage 8).
