import { NextRequest, NextResponse } from "next/server";
import { can } from "@rescript/access";
import { isFailure, requireProject } from "@/lib/guard";
import { portalAct, portalList } from "@/lib/portalAdmin";
import { readPortalRequest } from "@/lib/portalAdminCore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * RESPONDENT PORTAL ACCESS FOR ONE SURVEY (Respondent Intelligence Engine, phase 1, 2026-11-20).
 *
 *   GET  ?search=&limit=&offset=     the survey's LIVE respondent list with each person's portal state: account
 *                                    (Respondent ID, invited / active), access window, attempts, paused, locked,
 *                                    reopened. Needs `responses.read`; email addresses only with `responses.read_pii`.
 *   POST { action, ids, … }          needs `deploy.manage` (the capability that manages the respondent list):
 *        create_accounts { identity: "persistent" | "assessment", sendEmail }   one account per person; joins an
 *                                    existing account by email without revealing anything about it
 *        invite                      email an invitation to set a password (accounts with an address), or return
 *                                    a link ONCE to hand over (accounts without one, created by this workspace)
 *        initial_password            a first password, shown once — only for an account with no email address
 *        suspend | reactivate        pause / restore this person's access to THIS survey
 *        lock | unlock | reopen { until }   answer editing for this person
 *        access { from, until, maxAttempts }   the access window and the number of attempts
 *        sign_out                    end the person's portal sessions
 *        unlink                      remove this survey from the person's portal (the account stays)
 *
 * A credential is never shown to a researcher for an account that has an email address (lib/portalAdminCore.ts
 * `credentialRoute`): the account may be shared with other workspaces. Every change is audited.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.read");
  if (isFailure(ctx)) return ctx.response;
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 100));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  try {
    const list = await portalList(ctx, { limit, offset, search: (sp.get("search") ?? "").slice(0, 100), showEmail: can(ctx.grant, "responses.read_pii") });
    return json({ ok: true, ...list, canManage: can(ctx.grant, "deploy.manage") });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(ctx)) return ctx.response;
  const request = readPortalRequest(await req.json().catch(() => null), Date.now());
  if ("error" in request) return json({ error: request.error }, 400);
  const out = await portalAct(ctx, request, ctx.survey.title);
  if ("error" in out) return json({ error: out.error }, out.status);
  return json(out);
}
