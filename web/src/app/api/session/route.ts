import { NextResponse } from "next/server";
import { getSessionProvider } from "@/server/customer/session";

// Read-only; computed per request from the server-resolved scope.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionProvider().getSession();
    return NextResponse.json(session, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: err instanceof Error ? err.message : "Unexpected error" } },
      { status: 500 }
    );
  }
}
