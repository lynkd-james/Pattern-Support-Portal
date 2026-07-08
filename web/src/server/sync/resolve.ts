// =============================================================================
// Pure resolution / mapping layer for ClickUp ingestion.
//
// Turns a raw ClickUp task into either a fully-attributed internal-ticket record
// or a quarantine decision. NEVER guesses: any missing/ambiguous tenancy or
// classification information results in quarantine. No DB or network access here
// (so it is unit-testable in isolation).
// =============================================================================

import { createHash } from "node:crypto";
import type { ClickUpCustomField, ClickUpTask } from "../clickup/types";

export type Priority = "P1" | "P2" | "P3";

// Stage 9a (docs/shared-tickets.md): MULTIPLE_BUSINESS_UNITS removed — a
// multi-label ticket is a legitimate SHARED ticket, not an anomaly. The
// TENANCY_CHANGED persistence-time reason is likewise gone: the visibility
// set is now derived data reconciled on every sync (a changed label set is an
// update, with origin transitions audited), so no tenancy conflict remains.
// BU_UNDETERMINED (zero matches) is retained — never-guess survives.
export type QuarantineReason =
  | "NO_CUSTOM_ID"
  | "MISSING_CREATED_TIMESTAMP"
  | "BU_UNDETERMINED"
  | "SLA_PRIORITY_MISSING"
  | "SLA_PRIORITY_MULTIPLE"
  | "SLA_PRIORITY_UNSUPPORTED"
  | "STATUS_UNMAPPED";

export interface ResolvedTicket {
  clickupTaskId: string;
  ticketNumber: string;
  title: string;
  description: string | null;
  rawStatus: string;
  currentStage: string; // portal_stage value
  priority: Priority;
  /**
   * VISIBILITY set (>= 1 member; sorted by business-unit id for deterministic
   * hashing). The sole source of which business units may see the ticket.
   */
  businessUnits: BusinessUnitRef[];
  /**
   * ORIGIN — populated only when objectively real (exactly one member in the
   * visibility set), else null. Internal reporting data; never visibility.
   */
  originAccountId: string | null;
  originBusinessUnitId: string | null;
  createdAt: Date;
  dateUpdated: Date;
  contentHash: string;
}

export type ResolveResult =
  | { kind: "ok"; data: ResolvedTicket }
  | { kind: "quarantine"; reason: QuarantineReason; detail: string };

export interface BusinessUnitRef {
  id: string;
  accountId: string;
}

export interface ResolveContext {
  /** lower(clickup_status) -> { stage, paused } */
  statusMap: Map<string, { stage: string; paused: boolean }>;
  /** UPPER(slug) -> business unit, where slug = ClickUp Customer label */
  buBySlug: Map<string, BusinessUnitRef>;
  customerFieldName: string;
  slaPriorityFieldName: string;
}

const KNOWN_PRIORITIES = new Set(["P1", "P2", "P3", "P4"]);

/** Selected label texts for a label/drop-down custom field, resolved via its options. */
function labelValues(task: ClickUpTask, fieldName: string): string[] {
  const cf: ClickUpCustomField | undefined = task.custom_fields?.find(
    (f) => f.name?.toLowerCase() === fieldName.toLowerCase()
  );
  if (!cf || cf.value == null) return [];

  const ids = Array.isArray(cf.value)
    ? cf.value.map((v) => String(v))
    : [String(cf.value)];

  const options = cf.type_config?.options ?? [];
  const byId = new Map(
    options.map((o) => [String(o.id), (o.label ?? o.name ?? "").trim()])
  );

  const labels: string[] = [];
  for (const id of ids) {
    const label = byId.get(id);
    if (label) labels.push(label);
  }
  return labels;
}

