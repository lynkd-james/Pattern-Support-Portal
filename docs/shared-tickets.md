# Shared Tickets Across Customer Accounts (design — Stage 9a)

Status: **DESIGN FROZEN 2026-07-08** — approved; implementation in progress
(Stage 9a). If implementation reveals something unexpected, change the
implementation to fit this design unless a genuine flaw is discovered (which
requires reviewer sign-off to amend). Replaces the `MULTIPLE_BUSINESS_UNITS`
quarantine with intentional cross-account sharing.

Decision record:

1. **Option A approved**: one canonical internal ticket; a junction describing
   **visibility**; one customer projection row per visible tenant.
2. **Origin columns retained, honest-NULL semantics (final, 2026-07-08)**:
   `internal_tickets.account_id` / `business_unit_id` stay, redefined as the
   ticket's **origin**, and are **NULL for multi-BU tickets** — no invented
   origin. A single-BU ticket's origin is that BU (objectively real); a
   multi-BU ticket has no objectively correct origin in the ClickUp data, so
   none is fabricated. The junction is the **sole source of visibility**. If a
   genuine business definition of origin emerges later (requester domain,
   originating mailbox, …), populate it then — the model is upgradeable
   without schema change and without rewriting historical meaning.
3. **Trust model**: the ClickUp `Customer` label set IS the sharing decision.
   The portal does not second-guess it; no approval workflow. (Same trust
   already placed in single-BU attribution.)
4. **SLA**: global policies only for multi-BU tickets; per-BU policy
   resolution deferred until a real business requirement (documented
   constraint, enforced by the existing global-only seed).
5. API contract: **unchanged**. Clients receive the rows they are entitled to
   see and cannot tell whether a ticket is shared.

## 1. Model

```
internal_tickets                      -- ONE canonical row per ticket (unchanged id)
  account_id / business_unit_id      -- ORIGIN (see §2); NOT used for visibility
  ... milestones, SLA snapshot, visibility_state (one per ticket) ...

internal_ticket_business_units       -- VISIBILITY set (new junction)
  internal_ticket_id  FK
  business_unit_id    FK             -- implies its account
  PRIMARY KEY (internal_ticket_id, business_unit_id)

customer_tickets                     -- one row per (internal ticket x visible BU)
  UNIQUE (internal_ticket_id, business_unit_id)   -- was UNIQUE(internal_ticket_id)
  account_id / business_unit_id      -- the VIEWER scope of this row (per-row isolation)
```

Isolation is preserved byte-for-byte: every customer query stays an equality /
`ANY` filter on the reader's own `account_id` + BU set (invariant #2
untouched); an Ayana session reads the Ayana row, Refinery reads the Refinery
row, unrelated tenants see nothing. `customer/queries.ts` WHERE logic is
unchanged.

## 2. Origin semantics (final — honest NULL, no invented data)

ClickUp's `Customer` field is an **unordered label set**: the source system
does not encode which customer "originated" a ticket. Rather than fabricate a
deterministic origin (which readers would inevitably mistake for a business
fact and build reporting on), origin is only populated when it is
**objectively real**:

- **Single-BU ticket** → origin = that BU (represents reality; 100% of
  tickets today, so all existing data keeps its meaning).
- **Multi-BU ticket** → origin = **NULL** (unknown / not applicable).
- Origin is **internal reporting data only** — never used for visibility,
  filtering, or the customer API. Visibility comes exclusively from the
  junction.

**Transitions (audited, `change_source='SYNC'`, field `origin`):**
a single-BU ticket that gains a second label becomes multi-BU → origin set to
NULL (the single-origin claim no longer represents reality); a multi-BU ticket
whose label set shrinks to exactly one → origin set to that BU (objectively
single again).

**Structural side-benefit:** the SLA policy resolver matches per-account /
per-BU policies via the origin columns, so a NULL-origin (multi-BU) ticket can
only ever match **global** policies — decision 4 is enforced by construction,
not convention.

**Schema consequence:** `internal_tickets.account_id` / `business_unit_id`
become **nullable** in migration 0003 (currently NOT NULL).

