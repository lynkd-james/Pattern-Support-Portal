"use client";

// =============================================================================
// Ticket detail (Stage 10b) — everything the backend knows about one ticket.
// INTERNAL TRUTH (invariant 10b-4): the internal panels are authoritative;
// customer projections appear ONLY in the explicitly-labelled exposure panel.
// Honest-NULL origin renders exactly "— Shared ticket" (frozen rule R5).
// =============================================================================

import Link from "next/link";
import type { ReactNode } from "react";
import { fetchAdminReference, fetchAdminTicketDetail } from "../../lib/admin/api";
import { VISIBILITY_LABELS } from "../../lib/admin/types";
import {
  EMPTY,
  PRIORITY_BADGE,
  SHARED_ORIGIN_LABEL,
  SLA_BADGE,
  SLA_LABELS,
  STAGE_BADGE,
  STAGE_LABELS,
  VISIBILITY_BADGE,
  formatDateTime,
  relativeTime,
} from "../../lib/admin/format";
import { useAdminData } from "./useAdminData";
import { Badge, EmptyState, ErrorNotice, LoadingRows, Section, Table, Td, Th, TimeCell } from "./ui";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <dt className="w-40 shrink-0 text-xs uppercase tracking-wide text-[#9C8E78]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[#D9CFBE]">{children}</dd>
    </div>
  );
}

