import { NextResponse } from "next/server";
import { getSessionProvider } from "@/server/customer/session";
import { apiErrorResponse } from "@/server/apiError";

// Read-only; computed per request from the server-resolved scope.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionProvider().getSession();
    return NextResponse.json(session, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "session");
  }
}