## 3. Counting semantics (design exercise, answered up front)

**The rule: count TICKETS in the internal layer; count ENTITLEMENTS in the
customer layer; never sum customer-layer counts across scopes without
`DISTINCT` on the canonical id (`internal_ticket_id` / `ticket_number`).**

| Surface | Behaviour for a ticket shared by Ayana + Refinery |
| --- | --- |
| Customer dashboard (per account) | Ayana counts it once; Refinery counts it once. Each customer's view is self-consistent (SummaryCards already compute from the rows that account fetched — no change). |
| Internal dashboard / canonical reporting | **1 ticket** — count `internal_tickets`. Counts *by origin* sum to the canonical total (no double count); counts *by visibility* (via the junction) intentionally exceed it — label such metrics "exposure", never "tickets". |
| Future SG/LAR/CUMi group aggregation | "All Tickets" for a group contact shows it **once**: group-scoped reads must dedupe by canonical id (`DISTINCT ON (ticket_number)`) and count distinct canonical ids. Which BU label the single deduped row displays is a grouping-stage decision (origin / "multiple" / list). The dedupe rule is fixed NOW so grouping inherits it. |
| Search | Per-account search hits the account's own rows — at most one per ticket today (one BU per account). Group-scope search inherits the dedupe rule. Trigram indexes hold N copies of a shared title — negligible at any realistic N. |
| Exports (future) | Customer-facing export = that customer's rows (a shared ticket legitimately appears in each entitled customer's export). Internal export = canonical tickets + origin + visibility-set columns. |
| SLA analytics (later phase) | SLA state is computed once per canonical ticket — breach *counts* use the internal layer; per-customer SLA views show their row's copy of the same values. Cross-account aggregations must `COUNT(DISTINCT internal_ticket_id)`. |

## 4. Pipeline changes

- **resolve.ts (pure)**: returns the matched BU **set**; `MULTIPLE_BUSINESS_UNITS`
  reason removed; `BU_UNDETERMINED` (zero matches) retained — never-guess
  survives. `content_hash` includes the sorted BU set. Origin per §2:
  populated only when the set has exactly one member, else NULL.
- **clickupSync**: upsert junction rows (add new, remove de-listed); a changed
  set is a legitimate update, not `TENANCY_CHANGED` — that reason narrows to
  origin-integrity anomalies only (exact definition at implementation).
- **projection**: fan out one customer row per junction BU; **withdraw rows for
  de-listed BUs** (highest-risk new code — pure visibility layer extended and
  exhaustively unit-tested); timeline per row; internal `visibility_state`
  stays one-per-ticket (all fan-out rows publish/hide together; ADMIN lock
  unchanged); rebuild preserves ADMIN decisions as today.
- **SLA engine**: computes per canonical ticket, unchanged; policy resolution
  reads origin account/BU (global-only constraint per decision 4).
- **Scheduler**: no changes — same engines, same watermarks, same idempotency.

## 5. Migration (`0003`, idempotent, fresh-install-safe per house pattern)

1. Create junction; backfill one row per existing non-deleted ticket from the
   origin columns (existing single-BU tickets: identical observable behaviour).
2. `customer_tickets`: replace `UNIQUE(internal_ticket_id)` with
   `UNIQUE(internal_ticket_id, business_unit_id)`.
3. Origin columns: kept, made **nullable** (`DROP NOT NULL`);
   `COMMENT ON COLUMN` re-documents them as origin (NULL = multi-BU /
   not applicable; never a visibility input).
4. `schema.sql` parity.

### Executable design invariants (db:verify — the design in test form)

Four automated checks, run on every `db:verify` (CI gate) and in the stage
validation suite; together they encode almost the entire design:

1. **Coverage** — every (non-deleted) internal ticket has **≥ 1 junction row**.
2. **Single-BU origin** — a ticket with **exactly one** junction row has
   `origin (account_id, business_unit_id)` **NOT NULL** and equal to that
   junction row's BU (and its account).
