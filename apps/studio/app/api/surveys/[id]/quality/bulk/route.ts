import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { cleaningProposal, type CleaningCriteria, type CleaningRow } from "@rescript/quality";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/guard";
import { missingMigration } from "@/lib/qualityDef";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * BATCH REVIEW (Intelligent Mode IM6, 2026-11-06).
 *
 *   POST { action: "preview", criteria, environment? }  → the proposal: matches with their reasons, what is skipped
 *   POST { action: "apply",   criteria, environment?, expect? } → the same proposal recomputed HERE (ids from the
 *        browser are never trusted), then one decision per row with the audited columns, one `response_reviews` row
 *        each carrying { batch, previous } — so the batch is undone as one
 *   POST { action: "undo", batch }                      → every row of the batch back to what it was before
 *   POST { action: "explain", ref }                     → one response's evidence (respondent code or session id)
 *
 * `expect` (the count the person saw) guards against applying a proposal that changed under them: if the data
 * moved, nothing is written and the new proposal is returned. Preview needs `responses.read`; apply and undo
 * `responses.manage`. Nothing is ever deleted.
 */
const DECISIONS = new Set(["REMOVE", "REVIEW_LATER", "KEEP"]);
const PAGE = 1000;

function criteriaOf(raw: unknown): CleaningCriteria | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const decision = String(o.decision ?? "");
  if (!DECISIONS.has(decision)) return "criteria.decision is REMOVE, REVIEW_LATER or KEEP";
  const strs = (v: unknown, max = 40) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 80).slice(0, max) : undefined;
  const c: CleaningCriteria = { decision: decision as CleaningCriteria["decision"] };
  const rules = strs(o.rules); if (rules?.length) c.rules = rules;
  const verdicts = strs(o.verdicts, 3); if (verdicts?.length) c.verdicts = verdicts;
  const rec = strs(o.recommendation, 3); if (rec?.length) c.recommendation = rec as CleaningCriteria["recommendation"];
  if (typeof o.minRisk === "number" && o.minRisk >= 0 && o.minRisk <= 100) c.minRisk = o.minRisk;
  if (o.includeDecided === true) c.includeDecided = true;
  if (!c.rules && !c.verdicts && !c.recommendation && c.minRisk === undefined) return "criteria need rules, verdicts, a recommendation or minRisk — a batch never selects everything";
  return c;
}

