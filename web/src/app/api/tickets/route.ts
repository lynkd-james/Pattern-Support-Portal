import { NextResponse } from "next/server";
import { getSessionProvider } from "@/server/customer/session";
import { listTickets } from "@/server/customer/queries";
import { apiErrorResponse } from "@/server/apiError";
import type { PortalStage, PriorityLevel, SlaState, TicketListQuery } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGES: ReadonlySet<string> = new Set<PortalStage>([
  "NEW", "ACKNOWLEDGED", "IN_PROGRESS", "ON_HOLD", "BUSINESS_REVIEW", "RESOLVED", "CLOSED", "REOPENED",
]);
const PRIORITIES: ReadonlySet<string> = new Set<PriorityLevel>(["P1", "P2", "P3"]);
const SLA_STATES: ReadonlySet<string> = new Set<SlaState>([
  "NOT_APPLICABLE", "PENDING", "AT_RISK", "MET", "BREACHED",
]);

function badRequest(message: string) {
  return NextResponse.json({ error: { code: "BAD_REQUEST", message } }, { status: 400 });
}

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;

    const stage = sp.get("stage") ?? undefined;
    const priority = sp.get("priority") ?? undefined;
    const slaState = sp.get("slaState") ?? undefined;
    if (stage && !STAGES.has(stage)) return badRequest(`Invalid stage: ${stage}`);
    if (priority && !PRIORITIES.has(priority)) return badRequest(`Invalid priority: ${priority}`);
    if (slaState && !SLA_STATES.has(slaState)) return badRequest(`Invalid slaState: ${slaState}`);

    const pageRaw = sp.get("page");
    const pageSizeRaw = sp.get("pageSize");

    const q: TicketListQuery = {
      page: pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : undefined,
      pageSize: pageSizeRaw ? Number.parseInt(pageSizeRaw, 10) || undefined : undefined,
      stage: (stage as PortalStage | undefined) ?? null,
      priority: (priority as PriorityLevel | undefined) ?? null,
      slaState: (slaState as SlaState | undefined) ?? null,
      businessUnitId: sp.get("businessUnitId") ?? null,
      search: sp.get("search") ?? null,
      sort: sp.get("sort") ?? undefined,
    };

    const scope = await getSessionProvider().getScope();
    const result = await listTickets(scope, q);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "tickets/list");
  }
}
