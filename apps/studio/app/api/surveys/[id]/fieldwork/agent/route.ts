import { NextRequest, NextResponse } from "next/server";
import { decideProposal, openProposals, proposeFieldworkActions, type FieldworkProposal, type FieldworkSnapshot, type Pace, type ProposalDecision } from "@rescript/analytics";
import { customerDb } from "@/lib/db";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * THE FIELDWORK AGENT (audit 2026-11-17, P3-03; the rules: packages/analytics/src/fieldworkAgent.ts).
 *
 *   POST { pace, fieldTo? }                          → { proposals, decided } — the pace is the fieldwork dashboard's own
 *                                                     (GET …/fieldwork); quotas, quality and sources are read here
 *   POST { decide: { proposal, decision, reason } }  → the decision, logged as `fieldwork.proposal_decided`
 *
 * Proposals only. A proposal's tool runs through /api/surveys/{id}/tools, with its dry run and its approval.
 * Live responses only (fieldwork is the live link).
 */
const RECENT_HOURS = 24;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const db = customerDb(gate.survey.customer_id);

  if (body?.decide) {
    const p = body.decide.proposal as FieldworkProposal | undefined;
    if (!p || typeof p.id !== "string" || typeof p.kind !== "string") return NextResponse.json({ error: "Send the proposal you are deciding." }, { status: 400 });
    const d = decideProposal(p, body.decide.decision === "accept" ? "accept" : "reject", String(body.decide.reason ?? ""), gate.user.userId);
    if ("error" in d) return NextResponse.json(d, { status: 400 });
    await audit({ action: "fieldwork.proposal_decided", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "fieldwork_proposal", entityId: null, detail: { ...d, saw: p.saw, propose: p.propose } });
    return NextResponse.json({ ok: true, decision: d });
  }

  const pace = body?.pace as Pace | undefined;
  if (!pace || typeof pace.verdict !== "string") return NextResponse.json({ error: "Send the pace from the fieldwork dashboard (GET …/fieldwork)." }, { status: 400 });
  const loaded = await loadDefinition(db as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  /* quotas: the cells with a target (or a count limit), and their live counts */
  const { data: counts } = await db.from("quota_counts").select("quota_id, cell_id, count").eq("survey_id", params.id).eq("is_test", false);
  const countOf = new Map(((counts ?? []) as { quota_id: string; cell_id: string; count: number }[]).map((c) => [`${c.quota_id}|${c.cell_id}`, Number(c.count)]));
  const cells = (loaded.def.quotas ?? []).flatMap((q: any) => (q.cells ?? []).filter((c: any) => (c.target ?? (c.limitType === "count" ? c.limit : 0)) > 0).map((c: any) => ({ quota: q.name, cell: c.id, label: c.label, target: Number(c.target ?? c.limit), count: countOf.get(`${q.id}|${c.id}`) ?? 0 })));

  /* quality and sources: finished live responses */
  const since = new Date(Date.now() - RECENT_HOURS * 3_600_000).toISOString();
  const { data: rows } = await db.from("responses").select("completed_at, sample_source, quality").eq("survey_id", params.id).eq("is_test", false).eq("status", "complete").is("deleted_at", null).limit(20000);
  const rs = (rows ?? []) as { completed_at: string | null; sample_source: string | null; quality: { verdict?: string; classification?: string } | null }[];
  const flagged = (r: (typeof rs)[number]) => !!r.quality && (r.quality.verdict === "FLAGGED" || (!r.quality.verdict && !["CLEAN", "REVIEW"].includes(String(r.quality.classification))));
  const assessed = rs.filter((r) => r.quality);
  const recent = assessed.filter((r) => r.completed_at && r.completed_at >= since);
  const bySource = new Map<string, { completes: number; flagged: number }>();
  for (const r of rs) { const k = r.sample_source ?? "(no source)"; const s = bySource.get(k) ?? { completes: 0, flagged: 0 }; s.completes++; if (flagged(r)) s.flagged++; bySource.set(k, s); }

  const snap: FieldworkSnapshot = {
    surveyId: params.id, now: new Date().toISOString(), pace, fieldTo: typeof body?.fieldTo === "string" ? body.fieldTo : null, cells,
    quality: { assessed: assessed.length, flagged: assessed.filter(flagged).length, recentAssessed: recent.length, recentFlagged: recent.filter(flagged).length, recentHours: RECENT_HOURS },
    sources: [...bySource].filter(([k]) => k !== "(no source)").map(([name, s]) => ({ name, ...s })),
  };
  const proposals = proposeFieldworkActions(snap);
  const { data: log } = await db.from("audit_logs").select("detail, created_at").eq("survey_id", params.id).eq("action", "fieldwork.proposal_decided").order("created_at", { ascending: false }).limit(200);
  const decided = ((log ?? []) as { detail: ProposalDecision }[]).map((r) => r.detail).filter((d) => d && typeof d.proposalId === "string");
  return NextResponse.json({ proposals: openProposals(proposals, decided), decided: decided.slice(0, 50) }, { headers: { "cache-control": "no-store" } });
}
