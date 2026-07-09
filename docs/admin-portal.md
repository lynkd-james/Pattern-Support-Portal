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

# Stage 10b — Admin dashboard UI (design, 2026-07-09)

Presentation layer over the live-validated Stage 10a admin API. Objective:
an internal operational console — fast, dense, read-only. The customer trust
boundary from Stages 8–10a is untouched.

## 10b invariants (restated as given, all four binding)

- **10b-1 Read-only UI** — no ticket/audit editing, no sync controls, no admin
  management, no customer mutations. Every pixel is a GET off `/api/admin/*`
  (the sole existing POST, `auth/logout`, is session hygiene, not data
  mutation).
- **10b-2 API boundary** — the UI never queries the database directly:
  `Admin UI → /api/admin/* → server/admin/* → DB`. Consequence (forced, not
  chosen): admin pages are **client components fetching over HTTP**. A server
  component importing `server/admin/queries` would satisfy the letter of "no
  SQL in the UI" while bypassing the validated API layer — so it is banned;
  `app/admin/**` page files are thin mounts only.
- **10b-3 Realm isolation stays structural** — admin UI code lives in
  `components/admin/**` + `lib/admin/**` + `app/admin/**`; customer UI code in
  `components/dashboard/**` + `lib/{api,types,display,summary}.ts`. No import
  edge in either direction; the Stage 10a import-boundary test is EXTENDED to
  cover the new UI trees (checklist item 1 — the boundary is tightened before
  any UI file exists).
- **10b-4 Internal truth** — pages display the internal layer. Customer
  projections appear only in explicitly-labelled panels ("Customer exposure").
- **10b-5 API additivity (promoted to invariant on review)** — every existing
  `/api/admin/*` endpoint keeps working for existing callers. Only: optional
  query parameters, additional response fields, new endpoints. No changed
  meanings. Stage 10b is zero-risk to the live-validated 10a surface.
  *One scoped exception, decided at contract-freeze time:* the three
  endpoints that today return raw snake_case DB rows with NO declared type
  and NO consumers (`tickets/[id]`, `sync-runs`, `audit`) are normalised to
  camelCase DTOs as their contracts are frozen — their only caller is the
  10a integration test (updated in the same commit). After 10b, additivity
  is absolute for all callers including the UI.

## Decisions (D1 ACCEPTED 2026-07-09; D2–D4 confirmed)

**D1 — additive read-only API extensions (ACCEPTED — Option A).** The requested
filter set exceeds the frozen 10a API. Missing server-side: customer
(account) filter, visibility-state filter, received/updated date ranges,
updated-date sort, audit search/filtering, and any endpoint enumerating
accounts/business-units for filter dropdowns, plus an endpoint identifying
the signed-in admin for the console header. Alternatives considered:
client-side filtering (REJECTED — wrong on paginated data: filters must
apply to the whole set, not the fetched page) or shrinking the 10b filter
set to what exists (honest but fails the brief). Proposal: **additive,
read-only, session-guarded extensions** — same layer, same discipline,
integration-tested like the 10a surface. No existing parameter or response
field changes meaning; the 10a validation stands. Scope:

1. `GET /api/admin/tickets` adds `accountId`, `visibility`
   (`published|ready_for_customer|hidden_from_customer|internal_only` —
   matches tickets having ≥1 projection row in that state — plus `none` =
   no projection rows), `receivedFrom`/`receivedTo` (`created_at` bounds),
   `updatedFrom`/`updatedTo` (`updated_at` bounds), `sort`
   (whitelist `createdAt|updatedAt` × `asc|desc`; default `createdAt:desc`).
   List items additionally return `updatedAt` (additive field).
2. `GET /api/admin/audit` adds `entityType`, `changeSource`, `entityId`,
   `search` (actor/field ILIKE), `beforeId` (keyset paging). Limit cap 500
   unchanged.
3. NEW `GET /api/admin/reference` → `{ accounts: [{id,name,slug,isActive}],
   businessUnits: [{id,accountId,name,slug,isActive}] }` — powers filter
   dropdowns (the runtime already resolves BUs live; this just exposes the
   list to staff, read-only).
4. NEW `GET /api/admin/session` → `{ email, displayName, role }` of the
   current admin (mirrors customer `/api/session` naming; header identity +
   401 probe for the client). `resolveAdminSession` already selects these
   columns — pure mapper, no new query.

