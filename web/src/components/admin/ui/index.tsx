// =============================================================================
// Admin console primitives (Stage 10b) — the ONLY building blocks pages use
// for the four specified states (refinement R4): loading (LoadingRows), empty
// (EmptyState), error (ErrorNotice + retry), populated (tables/cards below).
// Pure presentation; no fetch, no server imports.
// =============================================================================

import type { ReactNode } from "react";

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {children}
    </span>
  );
}

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[#2A2017] bg-[#1B140D]">
      <header className="flex items-center justify-between border-b border-[#2A2017] px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[#9C8E78]">{title}</h2>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent = "text-[#F7F2E8]",
  ring = "border-l-[#3A2D1F]",
  loading = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: string;
  ring?: string;
  loading?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-[#2A2017] border-l-2 ${ring} bg-[#1B140D] p-4`}>
      <p className="text-xs font-medium uppercase tracking-wide text-[#9C8E78]">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${accent}`}>
        {loading ? <span className="inline-block h-7 w-10 animate-pulse rounded bg-white/5" /> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-[#9C8E78]">{hint}</p>}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[#3A2D1F] px-4 py-8 text-center text-sm text-[#9C8E78]">
      {message}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[#E26A60]/40 bg-[rgba(226,106,96,0.12)] px-4 py-3 text-sm text-[#E26A60]">
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-4 rounded border border-[#E26A60]/40 px-2 py-1 text-xs hover:bg-[rgba(226,106,96,0.16)]"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-white/[0.04]" />
      ))}
    </div>
  );
}

// ---- dense table shells ------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm text-[#D9CFBE]">{children}</table>
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-[#2A2017] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#9C8E78] ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
  title,
}: {
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td title={title} className={`border-b border-[#2A2017]/50 px-3 py-2 align-top ${className}`}>
      {children}
    </td>
  );
}

/** Relative time in the cell, exact timestamp on hover (frozen rule R5). */
export function TimeCell({
  relative,
  exact,
  className = "",
}: {
  relative: string;
  exact: string;
  className?: string;
}) {
  return (
    <Td title={exact} className={`whitespace-nowrap tabular-nums ${className}`}>
      {relative}
    </Td>
  );
}
