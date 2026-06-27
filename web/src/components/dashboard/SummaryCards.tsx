// =============================================================================
// SummaryCards — four executive cards computed purely on the client from the
// loaded (and already filtered) ticket list. No fetch happens here.
// =============================================================================

import type { DashboardSummary } from "../../lib/summary";

interface CardDef {
  key: keyof DashboardSummary;
  label: string;
  accent: string; // value text colour
  ring: string;   // left accent border
}

const CARDS: CardDef[] = [
  // "Total Open" carries the brand mango accent; the rest use semantic tokens.
  { key: "totalOpen", label: "Total Open Tickets", accent: "text-[#F7F2E8]", ring: "border-l-[#E8923E]" },
  { key: "atRiskSla", label: "At Risk SLA", accent: "text-[#F0B854]", ring: "border-l-[#F0B854]" },
  { key: "breachedSla", label: "Breached SLA", accent: "text-[#E26A60]", ring: "border-l-[#E26A60]" },
  { key: "resolved", label: "Resolved", accent: "text-[#6CC08A]", ring: "border-l-[#6CC08A]" },
];

interface Props {
  summary: DashboardSummary;
  loading?: boolean;
}

export default function SummaryCards({ summary, loading = false }: Props) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {CARDS.map((c) => (
        <div
          key={c.key}
          className={`rounded-2xl border border-[#2A2017] border-l-2 ${c.ring} bg-[#1B140D] p-5`}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-[#9C8E78]">{c.label}</p>
          <p className={`mt-3 text-3xl font-semibold tabular-nums ${c.accent}`}>
            {loading ? (
              <span className="inline-block h-8 w-12 animate-pulse rounded bg-white/5" />
            ) : (
              summary[c.key]
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