Design-review additions (2026-07-09 critique; all additive, same discipline):

5. `GET /api/admin/stats` gains `sync: [{sourceSystem, status, finishedAt,
   cursor}]` — latest terminal run per source (`DISTINCT ON`). The earlier
   draft derived per-source watermarks client-side from `sync-runs?limit=20`;
   REJECTED on review — a bounded recent window can miss a source that has
   been failing for hours, which is precisely when the watermark matters.
   Per-source status is a server fact; the server states it.
6. `GET /api/admin/sync-runs` rows gain `quarantined`
   (`jsonb_array_length(details->'quarantines')`, 0 when absent). The
   sync-runs page spec requires a per-run quarantine count; the 10a endpoint
   does not expose `details`, so without this the column is unpopulatable.
7. Ticket detail: `SELECT it.*` becomes an explicit column list and the
   response gets a declared TypeScript contract (10a returned
   `Record<string, unknown>` — acceptable for a validation-era API, too weak
   to bind a UI to; silent column additions would otherwise change the wire
   shape without a type error anywhere). Semantics unchanged; shape frozen.
8. `GET /api/admin/audit` rows gain `entityLabel` (the `ticket_number` when
   `entity_type='internal_ticket'`, else null) — an audit viewer showing
   bare UUIDs is unreadable, and staff cannot be expected to resolve UUIDs
   by hand.

**D2 — no new dependencies.** Despite CLAUDE.md's stack line, shadcn/ui is
not installed; the customer UI is plain Tailwind with brand tokens. The admin
console follows suit: zero new packages.

**D3 — visual language.** Same dark brand palette as the customer portal
(consistent, already accessible) but unmistakably the admin console: an
"ADMIN" badge in the shell header, denser type scale, table-first layouts.
No decorative panels.

**D4 — enum lists as client constants.** `portal_stage`, `priority_level`,
`visibility_state` value lists are mirrored in `lib/admin/types.ts` for
filter dropdowns. This is structural schema vocabulary, not business config —
status mappings and SLA targets remain data-driven and are never hardcoded.

## Route map

| Route (page) | Guard | Purpose |
|---|---|---|
| `/admin/login` | public (middleware-exempt, unchanged) | one Entra button → `/api/admin/auth/login`; `?error=` handling as customer login |
| `/admin` | admin cookie (middleware) + API 401s | Overview: stat cards, sync watermarks, recent audit |
| `/admin/tickets` | 〃 | searchable/filterable internal ticket table |
| `/admin/tickets/[id]` | 〃 | full internal detail + labelled exposure panel |
| `/admin/quarantine` | 〃 | latest quarantines grouped by reason |
| `/admin/sync-runs` | 〃 | recent runs: status, duration, counts, watermark |
| `/admin/audit` | 〃 | chronological audit viewer, searchable/filterable |

Middleware needs **no change** (`/admin/:path*` already guarded; `/admin/login`
already exempt). The Stage 10a callback already lands on `/admin`.

## API usage map (which endpoint powers which screen)

| Screen | Endpoints consumed |
|---|---|
| Shell (every page) | `GET /api/admin/session` (identity badge); `POST /api/admin/auth/logout` (logout button) |
| Overview | `GET /api/admin/stats` (counts + per-source sync summary — one call); `GET /api/admin/audit?limit=8` |
| Tickets | `GET /api/admin/tickets?…` (all filters server-side); `GET /api/admin/reference` (dropdowns) |
| Ticket detail | `GET /api/admin/tickets/[id]` (ticket, timeline, projections, audit — one call) |
| Quarantine | `GET /api/admin/quarantine` |
| Sync runs | `GET /api/admin/sync-runs?limit=50` |
| Audit | `GET /api/admin/audit?…` (entity-type/source dropdowns are static enum constants — no reference call) |

## Component hierarchy

