// =============================================================================
// TicketTable — read-only list of tickets. Surfaces the RESOLUTION SLA as the
// row indicator (same field the cards use, kept consistent). Enum codes are
// rendered through the display helpers; the API sends codes only.
// =============================================================================

import type { SlaState, TicketListItem } from "../../lib/types";
import {
  PRIORITY_BADGE_CLASSES,
  PRIORITY_LABELS,
  SLA_BADGE_CLASSES,
  SLA_LABELS,
  STAGE_DOT_CLASSES,
  STAGE_LABELS,
  dueHint,
  formatDateTime,
} from "../../lib/display";

interface Props {
  tickets: TicketListItem[];
  loading?: boolean;
  onSelect?: (ticket: TicketListItem) => void;
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}

function SlaBadge({ state, dueAt }: { state: SlaState; dueAt: string | null }) {
  const showHint = state === "AT_RISK" || state === "BREACHED" || state === "PENDING";
  return (
    <div className="flex flex-col">
      <Badge className={SLA_BADGE_CLASSES[state]}>{SLA_LABELS[state]}</Badge>
      {showHint && dueAt && (
        <span className="mt-1 text-xs text-[#5C5142]">{dueHint(dueAt)}</span>
      )}
    </div>
  );
}

export default function TicketTable({ tickets, loading = false, onSelect }: Props) {
  if (!loading && tickets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#3A2D1F] bg-[#1B140D] p-12 text-center">
        <p className="text-sm font-medium text-[#D9CFBE]">No tickets match these filters</p>
        <p className="mt-1 text-sm text-[#9C8E78]">Try clearing a filter or adjusting your search.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[#2A2017] bg-[#1B140D]">
      <table className="min-w-full divide-y divide-[#2A2017] text-sm">
        <thead className="bg-[#221A11]">
          <tr className="text-left text-xs font-semibold uppercase tracking-wider text-[#9C8E78]">
            <th className="px-5 py-3.5">Ticket</th>
            <th className="px-5 py-3.5">Priority</th>
            <th className="px-5 py-3.5">Status</th>
            <th className="px-5 py-3.5">Business Unit</th>
            <th className="px-5 py-3.5">Created</th>
            <th className="px-5 py-3.5">Resolution SLA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#221A11]">
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-5 py-4" colSpan={6}>
                    <div className="h-5 w-full animate-pulse rounded bg-white/5" />
                  </td>
                </tr>
              ))
            : tickets.map((t) => (
                <tr
                  key={t.id}
                  className={`align-top ${onSelect ? "cursor-pointer hover:bg-[#221A11]" : ""}`}
                  onClick={onSelect ? () => onSelect(t) : undefined}
                >
                  <td className="px-5 py-4">
                    <div className="font-mono text-xs text-[#9C8E78]">{t.ticketNumber}</div>
                    <div className="mt-0.5 font-medium text-[#F7F2E8]">{t.title}</div>
                  </td>
                  <td className="px-5 py-4">
                    <Badge className={PRIORITY_BADGE_CLASSES[t.priority]}>
                      {PRIORITY_LABELS[t.priority]}
                    </Badge>
                  </td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center gap-2 text-[#D9CFBE]">
                      <span className={`h-2 w-2 rounded-full ${STAGE_DOT_CLASSES[t.stage]}`} />
                      {STAGE_LABELS[t.stage]}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-[#D9CFBE]">{t.businessUnit.name}</td>
                  <td className="px-5 py-4 text-[#9C8E78]">{formatDateTime(t.createdAt)}</td>
                  <td className="px-5 py-4">
                    <SlaBadge state={t.resolutionSlaState} dueAt={t.resolutionDueAt} />
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
