import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { listAudit, type AdminAuditFilters } from "@/server/admin/queries";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdminSession();
    const sp = new URL(req.url).searchParams;
    const filters: AdminAuditFilters = {
      entityType: sp.get("entityType"),
      changeSource: sp.get("changeSource"),
      entityId: sp.get("entityId"),
      search: sp.get("search"),
      beforeId: sp.get("beforeId") ? Number.parseInt(sp.get("beforeId")!, 10) || null : null,
      limit: Number.parseInt(sp.get("limit") ?? "100", 10) || 100,
    };
    return NextResponse.json({ data: await listAudit(filters) }, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/audit");
  }
}
