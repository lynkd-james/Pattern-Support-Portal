// =============================================================================
// Transformation / projection engine.
//
//   internal_tickets        ->  customer_tickets
//   internal_ticket_events  ->  customer_ticket_timeline
//
// The customer layer is a DERIVED projection: always fully rebuildable from the
// internal layer, never a source of truth. Projection is deterministic and
// idempotent. The internal layer is treated as READ-ONLY here except for the
// `internal_tickets.visibility_state` control column; internal_ticket_events is
// never written by the projection (customer-visibility is computed, not stored).
//
// Modes:
//   * incremental — project tickets changed since the watermark. If
//     AUTO_PUBLISH_ENABLED changed since the last run, the engine reconciles the
//     whole internal layer automatically (no manual rebuild needed).
//   * rebuild     — force a full re-projection (recovery scenarios), preserving
//     explicit ADMIN visibility decisions.
//
// Out of scope (later stages): API, SLA computation, Outlook, auth, scheduling.
// =============================================================================

import type { PoolClient } from "pg";
import { env } from "../env";
import { query, withTransaction } from "../db";
import { createLogger, type Logger } from "../logger";
import { stageLabel } from "./labels";
import { determineVisibility, isPublished, type Visibility } from "./visibility";

const BATCH = 500;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type ProjectionMode = "incremental" | "rebuild";

export interface ProjectionSummary {
  runId: number | null;
  mode: ProjectionMode;
  fullScan: boolean;
  reason: "incremental" | "rebuild" | "auto_publish_changed";
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  processed: number;
  publishedNew: number;
  publishedUpdated: number;
  withdrawn: number;
  noop: number;
  visibilityChanges: number;
  failed: number;
  watermark: number;
  durationMs: number;
}

interface InternalRow {
  id: string;
  account_id: string;
  business_unit_id: string;
  ticket_number: string;
  title_internal: string;
  customer_summary: string | null;
  priority: string;
  current_stage: string;
  clickup_raw_status: string | null;
  visibility_state: Visibility;
  deleted_at: Date | null;
  created_at: Date;
  acknowledged_at: Date | null;
  business_review_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  response_due_at: Date | null;
  resolution_due_at: Date | null;
  response_sla_state: string;
  resolution_sla_state: string;
  updated_at: Date;
}

const SELECT_COLS = `
  id, account_id, business_unit_id, ticket_number, title_internal, customer_summary,
  priority, current_stage, clickup_raw_status, visibility_state, deleted_at,
  created_at, acknowledged_at, business_review_at, resolved_at, closed_at,
  response_due_at, resolution_due_at, response_sla_state, resolution_sla_state, updated_at`;

// ---- watermark / run bookkeeping (source_system = 'transform') -------------

interface LastRun {
  watermark: number;
  autoPublish: boolean | null;
}

async function lastRun(): Promise<LastRun> {
  const res = await query<{ cursor: string | null; details: { autoPublish?: boolean } | null }>(
    `SELECT cursor, details FROM sync_runs
      WHERE source_system = 'transform' AND status IN ('SUCCESS','PARTIAL')
      ORDER BY id DESC LIMIT 1`
  );
  const row = res.rows[0];
  const n = row?.cursor ? Number(row.cursor) : 0;
  return {
    watermark: Number.isFinite(n) ? n : 0,
    autoPublish: typeof row?.details?.autoPublish === "boolean" ? row.details.autoPublish : null,
  };
}

async function openRun(startWatermark: number): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (source_system, status, cursor) VALUES ('transform','RUNNING',$1) RETURNING id`,
    [String(startWatermark)]
  );
  return Number(res.rows[0].id);
}

async function closeRun(
  runId: number,
  s: ProjectionSummary,
  details: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE sync_runs SET status=$2, finished_at=now(),
        tickets_seen=$3, tickets_upserted=$4, error_count=$5, cursor=$6, details=$7::jsonb
      WHERE id=$1`,
    [
      runId,
      s.status,
      s.processed,
      s.publishedNew + s.publishedUpdated,
      s.failed,
      String(s.watermark),
      JSON.stringify(details),
    ]
  );
}

// ---- helpers ---------------------------------------------------------------

