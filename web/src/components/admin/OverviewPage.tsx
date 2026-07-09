"use client";

// =============================================================================
// Overview (Stage 10b, refinement R6) — operational, not BI. Exactly: internal
// ticket counts, published exposure, quarantined (latest sync), per-source
// sync status (failures surfaced first — the stats.sync summary is computed
// SERVER-side per design review), recent audit activity. No charts.
//
// The CARDS registry is the metrics extension point: a future metric is one
// additive API field + one entry here (see docs/admin-portal.md metrics model).
// =============================================================================

import Link from "next/link";
import type { AdminStats } from "../../lib/admin/contracts";
import { fetchAdminAudit, fetchAdminStats } from "../../lib/admin/api";
import { formatDateTime, relativeTime, SYNC_STATUS_BADGE, EMPTY } from "../../lib/admin/format";
import { useAdminData } from "./useAdminData";
import { Badge, EmptyState, ErrorNotice, LoadingRows, Section, StatCard, Table, Td, Th, TimeCell } from "./ui";

interface CardDef {
  key: string;
  label: string;
  value: (s: AdminStats) => string | number;
  hint?: (s: AdminStats) => string | undefined;
  accent?: (s: AdminStats) => string;
  ring?: (s: AdminStats) => string;
  href?: string;
}

const warnIfPositive = (n: number, tone: string) => (n > 0 ? tone : "text-[#F7F2E8]");

// The metrics registry (extension point). Order = display order.
const CARDS: CardDef[] = [
  {
    key: "internal",
    label: "Internal Tickets",
    value: (s) => s.tickets.total,
    hint: (s) => `${s.tickets.open} open · ${s.tickets.closed} closed`,
    ring: () => "border-l-[#E8923E]",
    href: "/admin/tickets",
  },
  {
    key: "published",
    label: "Published Exposure",
    value: (s) => s.exposure.published,
    hint: () => "customer-visible projections",
    accent: () => "text-[#6CC08A]",
    ring: () => "border-l-[#6CC08A]",
    href: "/admin/tickets?published=true",
  },
  {
    key: "internalOnly",
    label: "Internal Only",
    value: (s) => s.exposure.internalOnly,
    hint: () => "tickets with no published projection",
    href: "/admin/tickets?published=false",
  },
  {
    key: "shared",
    label: "Shared Tickets",
    value: (s) => s.exposure.shared,
    hint: () => "visible to more than one business unit",
    href: "/admin/tickets?shared=true",
  },
  {
    key: "quarantined",
    label: "Quarantined (latest sync)",
    value: (s) => s.quarantinedLatest,
    accent: (s) => warnIfPositive(s.quarantinedLatest, "text-[#F0B854]"),
    ring: (s) => (s.quarantinedLatest > 0 ? "border-l-[#F0B854]" : "border-l-[#3A2D1F]"),
    href: "/admin/quarantine",
  },
  {
    key: "breaches",
    label: "SLA Breaches (published)",
    value: (s) => s.slaBreaches,
    accent: (s) => warnIfPositive(s.slaBreaches, "text-[#E26A60]"),
    ring: (s) => (s.slaBreaches > 0 ? "border-l-[#E26A60]" : "border-l-[#3A2D1F]"),
  },
];

// Failures first, then by source name — the failing source is the headline.
const SYNC_ORDER: Record<string, number> = { FAILED: 0, PARTIAL: 1, RUNNING: 2, SUCCESS: 3 };

export default function OverviewPage() {
  const stats = useAdminData(() => fetchAdminStats(), []);
  const audit = useAdminData(() => fetchAdminAudit({ limit: 8 }), []);

  return (
    <div className="space-y-6">
      {stats.error ? (
        <ErrorNotice message={stats.error} onRetry={stats.reload} />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {CARDS.map((c) => {
            const card = (
              <StatCard
                key={c.key}
                label={c.label}
                value={stats.data ? c.value(stats.data) : EMPTY}
                hint={stats.data ? c.hint?.(stats.data) : undefined}
                accent={stats.data ? c.accent?.(stats.data) : undefined}
                ring={stats.data ? c.ring?.(stats.data) : undefined}
                loading={stats.loading}
              />
            );
            return c.href ? (
              <Link key={c.key} href={c.href} className="block">
                {card}
              </Link>
            ) : (
              card
            );
          })}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Sync status (latest terminal run per source)">
          {stats.loading ? (
            <LoadingRows rows={4} />
          ) : stats.error ? (
            <ErrorNotice message={stats.error} onRetry={stats.reload} />
          ) : !stats.data || stats.data.sync.length === 0 ? (
            <EmptyState message="No completed sync runs yet — the pipeline has not run against this database." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th>Status</Th>
                  <Th>Finished</Th>
                  <Th>Watermark</Th>
                </tr>
              </thead>
              <tbody>
                {[...stats.data.sync]
                  .sort((a, b) => (SYNC_ORDER[a.status] ?? 9) - (SYNC_ORDER[b.status] ?? 9) || a.sourceSystem.localeCompare(b.sourceSystem))
                  .map((s) => (
                    <tr key={s.sourceSystem}>
                      <Td className="font-medium text-[#F7F2E8]">{s.sourceSystem}</Td>
                      <Td>
                        <Badge tone={SYNC_STATUS_BADGE[s.status]}>{s.status}</Badge>
                      </Td>
                      <TimeCell relative={relativeTime(s.finishedAt)} exact={formatDateTime(s.finishedAt)} />
                      <Td className="max-w-[14rem] truncate text-xs text-[#9C8E78]" title={s.cursor ?? undefined}>
                        {s.cursor ?? EMPTY}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          )}
        </Section>

        <Section
          title="Recent audit activity"
          aside={
            <Link href="/admin/audit" className="text-xs text-[#E8923E] hover:underline">
              View all
            </Link>
          }
        >
          {audit.loading ? (
            <LoadingRows rows={5} />
          ) : audit.error ? (
            <ErrorNotice message={audit.error} onRetry={audit.reload} />
          ) : !audit.data || audit.data.length === 0 ? (
            <EmptyState message="No audit events recorded yet." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Entity</Th>
                  <Th>Field</Th>
                  <Th>Source</Th>
                  <Th>Actor</Th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((e) => (
                  <tr key={e.id}>
                    <TimeCell relative={relativeTime(e.occurredAt)} exact={formatDateTime(e.occurredAt)} />
                    <Td className="text-[#F7F2E8]">{e.entityLabel ?? e.entityType}</Td>
                    <Td>{e.field ?? EMPTY}</Td>
                    <Td className="text-xs text-[#9C8E78]">{e.changeSource}</Td>
                    <Td className="text-xs text-[#9C8E78]">{e.actor ?? EMPTY}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
      </div>
    </div>
  );
}
