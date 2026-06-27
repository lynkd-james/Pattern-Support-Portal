import { NextResponse } from "next/server";

// Run on the Node.js serverless runtime (not edge) and never cache — this is a
// live call to ClickUp, so the response must be computed per request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLICKUP_BASE_URL = "https://api.clickup.com/api/v2";

/**
 * GET /api/clickup
 *
 * Connectivity test against ClickUp's safe `/user` endpoint. Confirms the token
 * and network path work end to end on Vercel. Server-only: the token is read
 * from the environment and never reaches the client.
 *
 * NOTE: ClickUp v2 expects the personal/OAuth token sent RAW in the
 * Authorization header — NOT prefixed with "Bearer". A Bearer prefix returns 401.
 */
export async function GET() {
  const token = process.env.CLICKUP_API_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: "CLICKUP_API_TOKEN is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${CLICKUP_BASE_URL}/user`, {
      method: "GET",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    // ClickUp returns JSON for both success and most error cases.
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json(
        {
          error: "ClickUp request failed",
          status: res.status,
          details: data,
        },
        { status: res.status }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to reach ClickUp",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
