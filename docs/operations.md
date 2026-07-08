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

## Production go-live checklist (none of this is set yet)

1. Vercel env: `DATABASE_URL` (pooled, migrated: `db:migrate` + `db:seed` +
   `db:verify`), `CLICKUP_*`, `GRAPH_*`, `AUTH_ENABLED_PROVIDERS=entra,google`
   + `AUTH_ENTRA_*`/`AUTH_GOOGLE_*` + `PORTAL_BASE_URL`, `CRON_SECRET`.
2. Register production redirect URIs on both OAuth apps.
3. Confirm the Vercel plan supports sub-daily cron (Pro) — the 15-minute
   schedule silently requires it.
4. ClickUp data hygiene: as of 2026-07-08 every folder task quarantines
   (6 × SLA_PRIORITY_MISSING, 2 × MULTIPLE_BUSINESS_UNITS) — the pipeline
   syncs zero tickets until the labels are fixed in ClickUp.
5. **Deferred decision**: pin function `regions` to sit near the database
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
