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
    │   └── sla/               # run.ts (SLA engine → chained projection)
    └── src/
        ├── middleware.ts      # cookie-presence page redirects — UX ONLY, never the security boundary
        ├── app/               # App Router: pages (/dashboard, /login) + /api routes
        │   └── api/           # tickets, tickets/[id], session, auth/{login,callback,logout}
        ├── components/dashboard/  # DashboardPage, FilterBar, SummaryCards, TicketTable
        ├── lib/               # client-safe: api.ts, types.ts, display.ts, summary.ts, authCookies.ts
        └── server/            # SERVER-ONLY (never import into client code)
            ├── db.ts, env.ts, logger.ts, apiError.ts (sanitised error envelopes)
            ├── clickup/       # client.ts, types.ts
            ├── graph/         # client.ts, types.ts (Microsoft Graph app-only)
            ├── sync/          # resolve.ts (pure), clickupSync.ts, ackEmail.ts, outlookSync.ts
            ├── projection/    # transform.ts, visibility.ts (pure), labels.ts
            ├── sla/           # calendar.ts (pure), sla.ts (pure), compute.ts (engine)
            ├── auth/          # identity.ts + policy.ts (pure), provider.ts, flow.ts, sessionStore.ts, audit.ts
            │   └── providers/ # per-provider adapters: entra.ts, entraClaims.ts (pure), msal.ts
            └── customer/      # session.ts (factory), portalSession.ts, queries.ts (read-only)
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
7. **Never guess. Quarantine instead.** Ambiguous tenancy or classification (missing custom id, undetermined/multiple business units, missing/unsupported SLA priority, unmapped status, changed tenancy) → the ticket is quarantined, not fabricated. See `sync/resolve.ts` `QuarantineReason`.
8. **Config is data-driven, never hardcoded.** Status mappings live in `status_mappings`; SLA targets live in `sla_policies`. Engines read them — they must not embed business values. The SLA engine is **request-type agnostic**: it consumes only the resolved policy (e.g. A&R requests are handled as standard P2 purely via their priority label, with zero special-casing in the engine).
9. Syncs are **incremental + idempotent**, driven by a watermark in `sync_runs` (one `source_system` per subsystem: `clickup`, `outlook`, `transform`, `sla`). Upserts are keyed by `clickup_task_id`; first-write-wins on milestones.
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

# Ingestion & pipeline (manual entrypoints for now; scheduled in Stage 8)
npm run sync:clickup      # ClickUp → internal_tickets
npm run sync:outlook      # supportdesk mailbox → internal_tickets.acknowledged_at
npm run sla               # SLA engine → then CHAINS the projection
npm run project           # transform internal → customer (incremental)
npm run project:rebuild   # full re-projection (recovery; preserves ADMIN visibility decisions)

