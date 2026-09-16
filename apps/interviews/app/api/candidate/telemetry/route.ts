import { NextRequest, NextResponse } from "next/server";
import { candidateGate, isCandidateFailure, recordTelemetry, touchInterview } from "@/lib/candidate";

export const dynamic = "force-dynamic";

/**
 * The browser's account of itself.
 *
 * Batched — a tab that fires one request per visibility change on a flaky
 * connection is competing with the upload for the same bandwidth, on behalf
 * of data nobody is waiting for. The browser collects and flushes; this
 * accepts up to 200 at a time and drops anything whose kind is not in the
 * product's vocabulary.
 *
 * It always answers 200. Telemetry failing is never a reason a candidate sees
 * an error, and a browser that retries a failed telemetry post is a browser
 * spending a candidate's bandwidth on our convenience.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return NextResponse.json({ ok: true, recorded: 0 });

  const recorded = await recordTelemetry(gate, body?.events);
  await touchInterview(gate);
  return NextResponse.json({ ok: true, recorded });
}
