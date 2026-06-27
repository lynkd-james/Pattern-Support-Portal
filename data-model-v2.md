# Pattern Support Portal — Data Model (V2, MVP)

**Supersedes:** `data-model-v1.md`.
**Status:** Design agreed — schema verified against PostgreSQL (applies cleanly under `ON_ERROR_STOP`: 16 tables, 17 explicit indexes, 20 foreign keys, 6 check constraints).
**Companion file:** `schema.sql` (executable DDL).

## What changed from V1 and why

Two decisions reshaped the model:

1. **Dual-layer content model (stricter).** Instead of one `tickets` table with runtime filtering, there are now two physically separate layers: an **internal** store (full fidelity, never customer-facing) and a **customer projection** (only approved, customer-safe fields). The portal reads *only* the projection. This removes the data-leak risk by construction — there is no code path that exposes raw ClickUp content, even accidentally.

2. **Simplified auth (MVP).** Entra ID / B2B federation is out. Customers log in by **magic link**. All access control is enforced at the **data layer** (account + business-unit scoping), not by identity federation. The guiding principle: *we are building a reporting window into our support system, not integrating identity systems between companies.*

## End-to-end data flow

```
Outlook (support mailbox)
  └─▶ Intake automation (Power Automate / lightweight)   [NEW — we build this]
        └─▶ ClickUp (internal ticket management — unchanged for agents)
              └─▶ Sync service        ──▶ PostgreSQL: INTERNAL layer
                    └─▶ Transformation/projection layer
                          └─▶ PostgreSQL: CUSTOMER projection
                                └─▶ Read-only Portal API ──▶ Next.js UI
```

ClickUp is the internal operational tool. **PostgreSQL is the system of record for the customer portal and SLA tracking** — the portal never queries ClickUp at request time.

## The two layers

### Internal layer (system of record, never exposed)

`internal_tickets` holds the full synced ticket: raw title/description, requester details, raw ClickUp status, all milestone timestamps, the computed SLA snapshot, and the **`visibility_state`** control. `internal_ticket_events` is the append-only canonical lifecycle timeline. Only the **`customer_summary`** field — an authored, deliberately customer-safe summary maintained in a dedicated ClickUp field — is ever eligible to become the customer-facing description.

### Customer projection (the only thing the portal reads)

`customer_tickets` contains **only** the agreed safe fields: `ticket_number`, account/business unit, sanitised `title`, customer-safe `description`, `priority`, `stage`, the milestone timestamps, and the safe SLA subset. `customer_ticket_timeline` is the filtered, customer-friendly timeline. Nothing else from the internal layer crosses the boundary.

### Eligible fields (the allow-list)

These are the *only* fields that may ever reach a customer:

> ticket number · account / business unit · title (sanitised) · description (customer-safe) · priority · status · timestamps (created, acknowledged, business review, resolved, closed) · SLA status · filtered timeline events

Everything else — internal description, requester PII, raw ClickUp status, internal comments, debugging/vendor notes — stays in the internal layer and is never mapped forward.

## Visibility lifecycle

`visibility_state` governs the boundary crossing. **Default is always `internal_only`.**

| State | Meaning | In projection? | Shown in portal? |
|---|---|---|---|
| `internal_only` | Default. Never projected. | No | No |
| `ready_for_customer` | Passed transformation/approval; staged. | No (staging) | No |
| `published` | Live. | Yes | **Yes** |
| `hidden_from_customer` | Previously visible, explicitly retracted. | Yes (retained for audit) | No |

The portal API filters strictly on `visibility_state = 'published'`. The `customer_tickets` table even has a check constraint allowing only `published` / `hidden_from_customer` rows to exist there — a row can only be in the projection if it was deliberately promoted.

## Authentication & isolation (MVP)

Magic-link login: a user enters their email, receives a one-time link (`magic_link_tokens`, single-use, short TTL, **hashed** — raw tokens are never stored), and on consumption gets a server-side session (`portal_sessions`, also hashed). `portal_users` belong to one account; scope is either `account_wide` or an explicit set of business units via `portal_user_business_units`.

**Isolation is enforced at the data layer regardless of how simple the login is.** Every projection row carries `account_id` + `business_unit_id`; every portal query is constrained to the authenticated user's account and granted BUs. Postgres Row-Level Security is recommended as defence-in-depth on `customer_tickets` and `customer_ticket_timeline`. No cross-account visibility is possible.

