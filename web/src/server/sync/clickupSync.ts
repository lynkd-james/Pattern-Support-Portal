// =============================================================================
// ClickUp -> internal layer ingestion engine.
//
//   ClickUp  ->  ClickUpClient  ->  (this engine)  ->  internal_tickets
//                                                       internal_ticket_events
//                                                       sync_runs
//
// Responsibilities: incremental polling with a watermark, idempotent upserts,
// status-change events (deduped), content-hash no-op detection, quarantine, and
// full per-run accounting in sync_runs. Manually executed (see scripts/sync).
//
// Out of scope (later stages): customer projection, SLA, Outlook, publishing.
// =============================================================================

import type { PoolClient } from "pg";
import { env, requireClickup, requireClickupScope } from "../env";
import { query, withTransaction } from "../db";
import { createLogger, type Logger } from "../logger";
import { ClickUpClient, ClickUpError } from "../clickup/client";
import type { ClickUpTask } from "../clickup/types";
import {
  resolveTicket,
  type BusinessUnitRef,
  type QuarantineReason,
  type ResolveContext,
  type ResolvedTicket,
} from "./resolve";

const PAGE_SIZE = 100;
const MAX_PAGES = 500; // safety bound

type Outcome = "inserted" | "updated" | "skipped" | "tenancy_conflict";

export interface SyncSummary {
  runId: number | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  processed: number;
  inserted: number;
  updated: number;
  skipped: number;
  quarantined: number;
  failed: number;
  watermark: number;
  fetchSince: number;
  durationMs: number;
}

interface QuarantineEntry {
  clickupTaskId: string;
  customId: string | null;
  reason: QuarantineReason;
  detail: string;
}
interface ErrorEntry {
  clickupTaskId: string;
  customId: string | null;
  operation: string;
  reason: string;
  recovery: string;
}
// ---- reference data --------------------------------------------------------

async function loadBuBySlug(): Promise<Map<string, BusinessUnitRef>> {
  const res = await query<{ id: string; account_id: string; slug: string }>(
    "SELECT id, account_id, slug FROM business_units WHERE is_active = TRUE"
  );
  const map = new Map<string, BusinessUnitRef>();
  for (const r of res.rows) {
    map.set(r.slug.toUpperCase(), { id: r.id, accountId: r.account_id });
  }
  return map;
}

async function loadStatusMap(): Promise<
  Map<string, { stage: string; paused: boolean }>
> {
  // Prefer account-specific rows over global (account_id IS NULL) defaults.
  const res = await query<{
    clickup_status: string;
    portal_stage: string;
    is_sla_paused: boolean;
    account_id: string | null;
  }>(
    `SELECT clickup_status, portal_stage, is_sla_paused, account_id
       FROM status_mappings
      ORDER BY account_id NULLS FIRST` // global first, account rows overwrite
  );
  const map = new Map<string, { stage: string; paused: boolean }>();
  for (const r of res.rows) {
    map.set(r.clickup_status.toLowerCase(), {
      stage: r.portal_stage,
      paused: r.is_sla_paused,
    });
  }
  return map;
}

// ---- watermark / sync_runs -------------------------------------------------

async function lastWatermark(): Promise<number> {
  const res = await query<{ cursor: string | null }>(
    `SELECT cursor FROM sync_runs
      WHERE source_system = 'clickup' AND status IN ('SUCCESS','PARTIAL') AND cursor IS NOT NULL
      ORDER BY id DESC LIMIT 1`
  );
  const c = res.rows[0]?.cursor;
  const n = c ? Number(c) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function openRun(fetchSince: number): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (source_system, status, cursor)
       VALUES ('clickup', 'RUNNING', $1)
     RETURNING id`,
    [String(fetchSince)]
  );
  return Number(res.rows[0].id);
}

async function closeRun(
  runId: number,
  summary: SyncSummary,
  details: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE sync_runs
        SET status = $2, finished_at = now(),
            tickets_seen = $3, tickets_upserted = $4, error_count = $5,
            cursor = $6, details = $7::jsonb
      WHERE id = $1`,
    [
      runId,
      summary.status,
      summary.processed,
      summary.inserted + summary.updated,
      summary.failed,
      String(summary.watermark),
      JSON.stringify(details),
    ]
  );
}

// ---- per-ticket persistence ------------------------------------------------

interface UpsertResult {
  ticketId: string;
  outcome: Outcome;
  detail?: string;
}

