import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { getTicketDetail } from "@/server/admin/queries";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdminSession();
    const detail = await getTicketDetail(params.id);
    if (!detail) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Ticket not found" } },
        { status: 404 }
      );
    }
    return NextResponse.json(detail, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/tickets/detail");
  }
}