async function isAdminLocked(client: PoolClient, internalId: string): Promise<boolean> {
  const res = await client.query<{ change_source: string }>(
    `SELECT change_source FROM audit_events
      WHERE entity_type = 'internal_ticket' AND entity_id = $1 AND field = 'visibility_state'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [internalId]
  );
  return res.rows[0]?.change_source === "ADMIN";
}

async function audit(
  client: PoolClient,
  args: {
    entityType: string;
    entityId: string;
    accountId: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'TRANSFORM','transform')`,
    [
      args.entityType,
      args.entityId,
      args.accountId,
      args.field,
      JSON.stringify(args.oldValue),
      JSON.stringify(args.newValue),
    ]
  );
}

interface PublishResult {
  customerId: string;
  existed: boolean;
  priorVisibility: string | null;
}

/** Upsert a published customer row. Uses an explicit existence check (no xmax). */
async function upsertPublished(client: PoolClient, r: InternalRow): Promise<PublishResult> {
  const pre = await client.query<{ id: string; visibility_state: string }>(
    `SELECT id, visibility_state FROM customer_tickets WHERE internal_ticket_id = $1`,
    [r.id]
  );
  const existed = pre.rowCount !== null && pre.rowCount > 0;
  const priorVisibility = existed ? pre.rows[0].visibility_state : null;

  const res = await client.query<{ id: string }>(
    `INSERT INTO customer_tickets
       (internal_ticket_id, account_id, business_unit_id, ticket_number, title, description,
        priority, stage, created_at, acknowledged_at, business_review_at, resolved_at, closed_at,
        response_due_at, resolution_due_at, response_sla_state, resolution_sla_state,
        visibility_state, published_at, last_projected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::priority_level,$8::portal_stage,$9,$10,$11,$12,$13,
             $14,$15,$16::sla_state,$17::sla_state,'published', now(), now())
     ON CONFLICT (internal_ticket_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        business_unit_id = EXCLUDED.business_unit_id,
        ticket_number = EXCLUDED.ticket_number,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        priority = EXCLUDED.priority,
        stage = EXCLUDED.stage,
        created_at = EXCLUDED.created_at,
        acknowledged_at = EXCLUDED.acknowledged_at,
        business_review_at = EXCLUDED.business_review_at,
        resolved_at = EXCLUDED.resolved_at,
        closed_at = EXCLUDED.closed_at,
        response_due_at = EXCLUDED.response_due_at,
        resolution_due_at = EXCLUDED.resolution_due_at,
        response_sla_state = EXCLUDED.response_sla_state,
        resolution_sla_state = EXCLUDED.resolution_sla_state,
        visibility_state = 'published',
        published_at = COALESCE(customer_tickets.published_at, now()),
        last_projected_at = now()
     RETURNING id`,
    [
      r.id,
      r.account_id,
      r.business_unit_id,
      r.ticket_number,
      r.title_internal, // title (sanitised in V1 == internal title; no separate sanitiser yet)
      r.customer_summary, // description: ONLY the authored customer-safe summary (null until set)
      r.priority,
      r.current_stage,
      r.created_at,
      r.acknowledged_at,
      r.business_review_at,
      r.resolved_at,
      r.closed_at,
      r.response_due_at,
      r.resolution_due_at,
      r.response_sla_state,
      r.resolution_sla_state,
    ]
  );
  return { customerId: res.rows[0].id, existed, priorVisibility };
}

/**
 * Rebuild the customer timeline. Customer-visibility of events is COMPUTED here,
 * not stored: every recorded event is a portal-stage transition (already the
 * customer-facing taxonomy), so all are projected. internal_ticket_events is
 * never written — the internal layer stays immutable.
 */
async function rebuildTimeline(
  client: PoolClient,
  customerId: string,
  internalId: string
): Promise<void> {
  const events = await client.query<{ to_stage: string; changed_at: Date }>(
    `SELECT to_stage, changed_at FROM internal_ticket_events
      WHERE internal_ticket_id = $1
      ORDER BY changed_at ASC, id ASC`,
    [internalId]
  );
  await client.query(`DELETE FROM customer_ticket_timeline WHERE customer_ticket_id = $1`, [
    customerId,
  ]);
  for (const e of events.rows) {
    await client.query(
      `INSERT INTO customer_ticket_timeline (customer_ticket_id, stage, label, occurred_at)
       VALUES ($1, $2::portal_stage, $3, $4)`,
      [customerId, e.to_stage, stageLabel(e.to_stage), e.changed_at]
    );
  }
}

