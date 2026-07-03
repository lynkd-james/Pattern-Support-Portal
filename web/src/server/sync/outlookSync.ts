// =============================================================================
// Outlook -> internal layer acknowledgement ingestion (Stage 6).
//
//   supportdesk mailbox (Graph)  ->  GraphClient  ->  (this engine)
//     -> internal_tickets.acknowledged_at (+ source_email_message_id)
//     -> sync_runs (source_system = 'outlook')
//
// Incremental scan of the shared mailbox with a receivedDateTime watermark:
// find "ticket has been logged" emails, parse the PAT3-xxxx ref, match by
// internal_tickets.ticket_number, and set acknowledged_at = the email's send
// time (FIRST-WRITE-WINS; only when currently null). Never guesses; never clamps.
//
// Anomaly policy (agreed): if the parsed ack time precedes the ticket's
// created_at, SKIP + log + record in the run's anomalies (do NOT clamp) so the
// DB constraint (acknowledged_at >= created_at) stays meaningful.
//
// Out of scope here: projection (run separately / chained by the CLI), SLA.
// =============================================================================

import { env, requireGraph } from "../env";
import { query } from "../db";
import { createLogger, type Logger } from "../logger";
import { GraphClient, GraphError } from "../graph/client";
import type { GraphMessagesResponse } from "../graph/types";
import { extractAckRef } from "./ackEmail";

const PAGE_TOP = 50;
const MAX_PAGES = 1000; // safety bound

export interface OutlookSyncSummary {
  runId: number | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  processed: number; // messages seen
  ackEmails: number; // messages recognised as acknowledgements
  updated: number; // acknowledged_at newly set
  alreadyAcked: number; // ticket already had acknowledged_at
  unmatched: number; // ref has no ingested ticket yet
  anomalies: number; // ambiguous ref / ack-before-created / missing timestamp
  failed: number;
  watermark: string | null; // ISO receivedDateTime
  durationMs: number;
}

interface AnomalyEntry {
  messageId: string;
  ref: string | null;
  reason: "AMBIGUOUS_REF" | "ACK_BEFORE_CREATED" | "MISSING_SENT_TIME";
  detail: string;
}
interface ErrorEntry {
  messageId: string;
  reason: string;
  recovery: string;
}

async function lastWatermark(): Promise<string | null> {
  const res = await query<{ cursor: string | null }>(
    `SELECT cursor FROM sync_runs
      WHERE source_system = 'outlook' AND status IN ('SUCCESS','PARTIAL') AND cursor IS NOT NULL
      ORDER BY id DESC LIMIT 1`
  );
  return res.rows[0]?.cursor ?? null;
}

async function openRun(cursor: string | null): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (source_system, status, cursor) VALUES ('outlook','RUNNING',$1) RETURNING id`,
    [cursor]
  );
  return Number(res.rows[0].id);
}

async function closeRun(
  runId: number,
  s: OutlookSyncSummary,
  details: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE sync_runs SET status=$2, finished_at=now(),
        tickets_seen=$3, tickets_upserted=$4, error_count=$5, cursor=$6, details=$7::jsonb
      WHERE id=$1`,
    [runId, s.status, s.processed, s.updated, s.failed, s.watermark, JSON.stringify(details)],
  );
}

