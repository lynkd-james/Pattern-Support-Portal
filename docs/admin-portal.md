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
5. **Login provider: Entra ID only, as a SEPARATE single-tenant app
   registration** (distinct from the customer multi-tenant app). Different
   security domains deserve independent client IDs, secrets, and redirect URIs
   (`AUTH_ADMIN_ENTRA_*`, redirect `/api/admin/auth/callback`). Single-tenant
   means identities outside Pattern's tenant cannot even obtain a token for the
   admin app — an Entra-level defence layer before our code runs — with
   independent credential rotation, separate sign-in/consent audit, and room
   for admin-only Conditional Access/MFA later. The provider abstraction is
   already proven (8b/8c); Google for staff has no business value now.
6. **Admin bootstrap is explicit, never automatic.** The first administrator is
   inserted by a one-time controlled script/SQL helper into `admin_users`.
   **There is never automatic promotion by email domain or Entra tenant
   membership.** Tenant membership lets you *authenticate*; only an
   `admin_users` row makes you an *administrator*. Thereafter admins manage
   admins through the admin interface (future stage). This preserves the core
   distinction: authentication proves identity; the table grants authority.
7. **Quarantine storage:** read from `sync_runs.details.quarantines` for V1;
   introduce a `quarantine_events` table only once production volume justifies
   history/reporting.
8. **Stage split:** 10a (auth + admin API + internal queries, no dashboard) →
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

## Realm-isolation invariant (first-class, enforced in three places)

**A session is valid only within the realm that created it.**

```
customer session → customer routes only
admin session    → admin routes only
no fallback · no automatic upgrade · no shared middleware
```

This is the admin-era equivalent of the Stage 9 tenant-isolation invariants.
Enforced, and tested, in three places:

1. **Middleware** — separate matchers; the admin cookie name
   (`pattern_admin_session`) is distinct from the customer one
   (`pattern_portal_session`); each matcher only ever inspects its own realm's
   cookie. No shared middleware branch.
2. **API authorization** — `/api/admin/*` resolves ONLY the admin session
   store; `/api/*` customer routes resolve ONLY the customer session store.
   A cookie from the wrong realm is not a fallback path — it is simply absent
   from the store it's checked against → typed 401.
3. **Automated tests** — a customer cookie → 401 on every `/api/admin/*` route;
   an admin cookie → 401 on `/api/tickets` + `/api/session`. Both directions,
   permanent Vitest coverage.

Because the two realms use distinct cookie names AND distinct session tables,
cross-realm acceptance is structurally impossible, not merely policed — but the
tests assert it anyway (defence-in-depth + regression tripwire).

## Stage 10a — FROZEN implementation checklist (2026-07-08)

Implementation authority for 10a. One cohesive commit. Order:

1. **Migration `0004`** — `admin_users` (id, email citext unique, display_name,
   identity_provider, issuer_namespace, subject_identifier, role NOT NULL
   DEFAULT 'admin', is_active, last_login_at, timestamps; binding CHECK
   bound⇒pinned; partial unique `(provider, namespace, subject)`); `admin_sessions`
   (structurally identical to `portal_sessions`, separate table); schema.sql
   parity; idempotent + fresh-install-safe (house pattern).
2. **`db:verify` additions** — active admin has `issuer_namespace`;
   bound⇒pinned (mirrors the portal auth invariants). Proven both ways.
3. **Admin bootstrap** — a one-time `scripts/admin/bootstrap.ts` (dotenv, like
   the other scripts) inserting the first `admin_users` row from explicit args
   (email + Pattern tenant GUID + display name; `role='admin'`, activated once
   the GUID is captured). NEVER auto-promotes by domain/tenant. Documented in
   the doc's provisioning section. This is the only way to create the first
   admin; all subsequent admin management is a future stage.
4. **Admin identity layer** — reuse the provider abstraction; add a `realm`
   ('customer' | 'admin') parameter to `auth/handlers.ts` selecting user lookup
   + session store + cookie; `decideLogin`/adapters/policy/flow reused
   unchanged. `server/admin/` owns the admin-specific lookup + session store.
5. **Admin authentication** — `/api/admin/auth/{login,callback,logout}`;
   `pattern_admin_session` cookie; `AdminSessionProvider` resolving the admin
   session (sliding idle + absolute cap + admin/active checks on every request,
   mirroring Stage 8a). Uses the SEPARATE single-tenant admin Entra app
   (`AUTH_ADMIN_ENTRA_*`, `requireAdminAuth()`).
6. **Admin authorization + realm-isolation invariant** — require admin session
   on `/api/admin/*`; deny customer cookies there; deny admin cookies on
   customer routes; enforce in middleware + API + tests (section above).
7. **Admin query layer** — `server/admin/queries.ts`, read-only internal-layer
   mappers, no business logic (mirrors `customer/queries.ts`).