## Stored vs derived

| Data | Classification | Where |
|---|---|---|
| Raw synced fields, requester PII, raw status | Stored, canonical (internal only) | `internal_tickets` |
| Every status transition | Stored, canonical, immutable | `internal_ticket_events` |
| Status mappings, SLA policies, calendars | Stored, canonical config | config tables |
| Milestone timestamps, SLA due/state | Derived → stored snapshot (internal), recomputed by sync | `internal_tickets` |
| Customer-safe ticket + timeline | Derived → stored projection, written by transformation layer | `customer_tickets`, `customer_ticket_timeline` |
| MTTR/MTTA, breach rates, trends | Derived on demand (reporting views, later phase) | computed from internal events |

Rule: the projection is fully rebuildable from the internal layer; the internal layer is reconcilable from ClickUp. Nothing customer-facing is computed at request time.

## Keys & integrity highlights

UUID surrogate PKs (non-enumerable) on domain tables; `BIGINT` identity on append-only logs (`internal_ticket_events`, `audit_events`, `sync_runs`). `internal_tickets.clickup_task_id` is the idempotency key; `customer_tickets` is 1:1 with its internal ticket via a unique FK that is never exposed through the API. `ON DELETE RESTRICT` protects tenancy spines; `CASCADE` for owned children; `SET NULL` for soft references.

## Indexing

Portal read paths are served by **partial indexes on `visibility_state = 'published'`** (BU dashboard, account dashboard, SLA at-risk/breach), keeping the hot indexes small and exactly aligned with how the portal filters. Trigram GIN indexes on `title` and `ticket_number` power search. Internal indexes serve sync/reconciliation and transformation candidate selection. Auth tables index by user and by active session/token.

## Assumptions

1. Account → business unit is the tenancy hierarchy (Pepkor → Tekkie Town / DUNNS / CODE / Refinery / Ayana / SPCC).
2. One ClickUp task = one ticket (`clickup_task_id` is the idempotency key).
3. A **dedicated ClickUp field** carries the authored `customer_summary`; nothing else feeds the customer description.
4. BU attribution comes from a **structured ClickUp field**, not inference.
5. Customers are strictly read-only; the sync and transformation services are the only writers to their respective layers.
6. All times stored UTC, displayed in `Africa/Johannesburg`.
7. Contrib extensions (`pgcrypto`, `citext`, `pg_trgm`) are available — standard on Azure Database for PostgreSQL.

## Risks & open questions

| # | Risk / question | Recommendation |
|---|---|---|
| R1 | **Who promotes a ticket to `published`, and how?** Manual per-ticket, or a rule (e.g. auto-publish once `customer_summary` is filled)? | Decide the promotion workflow before building the transformation layer |
| R2 | **BU attribution from ClickUp** may be inconsistent → wrong-tenant exposure | Require a structured ClickUp custom field; quarantine unmapped/ambiguous tickets, never guess |
| R3 | **Magic-link security**: link interception, email account compromise, link sharing | Short TTL, single-use, hashed storage, bind session to a sensible lifetime; consider device/email re-verification |
| R4 | **PII & POPIA**: requester data lives in the internal layer; customer emails in auth | Pin Azure region (e.g. South Africa North); restrict internal layer access; retention/erasure policy |
| R5 | **Intake automation reliability** (Outlook → ClickUp): dropped/duplicate emails | Keep it simple but idempotent; dedupe on message id; alert on intake failures |
| R6 | **SLA business-hours/pause semantics** need sign-off | Model already supports pause flag + calendars; confirm rules before SLA build |
| R7 | **Reopened tickets** create multiple SLA cycles | V1 keeps current-cycle snapshot + full event history; add per-cycle table later if needed |

## Out of scope for V1 (deliberately)

Two-way ticketing/comments, real-time websockets, Entra/B2B identity federation, custom report builder, SCIM provisioning, multi-language, per-tenant theming beyond a logo. The intake automation stays lightweight (Power Automate / scripting), not a full integration platform.

## Agreed implementation order

1. Data model (this) →
2. Sync service (ClickUp → internal layer) →
3. Transformation / projection layer →
4. Magic-link authentication →
5. Read-only dashboard UI →
6. Ticket detail view.