export async function runOutlookSync(
  options: { logger?: Logger } = {}
): Promise<OutlookSyncSummary> {
  const startedAt = Date.now();
  const log = (options.logger ?? createLogger("outlook-sync")).child({ run: `outlook-${startedAt}` });

  const creds = requireGraph();
  const mailbox = env.graphSupportMailbox;
  const client = new GraphClient(creds, { logger: log });

  const since = await lastWatermark();
  const fetchSinceIso = since
    ? new Date(new Date(since).getTime() - env.graphSyncOverlapMs).toISOString()
    : undefined;
  const runId = await openRun(since);
  log.info("outlook_sync_started", { mailbox, since, fetchSinceIso });

  const c = { processed: 0, ackEmails: 0, updated: 0, alreadyAcked: 0, unmatched: 0, anomalies: 0, failed: 0 };
  const anomalies: AnomalyEntry[] = [];
  const errors: ErrorEntry[] = [];
  const unmatchedRefs: string[] = [];

  let watermark = since;
  let frozen = false;
  const advance = (iso: string | null | undefined) => {
    if (frozen || !iso) return;
    if (watermark === null || new Date(iso).getTime() > new Date(watermark).getTime()) watermark = iso;
  };

  let status: OutlookSyncSummary["status"] = "SUCCESS";

  try {
    let page: GraphMessagesResponse | null = await client.listMessagesFirstPage(mailbox, {
      sinceIso: fetchSinceIso,
      top: PAGE_TOP,
    });

    let pageCount = 0;
    while (page && pageCount < MAX_PAGES) {
      const messages = page.value ?? [];
      log.info("page_fetched", { page: pageCount, messages: messages.length });
      pageCount += 1;

      for (const msg of messages) {
        c.processed += 1;
        try {
          const ack = extractAckRef(msg.subject, msg.bodyPreview);
          if (ack.kind === "none") {
            advance(msg.receivedDateTime);
            continue;
          }
          c.ackEmails += 1;

          if (ack.kind === "ambiguous") {
            c.anomalies += 1;
            anomalies.push({
              messageId: msg.id,
              ref: null,
              reason: "AMBIGUOUS_REF",
              detail: `multiple refs [${ack.refs.join(", ")}]`,
            });
            log.warn("ack_ambiguous", { messageId: msg.id, refs: ack.refs });
            advance(msg.receivedDateTime);
            continue;
          }

          const ref = ack.ref;
          const found = await query<{ id: string; created_at: Date; acknowledged_at: Date | null }>(
            `SELECT id, created_at, acknowledged_at FROM internal_tickets WHERE ticket_number = $1`,
            [ref]
          );
          const ticket = found.rows[0];
          if (!ticket) {
            c.unmatched += 1;
            unmatchedRefs.push(ref);
            log.info("ack_unmatched", {
              ref,
              messageId: msg.id,
              recovery: "ticket not ingested yet; will match on a later run once synced",
            });
            advance(msg.receivedDateTime);
            continue;
          }
          if (ticket.acknowledged_at !== null) {
            c.alreadyAcked += 1;
            advance(msg.receivedDateTime);
            continue;
          }

          const sentIso = msg.sentDateTime ?? msg.receivedDateTime ?? null;
          if (!sentIso) {
            c.anomalies += 1;
            anomalies.push({ messageId: msg.id, ref, reason: "MISSING_SENT_TIME", detail: "no sent/received time" });
            log.warn("ack_missing_time", { ref, messageId: msg.id });
            advance(msg.receivedDateTime);
            continue;
          }
          if (new Date(sentIso).getTime() < new Date(ticket.created_at).getTime()) {
            c.anomalies += 1;
            anomalies.push({
              messageId: msg.id,
              ref,
              reason: "ACK_BEFORE_CREATED",
              detail: `sent ${sentIso} < created ${new Date(ticket.created_at).toISOString()}`,
            });
            log.warn("ack_before_created", {
              ref,
              messageId: msg.id,
              sentAt: sentIso,
              createdAt: new Date(ticket.created_at).toISOString(),
              recovery: "skipped (not clamped); quarantined for review",
            });
            advance(msg.receivedDateTime);
            continue;
          }

          // First-write-wins: only set when still null.
          const upd = await query(
            `UPDATE internal_tickets
                SET acknowledged_at = $2, source_email_message_id = $3, updated_at = now()
              WHERE id = $1 AND acknowledged_at IS NULL`,
            [ticket.id, new Date(sentIso), msg.internetMessageId ?? msg.id]
          );
          if (upd.rowCount && upd.rowCount > 0) {
            c.updated += 1;
            log.debug("ack_recorded", { ref, messageId: msg.id, acknowledgedAt: sentIso });
          } else {
            c.alreadyAcked += 1; // set by a concurrent/earlier row between SELECT and UPDATE
          }
          advance(msg.receivedDateTime);
        } catch (err) {
          c.failed += 1;
          frozen = true; // hold watermark before the failure; retry next run
          const reason = err instanceof GraphError
            ? `Graph ${err.status}: ${err.message}`
            : err instanceof Error ? err.message : String(err);
          errors.push({ messageId: msg.id, reason, recovery: "watermark held; retried next run" });
          log.error("message_failed", { messageId: msg.id, reason });
        }
      }

      const nextLink: string | undefined = page["@odata.nextLink"];
      page = nextLink ? await client.get<GraphMessagesResponse>(nextLink) : null;
    }

    status = c.failed > 0 ? "PARTIAL" : "SUCCESS";
  } catch (fatal) {
    status = "FAILED";
    const reason = fatal instanceof GraphError
      ? `Graph ${fatal.status}: ${fatal.message}`
      : fatal instanceof Error ? fatal.message : String(fatal);
    errors.push({ messageId: "-", reason, recovery: "fix connectivity/permissions and re-run; watermark unchanged" });
    log.error("outlook_sync_fatal", { reason });
  }

  const summary: OutlookSyncSummary = {
    runId,
    status,
    processed: c.processed,
    ackEmails: c.ackEmails,
    updated: c.updated,
    alreadyAcked: c.alreadyAcked,
    unmatched: c.unmatched,
    anomalies: c.anomalies,
    failed: c.failed,
    watermark,
    durationMs: Date.now() - startedAt,
  };

  await closeRun(runId, summary, {
    ...c,
    mailbox,
    watermark,
    durationMs: summary.durationMs,
    anomalies,
    unmatchedRefs,
    errors,
  });
  log.info("outlook_sync_finished", { ...summary });
  return summary;
}