/** Withdraw an existing customer row (if any) from the portal. */
async function withdraw(
  client: PoolClient,
  internalId: string
): Promise<{ withdrawn: boolean; customerId: string | null }> {
  const res = await client.query<{ id: string }>(
    `UPDATE customer_tickets
        SET visibility_state = 'hidden_from_customer', last_projected_at = now()
      WHERE internal_ticket_id = $1 AND visibility_state <> 'hidden_from_customer'
      RETURNING id`,
    [internalId]
  );
  if (res.rowCount === 0) return { withdrawn: false, customerId: null };
  const customerId = res.rows[0].id;
  await client.query(`DELETE FROM customer_ticket_timeline WHERE customer_ticket_id = $1`, [
    customerId,
  ]);
  return { withdrawn: true, customerId };
}

type Outcome = "published_new" | "published_updated" | "withdrawn" | "noop";

async function processTicket(
  r: InternalRow,
  autoPublish: boolean
): Promise<{ outcome: Outcome; visibilityChanged: boolean }> {
  return withTransaction(async (client) => {
    const adminLocked = await isAdminLocked(client, r.id);
    const target = determineVisibility({
      adminLocked,
      currentVisibility: r.visibility_state,
      deletedAt: r.deleted_at,
      rawStatus: r.clickup_raw_status,
      autoPublish,
    });

    let visibilityChanged = false;
    if (target !== r.visibility_state) {
      await client.query(
        `UPDATE internal_tickets SET visibility_state = $2, updated_at = now() WHERE id = $1`,
        [r.id, target]
      );
      await audit(client, {
        entityType: "internal_ticket",
        entityId: r.id,
        accountId: r.account_id,
        field: "visibility_state",
        oldValue: r.visibility_state,
        newValue: target,
      });
      visibilityChanged = true;
    }

    if (isPublished(target)) {
      const { customerId, existed, priorVisibility } = await upsertPublished(client, r);
      await rebuildTimeline(client, customerId, r.id);
      if (!existed) {
        await audit(client, {
          entityType: "customer_ticket",
          entityId: customerId,
          accountId: r.account_id,
          field: "projection",
          oldValue: null,
          newValue: { visibility_state: "published", stage: r.current_stage },
        });
        return { outcome: "published_new", visibilityChanged };
      }
      if (priorVisibility !== "published") {
        await audit(client, {
          entityType: "customer_ticket",
          entityId: customerId,
          accountId: r.account_id,
          field: "visibility_state",
          oldValue: priorVisibility,
          newValue: "published",
        });
      }
      return { outcome: "published_updated", visibilityChanged };
    }

    const { withdrawn, customerId } = await withdraw(client, r.id);
    if (withdrawn && customerId) {
      await audit(client, {
        entityType: "customer_ticket",
        entityId: customerId,
        accountId: r.account_id,
        field: "visibility_state",
        oldValue: "published",
        newValue: "hidden_from_customer",
      });
      return { outcome: "withdrawn", visibilityChanged };
    }
    return { outcome: "noop", visibilityChanged };
  });
}

// ---- batched fetch (keyset on updated_at,id) -------------------------------

async function fetchBatch(
  fullScan: boolean,
  sinceMs: number,
  lastUpdatedAt: Date | null,
  lastId: string
): Promise<InternalRow[]> {
  // Full scan starts from epoch 0 (every ticket); incremental from the watermark.
  // Both paginate by (updated_at, id) so processing is ordered and resumable.
  const cursorAt = lastUpdatedAt ?? new Date(fullScan ? 0 : sinceMs);
  const res = await query<InternalRow>(
    `SELECT ${SELECT_COLS} FROM internal_tickets
      WHERE (updated_at > $1 OR (updated_at = $1 AND id > $2))
      ORDER BY updated_at ASC, id ASC
      LIMIT ${BATCH}`,
    [cursorAt, lastId]
  );
  return res.rows;
}

// ---- engine ----------------------------------------------------------------

