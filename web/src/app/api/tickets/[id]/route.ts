import { NextResponse } from "next/server";
import { getSessionProvider } from "@/server/customer/session";
import { getTicketDetail } from "@/server/customer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const scope = await getSessionProvider().getScope();
    const ticket = await getTicketDetail(scope, params.id);
    if (!ticket) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Ticket not found" } },
        { status: 404 }
      );
    }
    return NextResponse.json(ticket, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: err instanceof Error ? err.message : "Unexpected error" } },
      { status: 500 }
    );
  }
}
