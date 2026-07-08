# Operations — Scheduled Pipeline (Stage 8d)

Runbook for the Vercel Cron-driven pipeline. Design/measurement background:
Stage 8d report; auth operations live in `docs/auth.md`.

## What runs, when

Five `CRON_SECRET`-guarded endpoints, **one pipeline step per invocation**,
staggered so the full chain completes inside every 15-minute window
(`vercel.json` is the source of truth):

| Step | Path | Schedule (UTC) | Engine |
| --- | --- | --- | --- |
| ClickUp sync | `/api/jobs/clickup` | `:00 :15 :30 :45` | `sync/clickupSync.ts` |
| Outlook ack sync | `/api/jobs/outlook` | `:02 :17 :32 :47` | `sync/outlookSync.ts` (bounded: 20 pages/run) |
| SLA engine | `/api/jobs/sla` | `:04 :19 :34 :49` | `sla/compute.ts` (no projection chaining — next step does it) |
| Projection | `/api/jobs/projection` | `:06 :21 :36 :51` | `projection/transform.ts` (incremental) |
| Session cleanup | `/api/jobs/sessions` | `:38` hourly | `jobs/sessionCleanup.ts` (invalid > 7 days) |

All five dispatch through `server/jobs/pipeline.ts` under one Postgres
**advisory lock** (`74221,1`): overlapping invocations return
`{"skipped":"locked"}` (HTTP 200 — expected under overrun, the step catches up
next slot). A function crash/timeout kills the lock connection, so the lock
self-releases; engine watermarks persist only on successful run close, so
reruns are idempotent.

## Auth

`Authorization: Bearer ${CRON_SECRET}` — Vercel Cron attaches it automatically
once the `CRON_SECRET` env var is set on the project. Constant-time compared;
**unconfigured secret fails closed** (uniform 401; `jobs_disabled_no_secret`
in logs). Generate with `openssl rand -base64 32`.

## Manual operations