3. **Multi-BU origin** — a ticket with **more than one** junction row has
   origin **NULL**.
4. **Projection subset** — **no `customer_tickets` row exists without a
   corresponding junction row** for the same `(internal_ticket_id,
   business_unit_id)` — the executable form of "the junction is the sole
   source of visibility", and the check that catches the highest-risk defect
   (a stale fan-out row surviving a withdraw).

All four are count-zero-violations queries in the existing `expectCount`
style, structural and volume-agnostic. (Secondary hygiene checks — e.g. no
junction row to a BU of an inactive account — finalised at implementation.)

**Projection lifecycle depends on whether the visibility scope still exists**
(amendment 2026-07-08, reviewer-approved under the freeze protocol; resolves an
internal contradiction between invariant 4 and 8a-era tombstone withdrawal).
The governing rule, stated over scopes rather than mechanisms:

- **Visibility scope exists** (junction row present) → a projection row **may**
  exist, published or hidden. Publication changes toggle it between published
  and hidden **tombstone** (8a-era behaviour, preserved).
- **Visibility scope no longer exists** (junction row gone; the BU was
  de-listed) → the projection row **must not** exist. It is hard-deleted (+
  timeline); the withdrawal survives in append-only `audit_events`.

This keeps invariant 9a-4 at full strength (a projection row always has a live
junction row) and is surgical: sibling rows are untouched and keep their ids.

> **Customer projection rows are cached derived state, not historical records.
> Historical evidence belongs exclusively in the append-only audit log.** This
> is why hard-deleting a de-listed row is not merely acceptable but preferable
> — and the standing precedent: if you want history, it goes in `audit_events`,
> never in stale projection rows. (Also stated in `docs/projection.md`.)

**5 & 6. Two projection guarantees** (first-class invariants alongside the four
DB checks; formal statement in `docs/projection.md`). A single "incremental ==
rebuild" property was found to over-reach — a hidden tombstone is *retained
historical state*, not a function of current source state, so a truncate-
rebuild (which deliberately discards history) can never reconstruct it. The
correct decomposition is two distinct guarantees:

**5. Projection determinism** — given the same internal state and visibility
model, projection is a **deterministic pure function**: an incremental
projection and a from-scratch (truncate-)rebuild produce **identical
customer-visible state and identical current derived state**. Retained
historical artifacts (hidden tombstones preserved for lifecycle reasons) are
**explicitly outside** this property. Comparison excludes surrogate ids and
provenance timestamps. *Proven by the truncate-rebuild integration case.* This
is the guard against stale fan-out rows, missed de-list removals, duplicates
and partial updates.

**6. Projection preservation** — where a projection row already exists and its
visibility scope continues to exist, incremental projection **preserves stable
row identity and lifecycle state** unless current source state requires a
change (surgical updates, never delete-and-recreate). *Proven by the
surgical-withdraw integration case (the surviving row keeps its id).*

Layer distinction that resolves the contradiction: a tombstone belongs to the
projection **lifecycle** (existing rows + current result → reconciliation),
not to the projection **function** (internal state → deterministic result).
Determinism validates the function; preservation validates the lifecycle.

Volumes: production has no data; dev has one ticket — migration cost at its
lifetime minimum (Stage 8b argument).

## 6. Risks

1. **Cross-tenant disclosure moves from fail-closed to intentional**: a
   two-label ticket publishes the same title/`customer_summary` into two
   customers' portals. Accepted trust model (decision 3); stated loudly here
   and in the provisioning/ops docs.
2. Projection withdraw-on-set-change is the concentrated defect risk —
   mitigated by pure-layer extraction + unit matrix before wiring.
3. ~~Origin convention~~ RESOLVED: honest-NULL origin adopted (no invented
   metadata); internal reports must treat NULL origin as "shared / not
   applicable", not as missing data.
4. Group-contact double-vision is a known, deferred consequence handled by the
   §3 dedupe rule when grouping ships.

## 7. Validation plan (implementation gate)

