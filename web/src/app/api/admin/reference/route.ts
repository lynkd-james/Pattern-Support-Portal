import { NextResponse } from "next/server";
import { requireAdminSession } from "@/server/admin/session";
import { getReference } from "@/server/admin/queries";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
    return NextResponse.json(await getReference(), { status: 200 });
  } catch (err) {
    return apiErrorResponse(err, "admin/reference");
  }
}