- Trigger a single step: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/<step>`
  (or `vercel crons run /api/jobs/<step>`).
- Machine-local equivalents (same engines): `npm run sync:clickup`,
  `npm run sync:outlook`, `npm run sla` (CLI chains projection),
  `npm run project`, `npm run sessions:cleanup` — from `web/`.
- First Outlook mailbox backfill: bounded at 20 Graph pages (~1000 messages)
  per scheduled invocation with deterministic watermark progress, so it
  completes across successive runs on its own (VALIDATED 2026-07-08: a
  6,539-message mailbox completed in 7 bounded invocations); for a very large
  mailbox it can also be done in one manual `npm run sync:outlook` (unbounded
  CLI default).

## Monitoring & failure handling

- Every run writes a `sync_runs` row (`source_system` ∈ `clickup | outlook |
  transform | sla | sessions`) with status, counts, watermark and structured
  `details` (errors, quarantines, `pageBoundHit`, …). This table is the primary
  health surface: `SELECT source_system, status, finished_at FROM sync_runs
  ORDER BY id DESC LIMIT 20;`
- HTTP mapping: engine SUCCESS/PARTIAL → 200; FAILED → 500 (visible in the
  Vercel cron dashboard); response bodies are sanitised — detail lives in
  `sync_runs` + server logs only.
- A failing step never advances its watermark past the failure (engine
  semantics, unchanged) — fixing the cause and letting the next slot run is
  the standard recovery. No step requires manual replay to catch up.
- **No alerting exists yet** (deferred): a persistently failing step is only
  visible in `sync_runs` / Vercel logs. Check after config changes.
- **Unmatched acknowledgement emails do NOT re-match automatically** once the
  Outlook watermark has passed them. In steady state the cron stagger prevents
  this (ClickUp ingests at :00 before Outlook scans at :02), but acks scanned
  while their ticket was still quarantined/unregistered stay unmatched
  (`details.unmatchedRefs` lists them). Recovery after fixing the underlying
  ticket data: reset the outlook watermark — insert a `sync_runs` row
  (`source_system='outlook'`, status `SUCCESS`, `cursor` = an ISO timestamp
  before the missed acks) and let the next run re-scan; re-scanning is cheap,
  idempotent and first-write-wins.

## Production go-live runbook (ordered; none of this is set yet)

Execute top to bottom. Each step has a verification. Steps 1–9 are the Phase-1
production-readiness gate; the system flows data continuously once they pass.
Most require operator access (Vercel dashboard, ClickUp admin, secrets) and
are not automatable from this repo.

1. **Provision the production database.** Point `DATABASE_URL` at the pooled
   prod Postgres. Apply schema + reference data + migrations:
   `npm run db:migrate && npm run db:seed && npm run db:verify`.
   *Verify:* `db:verify` exits 0 (all invariants incl. 9a-1..4 green).
2. **Set Vercel production env.** `DATABASE_URL` (pooled), `CLICKUP_API_TOKEN`,
   `CLICKUP_TEAM_ID`, `CLICKUP_SUPPORT_FOLDER_ID`, `GRAPH_*`,
   `AUTH_ENABLED_PROVIDERS=entra,google`, `AUTH_ENTRA_*`, `AUTH_GOOGLE_*`,
   `PORTAL_BASE_URL` (prod URL), `CRON_SECRET` (`openssl rand -base64 32`).
   *Verify:* `npm run env:check` (reads the target env) shows all subsystems OK
   and the expected `AUTH_ENABLED_PROVIDERS` / `AUTO_PUBLISH_ENABLED`.
3. **ClickUp field names must match the workspace (REQUIRED — else every ticket
   quarantines).** Set **`CLICKUP_SLA_PRIORITY_FIELD_NAME=SLA`** — the
   workspace's SLA-priority label field is named "SLA", but the code default is
   "SLA Priority"; unset ⇒ every ticket quarantines `SLA_PRIORITY_MISSING`
   (confirmed in the Stage 9a live validation). Confirm
   `CLICKUP_CUSTOMER_FIELD_NAME=Customer` (currently correct). *Why config, not
   code:* field names are operator-configurable and admins may rename them.
   *Verify:* `env:check` prints the resolved field names and warns on the
   "SLA Priority" default.
4. **ClickUp status-mapping review.** The support list uses `backlog`, `to do`,
   `in progress`, `in review`, `blocked`, `business requirement`,
   `business review`, `done`, `cancelled`. The seed maps only a subset;
   unmapped statuses **correctly quarantine** (`STATUS_UNMAPPED` — do not weaken
   this). Decide before go-live: change the ClickUp template default
   `backlog`→`to do`, or add `backlog`/others meaning NEW to `status_mappings`.
   *Verify:* a freshly-created ticket lands on a mapped status.
5. **Register production OAuth redirect URIs** on both apps:
   `PORTAL_BASE_URL/api/auth/callback` (Entra) and
   `PORTAL_BASE_URL/api/auth/google/callback` (Google).
   *Verify:* a real staff login on prod completes (or the documented denial).
6. **Confirm the Vercel plan supports sub-daily cron (Pro).** The 15-minute
   schedule in `vercel.json` silently requires it. *Verify:* Vercel dashboard →
   Cron Jobs lists all five `/api/jobs/*` entries as scheduled.
7. **Mailbox verification.** Confirm the Graph app-only registration has
   admin-consented `Mail.Read` scoped to `GRAPH_SUPPORT_MAILBOX`. First Outlook
   run backfills the mailbox in bounded invocations (validated: 6,539 msgs / 7
   runs). *Verify:* trigger `/api/jobs/outlook` with the cron secret; a
   `sync_runs` row (`source_system='outlook'`) closes SUCCESS.
8. **ClickUp data hygiene.** As of 2026-07-08 the existing folder tasks
   quarantine (mostly `SLA_PRIORITY_MISSING`) — fix labels so real tickets flow.
   *Verify:* after a `clickup` job run, `sync_runs.details` quarantine count
   drops and `internal_tickets` grows.
9. **Production smoke test.** With `AUTO_PUBLISH_ENABLED` per the launch
   decision, trigger the pipeline steps in order and confirm a known ticket
   flows ClickUp→internal→(SLA)→customer, then loads in the portal for its
   account. *Verify:* the ticket is visible to its customer login and absent
   for others (the isolation guarantee).
10. **Monitoring & alerting (initial).** No alerting exists yet (documented
    gap). Minimum: a scheduled check that the newest `sync_runs` row per
    `source_system` is recent and not `FAILED`, surfaced to a channel the team
    watches. Candidate first Stage-10 ops-dashboard feature.
11. **Deferred decision**: pin function `regions` to sit near the database
   (Neon eu-west-2; e.g. `lhr1`). Measurement showed per-ticket costs are
   dominated by DB round-trips (~156 ms from the measurement machine; ~30 ms
   region-aligned). Deliberately NOT set yet.

## Measured baselines (Stage 8d measurement, 2026-07-08)

| Stage | Worst case measured | Notes |
| --- | --- | --- |
| ClickUp sync (watermark 0, archived incl.) | 11.9 s engine / 14.9 s wall | 8 tasks; API pagination dominates |
| SLA full scan | 2.4 s | ~6 fixed + ~4/ticket round-trips |
| Projection rebuild | 2.8 s engine / 5.1 s wall | |
| Session cleanup | ~0.2 s + 1.3 s run accounting | |
| Outlook sync — scan-only invocation | 2.4–4.1 s per 1000 msgs (20 pages) | Graph pagination dominates (~20 calls) |
| Outlook sync — ack-heavy invocation | **31.1 s** (1000 msgs, 185 acks) — observed worst case | ≈ +160 ms per ack email (one ticket-lookup round-trip each, at 156 ms DB RTT) |
| Outlook sync — full backfill | 6,539 msgs / 320 acks / 0 anomalies in **7 bounded invocations**, ~68 s engine total | `pageBoundHit=true` on runs 1–6, `false` when caught up; steady-state incremental run: 1.7 s / 2 msgs |

Measured 2026-07-08 through `/api/jobs/outlook` (the real scheduled path).
Pathological bound (1000/1000 messages being acks): ~4 s + 1000 × 0.16 s ≈
165 s — still inside the budget; region alignment would cut the per-ack cost
~30×. Function budget `maxDuration = 300 s` — comfortable headroom on
everything measured AND on the pathological bound.