function canonicalHash(parts: ReadonlyArray<string | null>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function quarantine(reason: QuarantineReason, detail: string): ResolveResult {
  return { kind: "quarantine", reason, detail };
}

export function resolveTicket(
  task: ClickUpTask,
  ctx: ResolveContext
): ResolveResult {
  // 1. Ticket number (customer-facing reference).
  const ticketNumber = task.custom_id?.trim();
  if (!ticketNumber) {
    return quarantine("NO_CUSTOM_ID", `task ${task.id} has no custom_id`);
  }

  // 2. Created timestamp (NOT NULL in schema).
  const createdMs = Number(task.date_created);
  if (!task.date_created || !Number.isFinite(createdMs)) {
    return quarantine("MISSING_CREATED_TIMESTAMP", `task ${ticketNumber} has no date_created`);
  }
  const updatedMs = Number(task.date_updated);
  const dateUpdated = new Date(Number.isFinite(updatedMs) ? updatedMs : createdMs);

  // 3. VISIBILITY set from the Customer label(s) — Stage 9a: multiple labels
  // are a legitimate shared ticket (the label set IS the sharing decision);
  // only ZERO matches quarantines (never guess).
  const customerLabels = labelValues(task, ctx.customerFieldName);
  const matched = new Map<string, BusinessUnitRef>();
  for (const label of customerLabels) {
    const bu = ctx.buBySlug.get(label.toUpperCase());
    if (bu) matched.set(bu.id, bu);
  }
  if (matched.size === 0) {
    return quarantine(
      "BU_UNDETERMINED",
      `no mapped business unit for Customer labels [${customerLabels.join(", ") || "none"}]`
    );
  }
  // Deterministic ordering (by BU id) for stable content hashing.
  const businessUnits = [...matched.values()].sort((a, b) => a.id.localeCompare(b.id));
  // ORIGIN is only real when the set has exactly one member (docs/shared-tickets.md §2).
  const origin = businessUnits.length === 1 ? businessUnits[0] : null;

  // 4. Priority from the SLA Priority label (P1–P3; P4 unsupported).
  const priorityLabels = [
    ...new Set(
      labelValues(task, ctx.slaPriorityFieldName)
        .map((l) => l.toUpperCase())
        .filter((l) => KNOWN_PRIORITIES.has(l))
    ),
  ];
  if (priorityLabels.length === 0) {
    return quarantine("SLA_PRIORITY_MISSING", `task ${ticketNumber} has no SLA Priority`);
  }
  if (priorityLabels.length > 1) {
    return quarantine(
      "SLA_PRIORITY_MULTIPLE",
      `task ${ticketNumber} has multiple SLA Priorities [${priorityLabels.join(", ")}]`
    );
  }
  if (priorityLabels[0] === "P4") {
    return quarantine("SLA_PRIORITY_UNSUPPORTED", `task ${ticketNumber} is P4 (not in use)`);
  }
  const priority = priorityLabels[0] as Priority;

  // 5. Status -> portal stage (deterministic; unmapped => quarantine).
  const rawStatus = (task.status?.status ?? "").toLowerCase();
  const mapped = ctx.statusMap.get(rawStatus);
  if (!mapped) {
    return quarantine("STATUS_UNMAPPED", `unmapped ClickUp status "${rawStatus}" on ${ticketNumber}`);
  }

  const title = task.name ?? "";
  const description = task.description ?? task.text_content ?? null;

  const contentHash = canonicalHash([
    ticketNumber,
    title,
    description,
    rawStatus,
    mapped.stage,
    priority,
    // The sorted visibility set: any membership change changes the hash, so
    // the sync's no-op skip can never miss a junction reconciliation.
    ...businessUnits.map((b) => `${b.accountId}/${b.id}`),
  ]);

  return {
    kind: "ok",
    data: {
      clickupTaskId: task.id,
      ticketNumber,
      title,
      description,
      rawStatus,
      currentStage: mapped.stage,
      priority,
      businessUnits,
      originAccountId: origin?.accountId ?? null,
      originBusinessUnitId: origin?.id ?? null,
      createdAt: new Date(createdMs),
      dateUpdated,
      contentHash,
    },
  };
}