```
app/admin/
├── login/page.tsx                    # server-rendered static sign-in (no client JS)
├── (console)/layout.tsx              # mounts AdminShell around all console pages
│                                     # (route group so the shell — and its session
│                                     #  fetch — never wraps /admin/login; URLs unchanged)
├── page.tsx                          # → <OverviewPage/>
├── tickets/page.tsx                  # → <TicketsPage/>
├── tickets/[id]/page.tsx             # → <TicketDetailPage id/>
├── quarantine/page.tsx               # → <QuarantinePage/>
├── sync-runs/page.tsx                # → <SyncRunsPage/>
└── audit/page.tsx                    # → <AuditPage/>
components/admin/
├── AdminShell.tsx        "use client" — nav, ADMIN badge, identity, logout
├── OverviewPage.tsx      stat-card grid (registry-driven) + SyncStatusPanel + RecentAuditList
├── TicketsPage.tsx       TicketFilterBar + AdminTicketTable + Pager
├── TicketDetailPage.tsx  TicketSummaryPanel (identity/requester/content/SLA/ClickUp)
│                         + ExposurePanel (labelled customer projections, per-BU fan-out)
│                         + TimelinePanel + TicketAuditPanel
├── QuarantinePage.tsx    ReasonGroup (code, count, explanation, affected items)
├── SyncRunsPage.tsx      runs table (status, duration, seen/upserted/errors, cursor)
├── AuditPage.tsx         AuditFilterBar + AuditTable (keyset "load more")
└── ui/                   StatCard, Badge, Section, DataTable, EmptyState,
                          ErrorNotice, LoadingRows   (admin-local primitives)
lib/admin/
├── contracts.ts          THE named DTO contracts (refinement R1): AdminSession,
│                         AdminStats, AdminTicketSummary, AdminTicketDetail,
│                         AdminSyncRun, AdminAuditEvent, AdminReference, …
│                         Defined ONCE here (client-safe, zero imports);
│                         server/admin/queries.ts imports and RETURNS these
│                         types, API routes serialise them, the UI consumes
│                         them — one definition, no drift possible.
├── api.ts                fetch client: GET JSON, credentials, 401 → /admin/login
├── types.ts              enum value lists (D4) + quarantine-reason label map
│                         + URL filter-state codec
└── format.ts             pure: dates, durations, badge tones (frozen rules R5)
```

Naming note: everything admin-client-side sits under a path segment matching
the boundary regex (`/admin/`), so a customer-side import of any of it is
caught mechanically by the extended import-boundary test.

## Metrics extensibility (design requirement)

`OverviewPage` renders from a declarative card registry:
`{ key, label, value: (sources) => …, hint?, href? }` where `sources` =
`{ stats, recentAudit }`. Adding a future metric (received date, age,
first-response time, SLA remaining, overdue counts, volume, stage
distribution, BU/customer breakdown…) is: one additive field on an admin API
response → one registry entry (→ optionally one new panel). No restructuring;
the registry is the extension point, matching the doc's metrics model above.

**Honest exception — engineer workload.** `internal_tickets` has no assignee
column; ClickUp assignees are not ingested. That metric is NOT "one field +
one card" — it needs a sync-layer change (new column + ClickUp field mapping)
before the API can expose it. Flagged now so the metrics promise is not
silently overstated; everything else in the list above is derivable from the
internal layer today.

## Ticket detail — field placement (10b-4 in practice)

Internal panel (authoritative): ticket number, ClickUp task id + raw status
(+ non-interactive `app.clickup.com/t/{id}` reference link), origin
account/BU (honest-NULL shown as "— (shared)"), visibility BU set, requester
name/email, `title_internal`, `description_internal`,
`customer_summary` (labelled "customer-authored"), stage, priority,
lifecycle timestamps (created/acknowledged/business-review/resolved/closed),
SLA block (response/resolution due + states). Exposure panel (labelled):
one row per projection — BU slug, account, `visibility_state`,
`published_at`. Timeline: `internal_ticket_events` verbatim. Audit: the
ticket-scoped audit slice from the same response.

## Stage 10b — implementation checklist (FROZEN 2026-07-09)

1. **Boundary first** — extend `import-boundary.test.ts`: admin set +=
   `components/admin`, `lib/admin`; assert both directions still empty.
   (Runs red-green before any UI file exists.)
2. **D1 API extensions (accepted scope incl. review additions 5–8)** —
   `queries.ts` additive filters (tickets: account, visibility, date ranges,
   sort whitelist; audit: entityType/changeSource/entityId/search/beforeId
   + `entityLabel`), `stats.sync` per-source summary, `sync-runs`
   `quarantined` count, typed explicit-column ticket detail,
   `GET /api/admin/reference`, `GET /api/admin/session`; all behind
   `requireAdminSession()`; extend `admin-realm.test.ts` (filter matrix,
   new-field shapes, anonymous 401 + customer-cookie 401 on the two new
   endpoints).
