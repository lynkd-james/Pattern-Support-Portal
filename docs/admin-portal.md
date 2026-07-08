# Stage 10 — Internal Administration Portal (design)

Status: **APPROVED — architectural authority for Stage 10** (2026-07-08).
Implementation not started (gated per CLAUDE.md §11). All design decisions
resolved (below). Delivered in three cohesive sub-stages: **10a** auth +
sessions + admin API + internal queries (no UI); **10b** dashboard UI against
the stable API; **10c** SLA analytics, charts, reporting, exports.

## Purpose

A staff-only console for Pattern to see and troubleshoot the WHOLE system —
the **internal** layer (all tickets incl. shared/quarantined), sync history,
audit, SLA, and operational health. This is the deliberate, authorised inverse
of the customer portal: customers see a sanitised published projection of their
own account; **staff see everything**.

## Non-negotiable framing (how this coexists with the dual-layer model)

The customer portal is protected by invariants #1–#3 (customers never touch the
internal layer; every read is account+published-scoped; no client-supplied
scope). The admin portal **intentionally reads the internal layer** — which is
safe **only** if it is walled off completely from the customer surface:

1. **Separate identity + session realm** (approved decision — full isolation).
   Admin identities live in their own table with their own session cookie and
   their own resolver. A customer session can never authenticate to admin, and
   an admin session is never accepted by the customer API. No shared session
   store, no shared cookie.
2. **Separate route namespace.** All admin endpoints under `/api/admin/*`; all
   admin pages under `/admin/*`. The customer `getSessionProvider()` /
   `customer/queries.ts` path is untouched and never imported by admin code.
3. **Reuse the OIDC MECHANICS, not the identity.** The provider-agnostic
   adapters (`auth/providers/*`), claim normalisation, flow cookie, and the
   pure `decideLogin` engine are realm-agnostic and are reused. What differs
   per realm is the *user record*, *session store*, *cookie name*, and
   *authorisation payload* (customer → account/BU scope; admin → staff role).
   This honours "separate admin_users + session" without duplicating proven,
   security-critical OIDC code.

## Decisions (all resolved 2026-07-08)

1. **Sequencing:** production readiness (Phase 1, `docs/operations.md` runbook)
   proceeds in parallel; this design covers Stages 10a–10c.