8. **Admin API** — `/api/admin/{stats,tickets,tickets/:id,sync-runs,audit,
   quarantine}` (SLA analytics deferred to 10c). Quarantine from
   `sync_runs.details.quarantines`.
9. **Import-boundary guard** — unit test asserting no `admin ↔ customer` import
   edge (both directions).
10. **Unit tests** — admin identity/decision reuse, realm cookie strictness.
11. **Integration tests** — admin auth + admin queries against a scratch DB;
    cross-realm 401 both directions.
12. **Browser validation** — bootstrap + sign in a real admin (Pattern Entra
    tenant), retrieve internal data; confirm a customer session is rejected by
    `/api/admin/*` and vice versa. (Live external-system step, like 8c/9a.)
13. **External review** — realm isolation, internal-layer exposure behind
    admin-only auth, no shared code path, invariant coverage.
14. **Documentation** — update this doc's status to implemented; CLAUDE.md
    §3/§8/§10; `.env.example` (`AUTH_ADMIN_ENTRA_*`).
15. **Commit** — `Stage 10a: admin authentication, sessions and internal API`,
    on approval; push separately.

### 10a implementation status (2026-07-08)

Items 1–11, 13–14 **complete and validated** (non-live): migration 0004 +
schema parity + `db:verify` 24/24; bootstrap script; realm-parametrised
`auth/handlers.ts` (customer flow byte-for-byte preserved — 49 customer tests
green); separate single-tenant admin Entra adapter via the msal per-app
factory; `/api/admin/{auth/*,stats,tickets,tickets/:id,sync-runs,audit,
quarantine}`; `AdminSessionProvider`; middleware split; import-boundary guard;
unit 52 + integration 12 (incl. structural cross-realm store isolation);
tsc/lint/build clean. HTTP smoke: admin API 401 without a session, a valid
CUSTOMER cookie rejected by `/api/admin/*` (401), customer routes unaffected.
Item 12 (live browser sign-in) **PASSED 2026-07-09** — see the matrix results
below. Item 15 (commit) approved after the clean live run.

### Item 12 — live validation matrix (executed 2026-07-09 — PASSED 10/10)

Endpoint-accurate (there is no `/api/customer/*`; the customer API is
`/api/tickets`, `/api/session`):

1. Admin Entra sign-in succeeds (separate single-tenant app).
2. `admin:bootstrap` authorised the identity (first admin).
3. `pattern_admin_session` is issued.
4. `/api/admin/*` accepts the admin session.
5. Customer endpoints (`/api/tickets`, `/api/session`) REJECT the admin session (401).
6. `/api/admin/*` REJECTS a valid customer session (401).
7. Admin logout destroys ONLY `pattern_admin_session`.
8. The customer session remains valid throughout.
9. Customer sign-in still functions normally after the admin flow.
10. **Session coexistence** (demonstrates separate cookies + stores, not just
    asserts it): with BOTH cookies live in one browser — admin logout removes
    only `pattern_admin_session` (customer portal stays authenticated); then
    customer logout removes only `pattern_portal_session` (admin console stays
    authenticated until its own logout).

**Results (2026-07-09, dev, real Lynkd-tenant Entra sign-in):** all 10 points
passed. Highlights: (1) admin OIDC start uses the pinned single-tenant
authority (customer app remains `/organizations`); (2) bootstrap row created
unbound, subject bound at first login (audit_events `entity_type=admin_user`,
`change_source=ADMIN`); (3–4) `pattern_admin_session` issued and accepted by
`/api/admin/*` (live internal-layer stats returned); (5–6) cross-realm tokens
rejected 401 in BOTH directions and in EITHER cookie slot (`/api/tickets`,
`/api/session`, `/api/admin/*`); (7–10) with both cookies live simultaneously,
each realm's API served 200, admin logout cleared only
`pattern_admin_session` (customer survived) and customer logout cleared only
`pattern_portal_session` (admin survived) — both logout orders exercised;
revoked tokens dead server-side on replay. Committed as one
implementation+validation unit (Option B); push held for separate approval.

Goal restated: *an authenticated Pattern admin can securely retrieve internal
data, and no session crosses the realm boundary.*

## Deferred note — realm-neutral decision result (for a future third realm)

`decideLogin` currently returns customer-oriented fields (`accountId`,
`accountActive`); the admin realm adapts them (admin id as `accountId`,
`accountActive = true`). Fine for two realms. **If a THIRD realm is ever
introduced** (support agents, API clients, …), evolve the decision result into
a realm-neutral identity result (e.g. `{ userId, admit, bind }` plus a
realm-supplied authorization payload) rather than stretching the customer shape
further. Not worth changing for 10a.

## Open questions

None — all resolved in the Decisions section above (2026-07-08). This document
is the architectural authority for Stages 10a–10c; changes require the same
sign-off discipline used for the 8b/9a design freezes.
