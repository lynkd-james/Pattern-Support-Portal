"use client";

// =============================================================================
// Sync runs (Stage 10b) — recent pipeline activity across all source systems:
// status, duration, volumes, per-run quarantine count (supplied by the API —
// design-review addition), errors and the watermark cursor. READ-ONLY: no
// trigger/retry controls (invariant 10b-1); runs are started by the scheduler
// or the CLI, never from here.
// =============================================================================

import { fetchAdminSyncRuns } from "../../lib/admin/api";
import { EMPTY, SYNC_STATUS_BADGE, formatDateTime, formatDuration, relativeTime } from "../../lib/admin/format";
import { useAdminData } from "./useAdminData";
import { Badge, EmptyState, ErrorNotice, LoadingRows, Table, Td, Th, TimeCell } from "./ui";

export default function SyncRunsPage() {
  const runs = useAdminData(() => fetchAdminSyncRuns(50), []);

  if (runs.loading) return <LoadingRows rows={10} />;
  if (runs.error) return <ErrorNotice message={runs.error} onRetry={runs.reload} />;
  if (!runs.data || runs.data.length === 0)
    return <EmptyState message="No sync runs recorded — the pipeline has not run against this database." />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-[#F7F2E8]">Sync Runs</h1>
      <Table>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th>Started</Th>
            <Th>Duration</Th>
            <Th className="text-right">Seen</Th>
            <Th className="text-right">Upserted</Th>
            <Th className="text-right">Quarantined</Th>
            <Th className="text-right">Errors</Th>
            <Th>Watermark</Th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((r) => (
            <tr key={r.id}>
              <Td className="tabular-nums text-xs text-[#9C8E78]">{r.id}</Td>
              <Td className="font-medium text-[#F7F2E8]">{r.sourceSystem}</Td>
              <Td>
                <Badge tone={SYNC_STATUS_BADGE[r.status]}>{r.status}</Badge>
              </Td>
              <TimeCell relative={relativeTime(r.startedAt)} exact={formatDateTime(r.startedAt)} />
              <Td className="whitespace-nowrap tabular-nums">{formatDuration(r.startedAt, r.finishedAt)}</Td>
              <Td className="text-right tabular-nums">{r.ticketsSeen}</Td>
              <Td className="text-right tabular-nums">{r.ticketsUpserted}</Td>
              <Td className={`text-right tabular-nums ${r.quarantined > 0 ? "text-[#F0B854]" : ""}`}>
                {r.quarantined}
              </Td>
              <Td className={`text-right tabular-nums ${r.errorCount > 0 ? "text-[#E26A60]" : ""}`}>
                {r.errorCount}
              </Td>
              <Td className="max-w-[12rem] truncate text-xs text-[#9C8E78]" title={r.cursor ?? undefined}>
                {r.cursor ?? EMPTY}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