async function upsertTicket(
  client: PoolClient,
  t: ResolvedTicket
): Promise<UpsertResult> {
  const existing = await client.query<{
    id: string;
    content_hash: string | null;
    account_id: string;
    business_unit_id: string;
  }>(
    `SELECT id, content_hash, account_id, business_unit_id
       FROM internal_tickets WHERE clickup_task_id = $1`,
    [t.clickupTaskId]
  );

  if (existing.rowCount === 0) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO internal_tickets
         (account_id, business_unit_id, ticket_number, clickup_task_id,
          title_internal, description_internal, priority, current_stage,
          clickup_raw_status, created_at, content_hash, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::priority_level,$8::portal_stage,$9,$10,$11, now())
       RETURNING id`,
      [
        t.accountId,
        t.businessUnitId,
        t.ticketNumber,
        t.clickupTaskId,
        t.title,
        t.description,
        t.priority,
        t.currentStage,
        t.rawStatus,
        t.createdAt,
        t.contentHash,
      ]
    );
    return { ticketId: ins.rows[0].id, outcome: "inserted" };
  }

  const row = existing.rows[0];

  // Tenancy must never change silently. If the resolved tenant differs from the
  // stored one, do NOT write — quarantine the ticket for human resolution, so it
  // is neither moved across tenants nor permanently frozen with stale data.
  if (row.business_unit_id !== t.businessUnitId || row.account_id !== t.accountId) {
    return {
      ticketId: row.id,
      outcome: "tenancy_conflict",
      detail: `stored ${row.account_id}/${row.business_unit_id} != incoming ${t.accountId}/${t.businessUnitId}`,
    };
  }

  if (row.content_hash === t.contentHash) {
    return { ticketId: row.id, outcome: "skipped" };
  }

  // Update mutable fields only. Immutable (account_id, business_unit_id,
  // ticket_number, created_at, clickup_task_id) are intentionally NOT touched.
  await client.query(
    `UPDATE internal_tickets
        SET title_internal = $2, description_internal = $3,
            priority = $4::priority_level, current_stage = $5::portal_stage,
            clickup_raw_status = $6, content_hash = $7,
            last_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      row.id,
      t.title,
      t.description,
      t.priority,
      t.currentStage,
      t.rawStatus,
      t.contentHash,
    ]
  );
  return { ticketId: row.id, outcome: "updated" };
}

/** Append a status-change event only when the stage differs from the latest one. */
async function ensureStatusEvent(
  client: PoolClient,
  ticketId: string,
  toStage: string,
  toRawStatus: string,
  changedAt: Date
): Promise<boolean> {
  const last = await client.query<{ to_stage: string; to_raw_status: string | null }>(
    `SELECT to_stage, to_raw_status FROM internal_ticket_events
      WHERE internal_ticket_id = $1
      ORDER BY changed_at DESC, id DESC LIMIT 1`,
    [ticketId]
  );

  const prev = last.rows[0];
  if (prev && prev.to_stage === toStage) return false;

  await client.query(
    `INSERT INTO internal_ticket_events
       (internal_ticket_id, from_stage, to_stage, from_raw_status, to_raw_status, changed_at, source)
     VALUES ($1, $2::portal_stage, $3::portal_stage, $4, $5, $6, 'SYNC')`,
    [ticketId, prev?.to_stage ?? null, toStage, prev?.to_raw_status ?? null, toRawStatus, changedAt]
  );
  return true;
}

// ---- engine ----------------------------------------------------------------

