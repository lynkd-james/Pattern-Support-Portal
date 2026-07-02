# Transformation / Projection Layer

How the **internal layer** (`internal_tickets`, `internal_ticket_events`) becomes
the **customer projection** (`customer_tickets`, `customer_ticket_timeline`) that
the portal reads. (Stage 3.)

## Principles

- **The customer layer is derived, never canonical.** It can always be rebuilt
  from the internal layer; no customer-facing row is a source of truth.
- **Deterministic & idempotent.** Re-running produces the same result; safe to
  run repeatedly.
- **No internal data leaks.** Only explicitly approved, customer-safe fields are
  projected. Internal comments and internal-only events never cross over.
- **No duplicated business logic.** Raw-status → portal-stage mapping lives only
  in the sync engine. The projection works from the already-mapped
  `current_stage` / event `to_stage`, plus the visibility rules below.

## Visibility model

`internal_tickets.visibility_state` drives projection. Target state is computed
per ticket, in order:

1. **ADMIN-locked** → keep current state. If the most recent `visibility_state`
   change in `audit_events` for the ticket has `change_source = 'ADMIN'`, the
   transform does not override it. *This is what makes a rebuild preserve
   explicit human decisions.*
2. **Soft-deleted** (`deleted_at` set) → `hidden_from_customer`.
3. **Cancelled** (`clickup_raw_status = 'cancelled'`) → `hidden_from_customer`.
   *(`done` is shown as `CLOSED`; `cancelled` is hidden. This is the only place
   the projection inspects raw status, and only to decide visibility.)*
4. **`AUTO_PUBLISH_ENABLED = true`** → `published`.
5. **`AUTO_PUBLISH_ENABLED = false`** (production default) → `ready_for_customer`.

Mapping to the customer layer:

| Target visibility      | `customer_tickets` effect                              |
| ---------------------- | ------------------------------------------------------ |
| `published`            | upsert a live row (`visibility_state = 'published'`)   |
| `ready_for_customer`   | not projected; existing row (if any) → `hidden`        |
| `internal_only`        | not projected; existing row (if any) → `hidden`        |
| `hidden_from_customer` | existing row → `hidden`; timeline removed              |

The portal lists only rows where `customer_tickets.visibility_state = 'published'`.
Because the `customer_tickets` CHECK allows only `published` / `hidden_from_customer`,
`ready_for_customer` exists solely on the internal record (staged, not projected).

> **AUTO_PUBLISH_ENABLED** is the production default `false`. Changing it is
> reconciled **automatically**: the engine records the flag value used in each
> run, and when it differs on the next run it scans the whole internal layer once
> to re-evaluate visibility. No manual rebuild is needed for a config change —
> `rebuild` is reserved for recovery.

## Field mapping (`internal_tickets` → `customer_tickets`)

| Customer field                          | Source                                             |
| --------------------------------------- | -------------------------------------------------- |
| `ticket_number`, `priority`, `stage`    | `ticket_number`, `priority`, `current_stage`       |
| `title`                                 | `title_internal` (treated customer-safe in V1)     |
| `description`                           | `customer_summary` **only** (null until authored)  |
| `created/acknowledged/business_review/resolved/closed_at` | same milestone columns           |
| `response/resolution_due_at`, `*_sla_state` | same columns (NOT_APPLICABLE / null until SLA stage) |
| `account_id`, `business_unit_id`        | denormalised from internal (tenancy)               |

`description` is deliberately **not** taken from `description_internal` — only an
authored, customer-safe `customer_summary` may become the customer description.

## Timeline (`internal_ticket_events` → `customer_ticket_timeline`)

- Only **customer-visible** events are projected. Customer-visibility is
  **computed** during projection, not stored: every recorded event is a
  portal-stage transition (already the customer-facing taxonomy), so all qualify.
  The projection **never writes** to `internal_ticket_events` — the internal
  layer is immutable here.
- Each timeline row carries a friendly `label` from the stage (`NEW → "Logged"`,
  `BUSINESS_REVIEW → "In business review"`, etc. — see `projection/labels.ts`).
- Rebuilt per ticket via delete-and-reinsert inside a transaction (idempotent).
- Hidden/withdrawn tickets have their timeline removed.

## Modes

- **Incremental** (`npm run project`): projects internal tickets with
  `updated_at` after the stored watermark.
- **Rebuild** (`npm run project:rebuild`): forces a full re-projection of every
  internal ticket, preserving ADMIN-locked visibility. Reserved for **recovery**
  (e.g. suspected projection drift) — routine config changes reconcile on their
  own via incremental runs.

First publication is detected with an explicit existence check on
`customer_tickets` (no reliance on PostgreSQL's `xmax` system column).

Both paginate by `(updated_at, id)`, advance a watermark stored in
`sync_runs.cursor` (`source_system = 'transform'`), and freeze the watermark at
the first failure so failed tickets are retried next run.

## Auditing

`audit_events` (`change_source = 'TRANSFORM'`, `actor = 'transform'`) records:

- internal `visibility_state` transitions,
- first publish of a customer ticket (`field = 'projection'`),
- withdrawal of a customer ticket (`published → hidden_from_customer`).

## Run accounting

Every run writes a `sync_runs` row (`source_system = 'transform'`) with status,
counts (processed / published-new / published-updated / withdrawn / noop /
visibility-changes / failed), the watermark, and structured `details`.