3. **`lib/admin`** — `types.ts`, `api.ts` (401 → `/admin/login`), `format.ts`
   (pure; unit-tested).
4. **`/admin/login`** — static sign-in page (Microsoft button only).
5. **Shell** — `app/admin/layout.tsx` + `AdminShell` (nav, ADMIN badge,
   identity via `/api/admin/session`, logout POST).
6. **Overview** — card registry + SyncStatusPanel (from `stats.sync`) +
   RecentAuditList.
7. **Tickets** — filter bar (URL-synced state; note: `useSearchParams`
   requires a Suspense boundary in Next 14 client pages), dense table,
   pagination.
8. **Ticket detail** — panels per the field-placement section.
9. **Quarantine** — grouped by reason with explanation map; read-only.
10. **Sync runs** — table with computed duration + cursor/watermark column.
11. **Audit** — filterable table, keyset "load more".
12. **Gates** — tsc, lint, unit, integration, `db:verify`, build — all green
    in one run immediately before commit.
13. **Live validation** — browser matrix below.
14. **Docs** — this doc's status + CLAUDE.md §3/§10.
15. **Commit** — `Stage 10b: admin dashboard UI` on approval; push separately.

### 10b implementation status (2026-07-09)

Items 1–12 **complete**; gates green in one run (tsc; lint 0; unit 62 → 67
after the standalone P4 change; integration 22 — all ten 10a tests
unmodified; `db:verify`; build with all seven `/admin` pages route-level
code-split). Server-verifiable matrix points pre-driven: login page renders;
five console routes redirect without a cookie; `reference`/`session` 401
anonymously AND reject a customer cookie; filters bound live data;
`stats.sync` reports all five sources; customer regression + coexistence
re-confirmed. Item 13 browser walkthrough **PASSED 2026-07-09** (results
under the matrix below). Item 15 commit approved after the clean final gate.
Note: the standalone P4 change (`529d4a1`) landed between 10a and 10b;
the admin UI files arrive P4-aware (P1–P4 vocabulary, "No SLA" rendering).

## Item 13 — live validation matrix (executed 2026-07-09 — PASSED)

1. `/admin/login` renders; Entra sign-in round-trips into the console.
2. All six console pages render live data with an authenticated session.
3. Unauthenticated deep-link to every console route redirects to
   `/admin/login` (middleware) and every admin API call 401s (boundary).
4. The two NEW endpoints (`reference`, `session`) 401 anonymously and reject
   a customer cookie (the 10a cross-realm matrix re-run on the additions).
5. Ticket filters round-trip through the URL and change server results
   (verify against known dev-DB rows, incl. account + visibility + dates).
6. Ticket detail on a SHARED ticket shows the full BU fan-out and the
   labelled exposure rows; origin shows honest-NULL.
7. Quarantine page equals the latest clickup `sync_runs.details` content.
8. Customer portal regression: customer login + dashboard unaffected;
   coexistence (both cookies) still isolated both ways.
9. Admin logout from the shell clears only `pattern_admin_session`.
10. Build-output check: no admin component appears in customer page bundles
    (route-level code-split confirmed in `next build` output).

