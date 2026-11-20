import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { rescoreStep, scoresStatus } from "@/lib/portalScores";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * STORED PORTAL SCORES FOR ONE SURVEY (Respondent Intelligence Engine, phase 2, 2026-11-20).
 *
 *   GET                  how many completed responses there are, how many carry scores of the scoring that is live
 *                        now, the comparison the portal last built, and what is wrong with the scorecard. Counts
 *                        only — no person's score. Needs `responses.read`.
 *   POST { after? }      score the next page of completed responses again; answers `next` to continue with, or
 *                        null when done. Needs `deploy.manage`. Writes scores only; no answer is changed.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.read");
  if (isFailure(ctx)) return ctx.response;
  try {
    return json({ ok: true, ...(await scoresStatus(ctx)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(ctx)) return ctx.response;
  const body = (await req.json().catch(() => null)) as { after?: unknown } | null;
  const after = typeof body?.after === "string" && UUID.test(body.after) ? body.after : null;
  const out = await rescoreStep(ctx, after);
  if ("error" in out) return json({ error: out.error }, out.status);
  return json({ ok: true, ...out });
}
