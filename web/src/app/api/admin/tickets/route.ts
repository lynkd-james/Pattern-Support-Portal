import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { listTickets, type AdminTicketFilters } from "@/server/admin/queries";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const boolParam = (v: string | null): boolean | null =>
  v === "true" ? true : v === "false" ? false : null;

export async function GET(req: Request) {
  try {
    await requireAdminSession();
    const sp = new URL(req.url).searchParams;
    const filters: AdminTicketFilters = {
      businessUnitId: sp.get("businessUnitId"),
      stage: sp.get("stage"),
      priority: sp.get("priority"),
      shared: boolParam(sp.get("shared")),
      published: boolParam(sp.get("published")),
      search: sp.get("search"),
      page: sp.get("page") ? Number.parseInt(sp.get("page")!, 10) || 1 : undefined,
      pageSize: sp.get("pageSize") ? Number.parseInt(sp.get("pageSize")!, 10) || undefined : undefined,
    };
    return NextResponse.json(await listTickets(filters), { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/tickets");
  }
}