export async function runClickupSync(options: { logger?: Logger } = {}): Promise<SyncSummary> {
  const startedAt = Date.now();
  const log = (options.logger ?? createLogger("clickup-sync")).child({
    run: `clickup-${startedAt}`,
  });

  const token = requireClickup().token;
  const { teamId, folderId } = requireClickupScope();
  const includeArchived = env.clickupIncludeArchived;
  const client = new ClickUpClient(token, { logger: log });

  const since = await lastWatermark();
  const fetchSince = since > 0 ? Math.max(0, since - env.clickupSyncOverlapMs) : 0;
  const runId = await openRun(fetchSince);

  log.info("sync_started", {
    since,
    fetchSince,
    overlapMs: env.clickupSyncOverlapMs,
    teamId,
    folderId,
  });

  const counters = { processed: 0, inserted: 0, updated: 0, skipped: 0, quarantined: 0, failed: 0 };
  const quarantines: QuarantineEntry[] = [];
  const errors: ErrorEntry[] = [];

  let watermark = since;
  let watermarkFrozen = false;
  const advance = (ms: number) => {
    if (!watermarkFrozen && ms > watermark) watermark = ms;
  };

  let status: SyncSummary["status"] = "SUCCESS";

  try {
    const ctx: ResolveContext = {
      statusMap: await loadStatusMap(),
      buBySlug: await loadBuBySlug(),
      customerFieldName: env.clickupCustomerFieldName,
      slaPriorityFieldName: env.clickupSlaPriorityFieldName,
    };

    const lists = await client.getFolderLists(folderId, includeArchived);
    const listIds = lists.lists.map((l) => l.id);
    log.info("lists_resolved", { count: listIds.length, includeArchived });
    if (listIds.length === 0) {
      throw new Error(`No lists found in support folder ${folderId}`);
    }

    // Retrieval: merge the active + archived task streams, then run the existing
    // per-task pipeline (below) unchanged over the merged set. Per ClickUp docs the
    // team-filtered endpoint has no `archived` param (active only); archived tasks
    // are fetched per-list via the list endpoint with archived=true. Deduped by
    // task id (the streams are disjoint; dedupe is defensive).
    const collected = new Map<string, ClickUpTask>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await client.getFilteredTeamTasks(teamId, {
        listIds,
        dateUpdatedGt: fetchSince,
        page,
      });
      const pageTasks = res.tasks ?? [];
      log.info("page_fetched", { source: "active", page, tasks: pageTasks.length });
      for (const t of pageTasks) collected.set(t.id, t);
      if (pageTasks.length < PAGE_SIZE || res.last_page) break;
    }

    if (includeArchived) {
      for (const listId of listIds) {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const res = await client.getListTasks(listId, {
            dateUpdatedGt: fetchSince,
            page,
            archived: true,
          });
          const pageTasks = res.tasks ?? [];
          log.info("page_fetched", { source: "archived", listId, page, tasks: pageTasks.length });
          for (const t of pageTasks) collected.set(t.id, t);
          if (pageTasks.length < PAGE_SIZE || res.last_page) break;
        }
      }
    }

    for (const task of collected.values()) {
        counters.processed += 1;
        const updatedMs = Number(task.date_updated) || Number(task.date_created) || 0;
        try {
          const resolved = resolveTicket(task, ctx);

          if (resolved.kind === "quarantine") {
            counters.quarantined += 1;
            quarantines.push({
              clickupTaskId: task.id,
              customId: task.custom_id ?? null,
              reason: resolved.reason,
              detail: resolved.detail,
            });
            log.warn("ticket_quarantined", {
              clickupTask: task.id,
              customId: task.custom_id ?? null,
              operation: "resolve",
              reason: resolved.reason,
              detail: resolved.detail,
              recovery: "correct the task in ClickUp (label/priority/status); it re-syncs on next update",
            });
            // A quarantined task re-appears when its source is corrected
            // (date_updated bumps), so it is safe to advance past it.
            advance(updatedMs);
            continue;
          }

          const r = await withTransaction(async (c) => {
            const up = await upsertTicket(c, resolved.data);
            if (up.outcome === "inserted" || up.outcome === "updated") {
              await ensureStatusEvent(
                c,
                up.ticketId,
                resolved.data.currentStage,
                resolved.data.rawStatus,
                resolved.data.dateUpdated
              );
            }
            return up;
          });

          if (r.outcome === "tenancy_conflict") {
            counters.quarantined += 1;
            quarantines.push({
              clickupTaskId: task.id,
              customId: task.custom_id ?? null,
              reason: "TENANCY_CHANGED",
              detail: r.detail ?? "tenant mapping changed",
            });
            log.warn("ticket_quarantined", {
              clickupTask: task.id,
              customId: task.custom_id ?? null,
              operation: "tenancy-check",
              reason: "TENANCY_CHANGED",
              detail: r.detail,
              recovery:
                "tenant mapping changed since import; left untouched. Resolve in ClickUp/admin — it re-syncs on next update.",
            });
          } else if (r.outcome === "inserted") {
            counters.inserted += 1;
          } else if (r.outcome === "updated") {
            counters.updated += 1;
          } else {
            counters.skipped += 1;
          }
          log.debug("ticket_processed", {
            clickupTask: task.id,
            customId: task.custom_id ?? null,
            outcome: r.outcome,
            stage: resolved.data.currentStage,
          });
          advance(updatedMs);
        } catch (err) {
          counters.failed += 1;
          watermarkFrozen = true; // do not advance past a failure; retry next run
          const reason = err instanceof ClickUpError
            ? `ClickUp ${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
          errors.push({
            clickupTaskId: task.id,
            customId: task.custom_id ?? null,
            operation: "upsert",
            reason,
            recovery: "watermark held before this task; will retry on next run (idempotent)",
          });
          log.error("ticket_failed", {
            clickupTask: task.id,
            customId: task.custom_id ?? null,
            operation: "upsert",
            reason,
            recovery: "watermark held; retried next run",
          });
        }
      }

    status = counters.failed > 0 ? "PARTIAL" : "SUCCESS";
  } catch (fatal) {
    status = "FAILED";
    const reason = fatal instanceof ClickUpError
      ? `ClickUp ${fatal.status}: ${fatal.message}`
      : fatal instanceof Error
        ? fatal.message
        : String(fatal);
    errors.push({
      clickupTaskId: "-",
      customId: null,
      operation: "fetch",
      reason,
      recovery: "fix connectivity/scope and re-run; watermark unchanged",
    });
    log.error("sync_fatal", { operation: "fetch", reason });
  }

  const summary: SyncSummary = {
    runId,
    status,
    processed: counters.processed,
    inserted: counters.inserted,
    updated: counters.updated,
    skipped: counters.skipped,
    quarantined: counters.quarantined,
    failed: counters.failed,
    watermark,
    fetchSince,
    durationMs: Date.now() - startedAt,
  };

  await closeRun(runId, summary, {
    ...counters,
    fetchSince,
    watermark,
    durationMs: summary.durationMs,
    errors,
    quarantines,
  });

  log.info("sync_finished", { ...summary });
  return summary;
}