export default function TicketDetailPage({ id }: { id: string }) {
  const detail = useAdminData(() => fetchAdminTicketDetail(id), [id]);
  const reference = useAdminData(() => fetchAdminReference(), []);

  if (detail.loading) return <LoadingRows rows={10} />;
  if (detail.error) return <ErrorNotice message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <EmptyState message="Ticket not found." />;

  const { ticket: t, timeline, projections, audit } = detail.data;

  const accountName = (accountId: string | null) =>
    accountId ? reference.data?.accounts.find((a) => a.id === accountId)?.name ?? accountId : null;
  const buSlug = (buId: string | null) =>
    buId ? reference.data?.businessUnits.find((b) => b.id === buId)?.slug ?? buId : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/tickets" className="text-xs text-[#9C8E78] hover:text-[#D9CFBE]">
          ← Tickets
        </Link>
        <h1 className="text-lg font-semibold text-[#F7F2E8]">{t.ticketNumber}</h1>
        <Badge tone={PRIORITY_BADGE[t.priority]}>{t.priority}</Badge>
        <Badge tone={STAGE_BADGE[t.stage]}>{STAGE_LABELS[t.stage]}</Badge>
        <Badge tone={VISIBILITY_BADGE[t.visibilityState]}>{VISIBILITY_LABELS[t.visibilityState]}</Badge>
        {t.visibilityBusinessUnits.length > 1 && (
          <span className="rounded bg-[rgba(111,166,224,0.16)] px-1.5 py-0.5 text-[10px] font-semibold text-[#6FA6E0]">
            SHARED
          </span>
        )}
      </div>
      <p className="text-sm text-[#F7F2E8]">{t.titleInternal}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Internal record (authoritative)">
          <dl>
            <Row label="Origin">
              {t.originAccountId
                ? `${accountName(t.originAccountId)} / ${buSlug(t.originBusinessUnitId) ?? EMPTY}`
                : SHARED_ORIGIN_LABEL}
            </Row>
            <Row label="Visible to">
              {t.visibilityBusinessUnits.length > 0 ? t.visibilityBusinessUnits.join(", ") : EMPTY}
            </Row>
            <Row label="Requester">
              {t.requesterName ?? EMPTY}
              {t.requesterEmail && <span className="ml-2 text-xs text-[#9C8E78]">{t.requesterEmail}</span>}
            </Row>
            <Row label="ClickUp task">
              <a
                href={`https://app.clickup.com/t/${t.clickupTaskId}`}
                target="_blank"
                rel="noreferrer"
                className="text-[#E8923E] hover:underline"
              >
                {t.clickupTaskId}
              </a>
              {t.clickupRawStatus && (
                <span className="ml-2 text-xs text-[#9C8E78]">raw status: {t.clickupRawStatus}</span>
              )}
            </Row>
            <Row label="Intake email id">
              <span className="break-all text-xs text-[#9C8E78]">{t.sourceEmailMessageId ?? EMPTY}</span>
            </Row>
            <Row label="Reopens">{t.reopenCount}</Row>
            <Row label="Last synced">
              <span title={formatDateTime(t.lastSyncedAt)}>{relativeTime(t.lastSyncedAt)}</span>
            </Row>
            <Row label="Updated">
              <span title={formatDateTime(t.updatedAt)}>{relativeTime(t.updatedAt)}</span>
            </Row>
          </dl>
        </Section>

        <Section title="Lifecycle & SLA">
          <dl>
            <Row label="Received">{formatDateTime(t.createdAt)}</Row>
            <Row label="Acknowledged">{formatDateTime(t.acknowledgedAt)}</Row>
            <Row label="Business review">{formatDateTime(t.businessReviewAt)}</Row>
            <Row label="Resolved">{formatDateTime(t.resolvedAt)}</Row>
            <Row label="Closed">{formatDateTime(t.closedAt)}</Row>
            <Row label="Response SLA">
              <Badge tone={SLA_BADGE[t.responseSlaState]}>{SLA_LABELS[t.responseSlaState]}</Badge>
              <span className="ml-2 text-xs text-[#9C8E78]">due {formatDateTime(t.responseDueAt)}</span>
            </Row>
            <Row label="Resolution SLA">
              <Badge tone={SLA_BADGE[t.resolutionSlaState]}>{SLA_LABELS[t.resolutionSlaState]}</Badge>
              <span className="ml-2 text-xs text-[#9C8E78]">due {formatDateTime(t.resolutionDueAt)}</span>
            </Row>
          </dl>
        </Section>
      </div>

      <Section title="Content (internal)">
        <dl>
          <Row label="Internal description">
            <span className="whitespace-pre-wrap">{t.descriptionInternal ?? EMPTY}</span>
          </Row>
          <Row label="Customer summary">
            <span className="whitespace-pre-wrap">{t.customerSummary ?? EMPTY}</span>
            <span className="mt-1 block text-xs text-[#9C8E78]">
              Customer-authored — the only free-text field eligible for the customer layer.
            </span>
          </Row>
        </dl>
      </Section>

      <Section title="Customer exposure (projections — the customer layer)">
        {projections.length === 0 ? (
          <EmptyState message="Not projected — this ticket has no customer-layer rows." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Business Unit</Th>
                <Th>Account</Th>
                <Th>Visibility</Th>
                <Th>Published</Th>
              </tr>
            </thead>
            <tbody>
              {projections.map((p) => (
                <tr key={p.businessUnitId}>
                  <Td className="font-medium text-[#F7F2E8]">{p.businessUnitSlug}</Td>
                  <Td>{p.accountSlug}</Td>
                  <Td>
                    <Badge tone={VISIBILITY_BADGE[p.visibilityState]}>{VISIBILITY_LABELS[p.visibilityState]}</Badge>
                  </Td>
                  <Td>{formatDateTime(p.publishedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Timeline (internal events)">
          {timeline.length === 0 ? (
            <EmptyState message="No stage transitions recorded." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Transition</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((e, i) => (
                  <tr key={i}>
                    <TimeCell relative={relativeTime(e.changedAt)} exact={formatDateTime(e.changedAt)} />
                    <Td>
                      {e.fromStage ? STAGE_LABELS[e.fromStage] : "(created)"} → {STAGE_LABELS[e.toStage]}
                    </Td>
                    <Td className="text-xs text-[#9C8E78]">{e.source}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>

        <Section title="Audit (ticket-scoped)">
          {audit.length === 0 ? (
            <EmptyState message="No audit events for this ticket." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Field</Th>
                  <Th>Change</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a, i) => (
                  <tr key={i}>
                    <TimeCell relative={relativeTime(a.occurredAt)} exact={formatDateTime(a.occurredAt)} />
                    <Td>{a.field ?? EMPTY}</Td>
                    <Td className="max-w-xs truncate text-xs" title={`${JSON.stringify(a.oldValue)} → ${JSON.stringify(a.newValue)}`}>
                      {JSON.stringify(a.oldValue) ?? EMPTY} → {JSON.stringify(a.newValue) ?? EMPTY}
                    </Td>
                    <Td className="text-xs text-[#9C8E78]">
                      {a.changeSource}
                      {a.actor ? ` · ${a.actor}` : ""}
                    </Td>
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
