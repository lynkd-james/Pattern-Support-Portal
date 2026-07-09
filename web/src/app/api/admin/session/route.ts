import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { apiErrorResponse } from "@/server/apiError";
import type { AdminSession } from "@/lib/admin/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireAdminSession();
    const body: AdminSession = {
      email: session.email,
      displayName: session.displayName,
      role: session.role,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/session");
  }
}
