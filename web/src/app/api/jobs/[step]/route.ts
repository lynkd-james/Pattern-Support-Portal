// =============================================================================
// GET /api/jobs/{clickup|outlook|sla|projection|sessions} — scheduled pipeline
// steps (Stage 8d). Invoked by Vercel Cron (see vercel.json); one step per
// invocation via the advisory-lock orchestrator (server/jobs/pipeline.ts).
//
// Auth: CRON_SECRET bearer token, constant-time compared. Vercel Cron sends
// `Authorization: Bearer ${CRON_SECRET}` automatically when the env var is
// set. FAIL CLOSED: an unconfigured secret yields the same information-free
// 401 as a wrong one (reason server-logged only). This guard — not the cron
// scheduler — is the security boundary of these endpoints.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { createLogger } from "@/server/logger";
import { isJobStep, runJobStep } from "@/server/jobs/pipeline";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// >10x the measured worst-case pipeline step (docs: Stage 8d measurement).
export const maxDuration = 300;

const log = createLogger("jobs");

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret;
  if (!secret) {
    log.error("jobs_disabled_no_secret", {
      recovery: "set CRON_SECRET in the environment to enable scheduled jobs",
    });
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(req.headers.get("authorization") ?? "");
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: { step: string } }
) {
  try {
    if (!authorized(req)) return unauthenticatedResponse();

    if (!isJobStep(params.step)) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Unknown job step" } },
        { status: 404 }
      );
    }

    const result = await runJobStep(params.step);

    // Engine-reported FAILED surfaces as 500 so cron dashboards flag it; the
    // full failure detail lives in sync_runs + server logs, not the response.
    const httpStatus = result.status === "FAILED" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err) {
    return apiErrorResponse(err, `jobs/${params.step}`);
  }
}
