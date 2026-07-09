import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { listAudit } from "@/server/admin/queries";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdminSession();
    const limit = Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "100", 10) || 100;
    return NextResponse.json({ data: await listAudit(limit) }, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/audit");
  }
}
