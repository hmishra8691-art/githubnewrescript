import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { listRequests, resolveRequest } from "@/lib/portalRequests";
import { readResolve } from "@/lib/portalRequestsCore";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * RESPONDENTS' PRIVACY REQUESTS FOR ONE SURVEY (Respondent Intelligence Engine, phase 5, 2026-11-20).
 *
 *   GET                          the requests addressed to this survey (a copy of data, a correction, deletion), who
 *                                asked, and what was answered. Names a person, so it needs `responses.read_pii`.
 *   POST { id, status, note }    answer one: `done` or `declined` (a refusal needs a reason; the respondent reads
 *                                the note). Needs `responses.manage`. This RECORDS the outcome — the data itself
 *                                is copied, corrected or erased with the project's own tools first. Audited.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.read_pii");
  if (isFailure(ctx)) return ctx.response;
  try {
    return json({ ok: true, ...(await listRequests(ctx)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.manage");
  if (isFailure(ctx)) return ctx.response;
  const request = readResolve(await req.json().catch(() => null));
  if ("error" in request) return json({ error: request.error }, 400);
  const out = await resolveRequest(ctx, request);
  if ("error" in out) return json({ error: out.error }, out.status);
  return json(out);
}