# App
npm run dev | build | start | lint
```

**Staged, review-first delivery.** Work proceeds one stage at a time; **each stage is a single cohesive commit**. Design first → verify dependencies → implement cleanly → typecheck (`tsc --noEmit`) → validate → commit. Commit message convention: `Stage N: <summary>` (see `git log`).

**Do not** expand scope, split a stage's cohesive commit, or make architectural changes without a demonstrated defect. Prefer simplicity over over-engineering in V1.

---

## 7. Data model (see `schema.sql` for the authoritative DDL)

**Enums:** `priority_level` (`P1`–`P3`; P4 not used), `portal_stage`, `sla_state` (`NOT_APPLICABLE`/`PENDING`/`AT_RISK`/`MET`/`BREACHED`), `visibility_state` (`internal_only`/`ready_for_customer`/`published`/`hidden_from_customer`), `audit_source`, `sync_status`.

**Tenancy:** `accounts` → `business_units`. Current model: **each ClickUp `Customer` code is its own independent client = one account + one business unit**, where `business_units.slug` = the ClickUp `Customer` code (the sync's attribution key). `status_mappings` and `sla_policies` are **global** (`account_id`/`business_unit_id` NULL). The legacy single `pepkor` account is retired via `is_active = FALSE` (non-destructive). The runtime resolves business units live — onboard a new client with a seed row / admin INSERT, not by editing engine code. `db:verify` uses **structural invariants** (e.g. "every active account has ≥1 active BU", "no duplicate active slug"), **not fixed client counts**.

**Core tables:** `internal_tickets`, `internal_ticket_events`, `customer_tickets`, `customer_ticket_timeline`, `status_mappings`, `sla_calendars`, `sla_calendar_holidays`, `sla_policies`, `portal_users`, `portal_user_business_units`, `magic_link_tokens`, `portal_sessions`, `audit_events`, `sync_runs`.

**SLA model (Stage 7).** Business-hours only, Mon–Fri 08:00–17:00 **Africa/Johannesburg** (UTC+2, no DST). Response = `created_at → acknowledged_at`; Resolution = `created_at → closed_at`. No pause behaviour. Seeded global targets: **P1 2h/24h, P2 8h/48h, P3 24h/120h** (business hours), **at-risk threshold 80%**. States: milestone reached → `MET`/`BREACHED`; else `BREACHED` if past due, `AT_RISK` past the threshold, else `PENDING`; no matching policy → `NOT_APPLICABLE`. Values live in `sla_policies` only.

---

## 8. Integration notes

- **ClickUp:** REST v2. Token is sent **raw** in the `Authorization` header (no `Bearer`). Archived tickets are retrieved **per-list** via `/list/{id}/task?archived=true` (the `/team/{id}/task` endpoint has no `archived` param) — controlled by `CLICKUP_INCLUDE_ARCHIVED` (default true). `CLICKUP_TEAM_ID` and `CLICKUP_SUPPORT_FOLDER_ID` are **required** (fail fast; no fallbacks).
- **Microsoft Graph:** app-only (client credentials), application permission `Mail.Read`, ideally scoped to the support mailbox. Reads the "ticket has been logged" acknowledgement email from `GRAPH_SUPPORT_MAILBOX` (default `supportdesk@lynkd.co.za`) to set `acknowledged_at`. If a ticket has no ack email, 0 updates is correct — not a defect.
- **Session & identity (Stage 8a/8b):** `getSessionProvider()` switches on the enabled provider set. `PortalSessionProvider` resolves the httpOnly session cookie against `portal_sessions` (SHA-256 stored; sliding idle + absolute cap + user/account-active checks **on every request**); no valid session → typed 401. `PlaceholderSessionProvider` (`PORTAL_ACCOUNT_SLUG`) is dev-only and refuses production without `ALLOW_PLACEHOLDER_AUTH=true`. Identity is **provider-agnostic** (Stage 8b, `docs/identity-providers.md`): every identity is `(identity_provider, issuer_namespace, subject_identifier)` — namespace pinned at provisioning, subject bound at first login, triple is the sole key thereafter. Adapters (`server/auth/providers/`) are pure claim normalisers emitting `AuthenticatedIdentity`/`IdentityDeny`; provider claim vocabulary (tid/oid/hd/sub) never leaks past them; bootstrap-trust rules live in `auth/policy.ts`. Entra login: multi-tenant auth-code + PKCE via msal-node. Middleware is cookie-presence UX only — **never** the security boundary. See `docs/auth.md`.

---

## 9. Configuration (env; all server-only)

Required: `DATABASE_URL` (pooled). ClickUp: `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_SUPPORT_FOLDER_ID` (+ optional `CLICKUP_CUSTOMER_FIELD_NAME`, `CLICKUP_SLA_PRIORITY_FIELD_NAME`, `CLICKUP_SYNC_OVERLAP_MS`, `CLICKUP_INCLUDE_ARCHIVED`). Graph: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (+ optional `GRAPH_SUPPORT_MAILBOX`, `GRAPH_SYNC_OVERLAP_MS`). Auth (Stage 8b): `AUTH_ENABLED_PROVIDERS` (comma set: `entra`|`google`|`placeholder`; placeholder exclusive; legacy `AUTH_PROVIDER` honoured as alias until Stage 8d), `AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`, `PORTAL_BASE_URL` (+ optional `AUTH_ENTRA_AUTHORITY`, `SESSION_IDLE_HOURS`, `SESSION_MAX_HOURS`, `ALLOW_PLACEHOLDER_AUTH`). Publishing: `AUTO_PUBLISH_ENABLED` (default `false` → tickets park at `ready_for_customer`, not projected). Dev scope: `PORTAL_ACCOUNT_SLUG` (placeholder provider only). Tuning: `PGPOOL_MAX`, `PG_DISABLE_SSL`, `SCHEMA_SQL_PATH`. `env.ts` validates **per subsystem** (DB scripts must not require ClickUp/Graph/auth secrets).

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

Next:

- **Stage 8d** — Scheduled ~15-min pipeline: advisory-lock orchestrator, `CRON_SECRET`-guarded jobs route runnable **one step per invocation**, expired-session cleanup. Plus auth carry-overs (see docs/identity-providers.md §10): legacy `AUTH_PROVIDER` alias removal, bound-path provider assertion, multi-domain `hd` verification, runtime `MISSING_NAMESPACE` validation, Internal-vs-External Google OAuth strategy. Hosting decision pends a worst-case duration measurement (Vercel Cron if it fits with headroom, else recommend Azure-hosted).
- Later phases: SLA analytics & reporting; admin & scaling features.
- **Account grouping (known future requirement):** SG / LAR / CUMi umbrella views (a group contact seeing all their brands' tickets). The current one-account-per-code model does not support it. Likely shape: nullable `account_group_id` + group-scoped portal users. Do not build preemptively.
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