**Results (2026-07-09, dev, real Entra session):** PASSED. Points 1–5 and
7–9 confirmed in the browser (login page, all six console pages on live
data, unauthenticated deep-link redirects, filter round-trips through the
URL with refresh/Back, ticket detail with the labelled exposure panel,
quarantine empty-state, shell logout clearing only `pattern_admin_session`);
points 3/4/8 additionally curl-verified (anonymous 401s on every admin API
incl. the two new endpoints, customer-cookie rejection, customer-portal
regression + both-cookie coexistence); point 10 confirmed from `next build`
output. **Point 6 caveat (recorded honestly):** the dev DB holds no shared
ticket, so the multi-BU fan-out + "— Shared ticket" origin was validated
STRUCTURALLY (integration tests + the single ticket's detail rendering),
not on a live shared row; the projection fan-out itself was live-validated
in Stage 9a and the UI binding is the same component path.

## External-review checklist (10b)

- Invariant 10b-1: no mutating fetch anywhere in `components/admin/**` /
  `lib/admin/**` except the logout POST (grep-verifiable).
- Invariant 10b-2: no `server/**` import in any client file; `app/admin/**`
  pages are thin mounts; data enters only via `lib/admin/api.ts`.
- Invariant 10b-3: extended import-boundary test green; no cross-realm edge.
- Invariant 10b-4: projection data appears only in the labelled exposure
  panel; internal fields never presented as customer-visible.
- D1 diff review: `server/admin/queries.ts` changes are strictly additive
  (existing call sites and 10a tests unmodified and green).
- `sort` is a **map lookup to a fixed ORDER BY string** — user input is never
  interpolated into SQL (the existing LIMIT/OFFSET interpolation is bounded
  numerics; keep it that way).
- Date-range params are parsed/validated server-side (invalid dates → param
  ignored or 400, never passed raw to Postgres).
- No new dependencies in `package.json`.
- Error surfaces reuse `apiError.ts` envelopes; no internal detail leaked.
- Pagination/limit caps enforced server-side (page ≤ bounds, limit caps).
- All new endpoints behind `requireAdminSession()`; fail-closed 401.

## Refinements R1–R6 (final review round, accepted 2026-07-09)

**R1 — one contract module.** All response shapes are named DTOs defined once
in `lib/admin/contracts.ts` (see hierarchy above). `server/admin/queries.ts`
returns them, routes serialise them, the UI consumes them. A server-side
shape change that the UI doesn't know about becomes a compile error, not a
runtime surprise. (Type-only, client-safe module — importing it never pulls
server code toward the client.)

**R2 — additivity is invariant 10b-5** (see invariants; includes the scoped
snake_case→DTO normalisation exception for the three no-consumer endpoints).

**R3 — the URL is the filter state.** `/admin/tickets` (and `/admin/audit`)
read and write their filters via query params — bookmarkable, refresh-safe,
Back-button-correct, shareable between admins. Param vocabulary (frozen):
`q, customer (account slug), bu (BU slug), stage, priority, visibility,
published, shared, from, to, updatedFrom, updatedTo, page, sort
(created|updated × asc|desc)`. Slugs in the URL (readable); the client
resolves slug→id via `reference` data for the API call. React state derives
from the URL, never the reverse.

**R4 — loading behaviour is specified, not improvised.** A single
`useAdminData<T>` hook wraps every fetch and every page renders exactly four
states through shared primitives: **loading** (`LoadingRows` skeleton),
**empty** (`EmptyState` with a sentence saying why it might be empty),
**error** (`ErrorNotice` with the envelope message + retry button),
**populated**. No page invents its own variant.

**R5 — formatting rules (frozen).**
- Dates: `en-ZA`, `Africa/Johannesburg`, `dd MMM yyyy HH:mm` — same
  formatter behaviour as the customer portal.
- Recency: relative time in the cell, exact timestamp on hover (`title`).
- Durations (sync runs): `Xm Ys` / `Xs`.
- Priority/stage/SLA badges: the customer portal's brand tones (danger =
  breached/P1, warn = at-risk/P2, muted = P3), re-declared in
  `lib/admin/format.ts` — same visual language, no cross-realm import.
- Honest-NULL origin renders exactly **"— Shared ticket"** everywhere.
- Missing values render "—", never blank cells.

**R6 — Overview stays operational, not BI.** Exactly: internal tickets
(total/open/closed), published exposure, quarantined (latest sync), latest
sync status per source incl. failures surfaced first, recent audit activity.
Everything else lives on its dedicated page. No charts in 10b.

## Known limitations (accepted, not defects)

- ~~Audit search is by actor/field/entity, not ticket number~~ **Resolved at
  implementation:** the `entityLabel` LEFT JOIN (design addition 8) made
  ticket-number search free, so `search` covers actor/field/ticket-number —
  a strictly wider match than frozen, integration-tested.
- **Quarantined items are sync-report entries, not database tickets**
  (never-guess: nothing was fabricated), so the quarantine page shows
  `customId` + detail text with NO link to a ticket detail page — there is
  no ticket to link to. This is the model working as designed.
- **Metrics registry covers stats-shaped metrics**; time-series panels
  (daily volume, weekly trends) will additionally need one aggregate
  endpoint each when built — the page layout reserves space but 10b ships
  no charting.

## Open questions

None — Stage 10a decisions resolved 2026-07-08; Stage 10b decisions D1–D4
resolved 2026-07-09 (D1 accepted as Option A with the four review additions;
checklist frozen). This document is the architectural authority for Stages
10a–10c; changes require the same sign-off discipline used for the 8b/9a
design freezes.