Pure suites for resolve-set + visibility/withdraw matrices; the four
executable design invariants (§5) proven both ways — green on conforming
data AND demonstrated to trip on planted violations (a ticket without junction
rows; a multi-BU ticket with non-NULL origin; an orphan projection row) per
the Stage 8a "demonstrate invariants, don't declare them" discipline;
migration idempotency incl. fresh-install; multi-BU end-to-end walk-through
with two real portal scopes (create a two-label ticket in ClickUp → both
accounts see it, third does not; remove one label → that account's row
withdraws, timeline removed, other unaffected); counting checks per §3; full
gates + auth/scheduler regression; external-review pass. One cohesive commit:
**Stage 9a**.

**The permanent regression suite (introduced during 9a; part of the product,
not of the stage):**

Framing decided at design review: this is **the project's regression suite
that happens to be introduced during Stage 9a** — not "the Stage 9a tests".
Stage documents are historical records; the suite is product, evolves with the
code, and is never scoped to a stage. Until now the pure validation suites
(Stage 8b identity 43 cases, Stage 8c Google 22 cases) lived as session-local
scripts — rigorous but ephemeral; they move into the repository here.

**Test runner: Vitest** (adopted now rather than postponed — the suite has
crossed from validation scripts to a long-lived regression asset, where a
standard runner's assertions, parameterised tests, fixtures, hooks,
filtering, watch mode and CI reporting collectively beat a bespoke harness
over the coming year). Structure:

```
web/tests/
  unit/                          npm test — pure, no DB, seconds
    identity.test.ts             8b/8c suites ported to Vitest
    resolver.test.ts             9a resolve-set matrix
    projection-visibility.test.ts  fan-out/withdraw decision matrix (pure)
  integration/                   npm run test:integration — scratch DB
    projection-equivalence.test.ts  ✓ single-BU ✓ shared ✓ withdrawal
                                    ✓ publish/unpublish ✓ incremental==rebuild
    (future: scheduler.test.ts, reporting.test.ts, ...)
  helpers/                       scratch-DB lifecycle (CREATE → migrate →
                                 fixtures → drop; the proven 8b pattern)
```

**Three categories of correctness, kept separate by design:**

- **Unit tests prove functions** (`npm test`).
- **Integration tests prove workflows** (`npm run test:integration`,
  isolated scratch database — TRUNCATE-based equivalence checking safe by
  construction).
- **`db:verify` proves database state** (the four §5 invariants + the
  existing structural checks) — deliberately NOT merged into the test suite.

All three run in every stage gate from 9a onward; every future projector
optimisation must satisfy the equivalence property automatically. The
equivalence case is intentionally the kind of test that almost never changes —
when it fails, something genuinely important broke.

**Equivalence regression test (invariant 5, executable):**

1. Run an incremental projection over a state that exercises fan-out AND
   withdrawal (a ticket that gained and a ticket that lost a BU since the
   last run).
2. Snapshot `customer_tickets` + `customer_ticket_timeline`.
3. Truncate both, then run a full rebuild.
4. **Determinism (invariant 5):** assert the CUSTOMER-VISIBLE / current derived
   surface is identical **modulo regenerated surrogates and provenance
   timestamps** — compared on the natural key `(internal_ticket_id,
   business_unit_id)` across every projected content column (ticket_number,
   title, description, priority, stage, milestones, SLA columns) and per-row
   timeline sequences (stage/label/occurred_at, ordered); excluded: surrogate
   `id`s, `published_at`, `last_projected_at` / `projected_at`, and retained
   tombstones (outside the determinism property by definition). A dedicated
   case demonstrates the tombstone is present after incremental and absent
   after truncate-rebuild — proving *why* it is excluded.
5. **Preservation (invariant 6):** a separate case captures a surviving row's
   id before a sibling BU is de-listed and asserts it is unchanged afterwards
   (surgical reconciliation, not delete-and-recreate).

Runs in validation environments only — TRUNCATE regenerates row `id`s that
the API exposes, so **live recovery remains `project:rebuild`** (upsert-based,
id-preserving); the truncate variant exists purely to prove equivalence.