2. **Admin identity: separate `admin_users` + `admin_sessions`** (full
   isolation from customer identities). Admins are still provisioned,
   namespace-pinned (Pattern's own Entra tenant), and deny-by-default — the
   same trust model, a separate table.
3. Admin API reads the internal layer directly; it must never share a code
   path with the customer API.
4. **Role granularity:** single `admin` role in V1; `role` column present so
   `support`/`operations`/`readonly`/`superadmin` can be added later **without
   a migration**.
5. **Login provider: Entra ID only** for staff (Pattern is Microsoft). The
   provider abstraction is already proven (8b/8c); adding Google for staff has
   no business value now and only adds config/test surface.
6. **Quarantine storage:** read from `sync_runs.details.quarantines` for V1;
   introduce a `quarantine_events` table only once production volume justifies
   history/reporting.
7. **Stage split:** 10a (auth + admin API + internal queries, no dashboard) →
   10b (dashboard UI) → 10c (analytics/SLA/reporting). Each independently
   reviewable and testable. 10a's goal: *can an authenticated Pattern admin
   securely retrieve internal data?*

## Architecture: hard namespace isolation (directive)

Admin and customer code are **fully separated; neither imports the other.**
Shared infrastructure only (db, env, logger, auth adapters/policy/flow,
sessionStore) lives in the common `src/server/**` + `src/lib/**` modules.
Concrete mapping onto the existing repo layout (customer code is NOT renamed —
that would be churn; admin gets its own parallel tree):

```
src/server/admin/        auth/  api-queries (queries.ts)  services/  types
src/app/api/admin/**     admin API routes
src/app/admin/**         admin pages (Stage 10b)
  ── may import ──>       src/lib/**, src/server/{db,env,logger,apiError},
                         src/server/auth/{providers,policy,flow,identity,sessionStore}
  ── must NOT import ──>  src/server/customer/**, src/app/api/{tickets,session}/**
```

CI-style guard (a unit test) asserts no `admin → customer` or
`customer → admin` import edge exists.

**The dashboard never queries the database directly.** Every admin page
consumes `/api/admin/*` only. That gives one authorization boundary, one place
for audit logging, testability, and future non-web clients.

## Phase 2 — Admin authentication & authorization

### Schema (migration `0004`)

```sql
admin_users
  id                 UUID PK
  email              CITEXT UNIQUE
  display_name       TEXT
  identity_provider  TEXT NOT NULL           -- reuse the 8b vocabulary
  issuer_namespace   TEXT                    -- pinned at provisioning (Pattern tenant)
  subject_identifier TEXT                    -- bound at first login
  role               TEXT NOT NULL DEFAULT 'admin'  -- 'admin' (V1); 'viewer'/'superadmin' later
  is_active          BOOLEAN NOT NULL DEFAULT TRUE
  last_login_at      TIMESTAMPTZ
  ...                -- same binding CHECK + partial unique (provider,namespace,subject)

admin_sessions       -- structurally identical to portal_sessions, separate table
  id, admin_user_id FK, session_token_hash, created_at, expires_at,
  last_seen_at, revoked_at, user_agent, ip
```

`db:verify` gains admin invariants mirroring the portal ones (active admin has
namespace; bound⇒pinned).

### Flow

Realm-parametrised reuse of `auth/handlers.ts`: `makeLoginHandler`/
`makeCallbackHandler` gain a `realm` ('customer' | 'admin') that selects the
user lookup, session store, and cookie. Routes `/api/admin/auth/{login,
callback,logout}`, cookie `pattern_admin_session`. `decideLogin` reused as-is
(an admin is an identity that must be provisioned + pinned + active); the admin
realm attaches `role` instead of account scope. Uniform info-free denial +
audit, exactly as Stage 8a. Middleware: `/admin/*` page cookie-presence
redirect to `/admin/login` (UX only; the API resolver is the boundary).

**Provisioning:** admins inserted into `admin_users` (inactive until tenant
GUID/hd captured), same runbook shape as `docs/auth.md`.

## Phase 2 — Admin API (`/api/admin/*`, staff-only, reads internal layer)

Every route resolves the admin session first (typed 401 otherwise), then reads
the internal layer through a new **read-only** `server/admin/queries.ts` (no
business logic — reuses stored engine outputs, mirroring how
`customer/queries.ts` is a thin mapper). Sanitised error envelopes reused.

| Endpoint | Returns |
| --- | --- |
| `GET /api/admin/stats` | dashboard-home metrics (counts below) |
| `GET /api/admin/tickets` | all internal tickets; filters (customer, BU, stage, priority, date, shared, published, source); search (number, title, requester email) |
| `GET /api/admin/tickets/:id` | full internal detail: metadata, timeline, ack, SLA clocks, visibility set (BUs), origin, audit history, projection status, per-ticket sync history |
| `GET /api/admin/sync-runs` | sync history across all `source_system`s |
| `GET /api/admin/audit` | `audit_events` (filterable by entity/field/source) |
| `GET /api/admin/quarantine` | quarantined tickets grouped by reason — **sourced from `sync_runs.details.quarantines`** (see note) |
| `GET /api/admin/sla` | SLA analytics aggregates |

**Note — quarantine has no table.** Quarantined tickets are *not* in
`internal_tickets`; they exist only in `sync_runs.details.quarantines` (JSON).
The quarantine endpoint aggregates the latest run's details. If richer
quarantine history/UX is needed, a future `quarantine_events` table is the
durable fix — flagged, not built in V1.

## Phase 3 — Admin dashboard (`/admin/*`, incremental)

Built in the order the roadmap gave: **Home** (counts: total/open/closed,
published/internal-only, shared, quarantined, SLA breaches, avg response/
resolution) → **Ticket Explorer** (the console: full column set, filters,
search) → **Ticket Detail** (everything the backend knows about one ticket) →
**Operations** (last/duration/failed per sync, watermarks, mailbox size,
last scheduler run) → **Quarantine** (by-reason, clickable) → **SLA analytics**
(response/resolution/compliance, by customer/BU, trend). Each is a thin bind
over the admin API; no business logic in the UI.

## Phase 4 — Reporting

Falls out of the admin API + a CSV/Excel export layer. Deferred; the metrics
model below makes it near-free.

## Metrics model (why adding a metric stays cheap)

The ingestion/projection/presentation separation means a new metric is: (1)
compute/store in the engine or derive in the admin query, (2) expose via the
admin API, (3) display. Candidate fields (logged/first-response/resolution
dates + durations, age, days-open, SLA countdown, overdue, reply/ack counts)
are mostly already in the internal layer or one aggregate away.

## Security review checklist (to run at implementation, per house discipline)

- Admin session never accepted by the customer API and vice versa (proven by
  test: a customer cookie → 401 on `/api/admin/*`; admin cookie → 401 on
  `/api/tickets`).
- Admin API never imports `customer/*`; customer API never imports `admin/*`.
- Admin routes read internal layer only behind a resolved admin session.
- Deny-by-default + namespace pinning for admins (reuse the 8b/8c invariants).
- Permanent Vitest coverage for the realm split and the admin query mappers.

## Open questions

None — all resolved in the Decisions section above (2026-07-08). This document
is the architectural authority for Stages 10a–10c; changes require the same
sign-off discipline used for the 8b/9a design freezes.