async function rowsOf(db: ReturnType<typeof supabaseAdmin>, surveyId: string, isTest: boolean): Promise<CleaningRow[] | { error: string }> {
  const out: CleaningRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    let q = db.from("responses").select("id, session_id, status, quality, review_status, review_reason, reviewed_by, reviewed_at").eq("survey_id", surveyId).eq("is_test", isTest).is("deleted_at", null);
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) return { error: error.message };
    const rows = (data ?? []) as CleaningRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  /* reading is enough to see a proposal; applying or undoing one needs responses.manage, checked again below */
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "preview");
  if (action !== "preview" && action !== "explain") {
    const manage = await requireProject(req, params.id, "responses.manage");
    if (isFailure(manage)) return manage.response;
  }
  const db = supabaseAdmin();
  const isTest = body.environment === "TEST";
  const by = gate.user.fullName || gate.user.userCode;
  const now = new Date().toISOString();

  /* one response's evidence, by its respondent code or the start of its session id ("Why was respondent R-0123 flagged?") */
  if (action === "explain") {
    const ref = typeof body.ref === "string" ? body.ref.trim().slice(0, 60) : "";
    if (!/^[A-Za-z0-9-]{2,60}$/.test(ref)) return NextResponse.json({ error: "ref is a respondent code or a session id" }, { status: 400 });
    let { data: hits } = await db.from("responses").select("session_id, respondent_code, status, quality, review_status, review_reason, reviewed_by").eq("survey_id", params.id).eq("respondent_code", ref).limit(2);
    if (!hits?.length && /^[0-9a-f-]{6,}$/i.test(ref)) ({ data: hits } = await db.from("responses").select("session_id, respondent_code, status, quality, review_status, review_reason, reviewed_by").eq("survey_id", params.id).like("session_id", `${ref.toLowerCase()}%`).limit(2));
    if (!hits?.length) return NextResponse.json({ error: `No response with the respondent code or session id “${ref}”.` }, { status: 404 });
    if (hits.length > 1) return NextResponse.json({ error: `“${ref}” matches more than one response — give the full respondent code.` }, { status: 409 });
    const h = hits[0] as { session_id: string; respondent_code: string | null; status: string; quality: { verdict: string; recommendation: string; riskScore: number; qualityScore: number; evidence?: { because: string }; flags: { title: string; observed: string; expected?: string; explanation: string; role: string; strength: string; caveat?: string }[] } | null; review_status: string | null; review_reason: string | null; reviewed_by: string | null };
    return NextResponse.json({ explain: {
      sessionId: h.session_id, respondentCode: h.respondent_code, status: h.status,
      review: h.review_status ? { status: h.review_status, reason: h.review_reason, by: h.reviewed_by } : null,
      quality: h.quality ? { verdict: h.quality.verdict, recommendation: h.quality.recommendation, risk: h.quality.riskScore, score: h.quality.qualityScore, because: h.quality.evidence?.because ?? null, flags: h.quality.flags.map((f) => ({ title: f.title, observed: f.observed, expected: f.expected ?? null, explanation: f.explanation, role: f.role, strength: f.strength, caveat: f.caveat ?? null })) } : null,
    } }, { headers: { "cache-control": "no-store" } });
  }

  if (action === "undo") {
    const batch = typeof body.batch === "string" ? body.batch : "";
    if (!/^[0-9a-f-]{36}$/i.test(batch)) return NextResponse.json({ error: "batch is the id an applied batch returned" }, { status: 400 });
    const { data: reviews, error } = await db.from("response_reviews").select("response_id, quality_snapshot").eq("survey_id", params.id).eq("quality_snapshot->>batch", batch);
    if (error) return NextResponse.json({ error: error.message }, { status: missingMigration(error.message) ? 503 : 500 });
    let restored = 0;
    for (const r of (reviews ?? []) as { response_id: string; quality_snapshot: { previous?: { status: string | null; reason: string | null; by: string | null; at: string | null } } | null }[]) {
      const p = r.quality_snapshot?.previous ?? { status: null, reason: null, by: null, at: null };
      const { error: e } = await db.from("responses").update({ review_status: p.status, review_reason: p.reason, reviewed_by: p.by, reviewed_at: p.at }).eq("id", r.response_id).eq("survey_id", params.id);
      if (e) continue;
      restored++;
      await db.from("response_reviews").insert({ response_id: r.response_id, survey_id: params.id, decision: p.status ?? "CLEAR", reason: `undo of batch ${batch.slice(0, 8)}`, decided_by: by, decided_at: now, quality_snapshot: { undoOf: batch } });
    }
    console.info("[rescript:quality] batch undone", JSON.stringify({ survey: params.id, batch, restored, by }));
    return NextResponse.json({ ok: true, restored });
  }

  const criteria = criteriaOf(body.criteria);
  if (typeof criteria === "string") return NextResponse.json({ error: criteria }, { status: 400 });
  const rows = await rowsOf(db, params.id, isTest);
  if ("error" in rows) return NextResponse.json({ error: rows.error }, { status: missingMigration(rows.error) ? 503 : 500 });
  const proposal = cleaningProposal(rows, criteria);
  const view = { ...proposal, matches: proposal.matches.slice(0, 200), matchCount: proposal.matches.length, environment: isTest ? "TEST" : "LIVE" };
  if (action === "preview") return NextResponse.json({ proposal: view }, { headers: { "cache-control": "no-store" } });
  if (action !== "apply") return NextResponse.json({ error: "action is preview, apply or undo" }, { status: 400 });
  if (typeof body.expect === "number" && body.expect !== proposal.matches.length) return NextResponse.json({ changed: true, proposal: view, error: `The data changed since the preview (${body.expect} → ${proposal.matches.length} matches) — nothing was written; review the new proposal.` }, { status: 409 });

  const batch = randomUUID();
  const prev = new Map(rows.map((r) => [r.id, r]));
  let applied = 0;
  const failed: string[] = [];
  for (const m of proposal.matches) {
    const before = prev.get(m.responseId) as (CleaningRow & { review_reason?: string | null; reviewed_by?: string | null; reviewed_at?: string | null }) | undefined;
    const reason = `batch ${batch.slice(0, 8)}: ${m.rules.join(", ") || "verdict"}`.slice(0, 1000);
    const { error } = await db.from("responses").update({ review_status: criteria.decision, review_reason: reason, reviewed_by: by, reviewed_at: now }).eq("id", m.responseId).eq("survey_id", params.id);
    if (error) { failed.push(m.sessionId); continue; }
    applied++;
    await db.from("response_reviews").insert({
      response_id: m.responseId, survey_id: params.id, decision: criteria.decision, reason, decided_by: by, decided_at: now,
      quality_snapshot: { batch, previous: { status: before?.review_status ?? null, reason: before?.review_reason ?? null, by: before?.reviewed_by ?? null, at: before?.reviewed_at ?? null }, rules: m.rules, risk: m.risk, verdict: m.verdict },
    });
  }
  console.info("[rescript:quality] batch applied", JSON.stringify({ survey: params.id, batch, decision: criteria.decision, applied, failed: failed.length, by }));
  return NextResponse.json({ ok: true, batch, applied, failed, proposal: view });
}