export async function runProjection(
  options: { mode?: ProjectionMode; logger?: Logger } = {}
): Promise<ProjectionSummary> {
  const startedAt = Date.now();
  const mode: ProjectionMode = options.mode ?? "incremental";

  const autoPublish = env.autoPublishEnabled;
  const prior = await lastRun();
  const startWatermark = prior.watermark;

  // A change to AUTO_PUBLISH_ENABLED is reconciled NATURALLY: the next run scans
  // the whole internal layer once to re-evaluate visibility. No manual rebuild.
  const autoPublishChanged = prior.autoPublish !== null && prior.autoPublish !== autoPublish;
  const fullScan = mode === "rebuild" || autoPublishChanged;
  const reason: ProjectionSummary["reason"] = mode === "rebuild"
    ? "rebuild"
    : autoPublishChanged
      ? "auto_publish_changed"
      : "incremental";

  const log = (options.logger ?? createLogger("projection")).child({
    run: `transform-${startedAt}`,
    mode,
    reason,
  });

  const runId = await openRun(startWatermark);
  log.info("projection_started", { autoPublish, startWatermark, fullScan, reason });

  const c = {
    processed: 0,
    publishedNew: 0,
    publishedUpdated: 0,
    withdrawn: 0,
    noop: 0,
    visibilityChanges: 0,
    failed: 0,
  };
  const errors: Array<{ internalTicketId: string; reason: string; recovery: string }> = [];

  let watermark = startWatermark;
  let frozen = false;
  const advance = (ms: number) => {
    if (!frozen && ms > watermark) watermark = ms;
  };

  let status: ProjectionSummary["status"] = "SUCCESS";
  let lastUpdatedAt: Date | null = null;
  let lastId = ZERO_UUID;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await fetchBatch(fullScan, startWatermark, lastUpdatedAt, lastId);
      if (rows.length === 0) break;
      log.info("batch_fetched", { rows: rows.length });

      for (const row of rows) {
        c.processed += 1;
        lastUpdatedAt = row.updated_at;
        lastId = row.id;
        try {
          const { outcome, visibilityChanged } = await processTicket(row, autoPublish);
          if (visibilityChanged) c.visibilityChanges += 1;
          if (outcome === "published_new") c.publishedNew += 1;
          else if (outcome === "published_updated") c.publishedUpdated += 1;
          else if (outcome === "withdrawn") c.withdrawn += 1;
          else c.noop += 1;
          log.debug("ticket_projected", {
            internalTicket: row.id,
            ticketNumber: row.ticket_number,
            outcome,
            visibilityChanged,
          });
          advance(row.updated_at.getTime());
        } catch (err) {
          c.failed += 1;
          frozen = true; // hold watermark before the failure; retry next run
          const reasonMsg = err instanceof Error ? err.message : String(err);
          errors.push({
            internalTicketId: row.id,
            reason: reasonMsg,
            recovery: "watermark held; re-projected next run (idempotent)",
          });
          log.error("ticket_projection_failed", {
            internalTicket: row.id,
            ticketNumber: row.ticket_number,
            operation: "project",
            reason: reasonMsg,
            recovery: "watermark held; retried next run",
          });
        }
      }

      if (rows.length < BATCH) break;
    }
    status = c.failed > 0 ? "PARTIAL" : "SUCCESS";
  } catch (fatal) {
    status = "FAILED";
    const reasonMsg = fatal instanceof Error ? fatal.message : String(fatal);
    errors.push({ internalTicketId: "-", reason: reasonMsg, recovery: "fix and re-run; watermark unchanged" });
    log.error("projection_fatal", { reason: reasonMsg });
  }

  const summary: ProjectionSummary = {
    runId,
    mode,
    fullScan,
    reason,
    status,
    processed: c.processed,
    publishedNew: c.publishedNew,
    publishedUpdated: c.publishedUpdated,
    withdrawn: c.withdrawn,
    noop: c.noop,
    visibilityChanges: c.visibilityChanges,
    failed: c.failed,
    watermark,
    durationMs: Date.now() - startedAt,
  };

  await closeRun(runId, summary, {
    ...c,
    autoPublish,
    reason,
    fullScan,
    watermark,
    durationMs: summary.durationMs,
    errors,
  });
  log.info("projection_finished", { ...summary });
  return summary;
}
