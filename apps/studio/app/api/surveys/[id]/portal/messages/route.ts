import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { listThreads, openThread, reply } from "@/lib/portalMessages";
import { readReply } from "@/lib/portalNotifyCore";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MESSAGES WITH THIS SURVEY'S RESPONDENTS (Respondent Intelligence Engine, phase 6, 2026-11-20).
 *
 *   GET                         the conversations of this survey: who, the latest message, how many are unread
 *   GET ?respondent=<id>        one conversation, oldest first (opening it marks it read by the team)
 *                               Both name a person, so they need `responses.read_pii`.
 *   POST { enrolmentId, text }  reply to one respondent. Needs `responses.manage`. The respondent is told there is
 *                               a message (portal notification, and email when they have an address); the notice
 *                               never carries the text. Audited.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.read_pii");
  if (isFailure(ctx)) return ctx.response;
  const respondent = req.nextUrl.searchParams.get("respondent");
  try {
    if (respondent) return UUID.test(respondent) ? json({ ok: true, ...(await openThread(ctx, respondent)) }) : json({ error: "Choose a respondent." }, 400);
    return json({ ok: true, ...(await listThreads(ctx)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.manage");
  if (isFailure(ctx)) return ctx.response;
  const r = readReply(await req.json().catch(() => null));
  if ("error" in r) return json({ error: r.error }, 400);
  const out = await reply(ctx, r, ctx.survey.title);
  if ("error" in out) return json({ error: out.error }, out.status);
  return json(out);
}
