import { NextRequest, NextResponse } from "next/server";
import { aiModelName, aiProviderName } from "@rescript/ai";
import { priceSpec } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireAdmin } from "@/lib/guard";
import { getMeter, getSandboxMeter } from "@/lib/metering";
import { adminCases, type EvalCase } from "@/lib/eval/cases";
import { inProcessDeps } from "@/lib/eval/harness";
import { runCase, type UsageLike } from "@/lib/eval/runner";
import { reportMarkdown, summarize } from "@/lib/eval/report";
import { ADMIN_MAX_CASES, adminCapCeiling, adminRunStore, estimateCase, keptResult, mayRunCase } from "@/lib/eval/adminRun";
/* the REAL turn handler, called in-process with the administrator's own session: the same pipeline the Studio runs */
import { POST as turnPOST } from "@/app/api/copilot/turn/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * RUN THE AI EVALUATION AGAINST THIS INSTALLATION'S PROVIDER (platform administrators, 2026-10-18).
 *
 *   GET                                  the cases (≤10), the provider, the estimate, the cap, the last runs
 *   POST { action: "start", caseIds, capUsd }   a run: the estimate first; refused when it exceeds the cap
 *   POST { action: "case", runId, caseId }      ONE case (each request stays inside the time limit); the cap is
 *                                               checked before it with what is spent so far plus its estimate
 *   POST { action: "finish", runId }            the report (pass rates, tokens incl. cache, cost, latency)
 *
 * SAFE BY CONSTRUCTION: every case runs in the SANDBOX project — no customer project is read or written, no
 * customer wallet is charged (the sandbox meter is in memory); the provider cost of every call is metered to the
 * platform and kept with the run (`ai_eval_runs`, migration 0068). The turn handler is the production one, called
 * with this administrator's session; if the administrator chose their own AI provider for Intelligent Mode, the
 * run uses it and says so (byok calls).
 */
const store = () => adminRunStore(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? supabaseAdmin() : null);
const pricedModel = () => (aiProviderName() === "fake" ? "claude-sonnet-4-6" : aiModelName());

async function estimator() {
  const meter = getMeter();
  const [cfg, rates, events] = await Promise.all([meter.config(), meter.rates(), meter.events()]);
  const model = pricedModel();
  const price = (input: number, output: number) => priceSpec({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model, inputUnits: input, outputUnits: output }, "LIVE", cfg, rates, events).breakdown.providerCost;
  return (c: EvalCase) => estimateCase(c, price);
}
const providerInfo = () => ({ configured: !!aiProviderName(), fake: aiProviderName() === "fake", model: aiProviderName() === "fake" ? "fake" : aiModelName(), host: (() => { try { return new URL(process.env.AI_API_URL ?? "").host; } catch { return null; } })() });

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  const est = await estimator();
  const cases = adminCases().map((c) => ({ id: c.id, title: c.title, category: c.category, turns: c.turns.length, estimateUsd: est(c) }));
  const s = store();
  const recent = await s.recent(5).catch(() => []);
  return NextResponse.json({ ok: true, provider: providerInfo(), pricedModel: pricedModel(), cases, estimateUsd: Math.round(cases.reduce((n, c) => n + c.estimateUsd, 0) * 1e6) / 1e6, capCeilingUsd: adminCapCeiling(), durable: s.durable, recent: recent.map((r) => ({ id: r.id, status: r.status, model: r.model, cases: r.caseIds.length, capUsd: r.capUsd, spentUsd: r.spentUsd, createdAt: r.createdAt, passRate: (r.report as { summary?: { passRate?: number } } | null)?.summary?.passRate ?? null })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  const body = await req.json().catch(() => ({})) as { action?: unknown; caseIds?: unknown; capUsd?: unknown; runId?: unknown; caseId?: unknown };
  if (!aiProviderName()) return NextResponse.json({ error: "No language model is configured on this installation (AI_API_URL)." }, { status: 501 });
  const all = adminCases();
  const est = await estimator();
  const s = store();

  if (body.action === "start") {
    const ids = Array.isArray(body.caseIds) ? [...new Set(body.caseIds.map(String))] : all.map((c) => c.id);
    const chosen = all.filter((c) => ids.includes(c.id)).slice(0, ADMIN_MAX_CASES);
    if (!chosen.length) return NextResponse.json({ error: "Choose at least one of the listed cases." }, { status: 400 });
    const ceiling = adminCapCeiling();
    const cap = Number(body.capUsd);
    if (!Number.isFinite(cap) || cap <= 0 || cap > ceiling) return NextResponse.json({ error: `Set a cap between $0.01 and $${ceiling.toFixed(2)} (PLATFORM_EVAL_MAX_USD).` }, { status: 400 });
    const estimateUsd = Math.round(chosen.reduce((n, c) => n + est(c), 0) * 1e6) / 1e6;
    if (estimateUsd > cap) return NextResponse.json({ error: `The estimate ($${estimateUsd.toFixed(4)}) is above the cap ($${cap.toFixed(2)}). Raise the cap or choose fewer cases.`, estimateUsd }, { status: 409 });
    const run = await s.create({ createdBy: admin.userId, provider: providerInfo().host ?? (providerInfo().fake ? "fake" : "provider"), model: providerInfo().model, caseIds: chosen.map((c) => c.id), capUsd: cap, estimateUsd });
    return NextResponse.json({ ok: true, run: { id: run.id, caseIds: run.caseIds, capUsd: run.capUsd, estimateUsd: run.estimateUsd }, durable: s.durable });
  }

  const runId = typeof body.runId === "string" ? body.runId : "";
  const run = runId ? await s.get(runId) : null;
  if (!run) return NextResponse.json({ error: "That run was not found (a run kept in memory ends with the server instance; apply migration 0068 to keep runs)." }, { status: 404 });

  if (body.action === "case") {
    const c = all.find((x) => x.id === body.caseId);
    if (!c) return NextResponse.json({ error: "Unknown case." }, { status: 400 });
    const allowed = mayRunCase(run, c.id, est(c));
    if (!allowed.ok) {
      if (allowed.capped) await s.save({ ...run, status: "capped" });
      return NextResponse.json({ error: allowed.reason, capped: !!allowed.capped }, { status: 409 });
    }
    const cookie = req.headers.get("cookie") ?? "";
    const deps = inProcessDeps({
      call: (b, headers) => turnPOST(new NextRequest(new URL("/api/copilot/turn", req.nextUrl.origin), { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ ...b, surveyId: "sandbox" }) })),
      /* this administrator's sandbox usage only: the meter is shared by the instance */
      store: () => ({ usage: (getSandboxMeter().store as unknown as { usage: (UsageLike & { userId?: string | null })[] }).usage.filter((e) => e.userId === admin.userId) }),
      fake: aiProviderName() === "fake",
    });
    const result = await runCase(c, deps);
    const spentUsd = Math.round((run.spentUsd + result.costUsd) * 1e6) / 1e6;
    const next = await s.save({ ...run, spentUsd, results: [...run.results, keptResult(result)], status: spentUsd >= run.capUsd ? "capped" : "running" });
    return NextResponse.json({ ok: true, result: keptResult(result), spentUsd: next.spentUsd, capUsd: next.capUsd, status: next.status });
  }

  if (body.action === "finish") {
    const summary = summarize(run.results);
    const report = { meta: { startedAt: run.createdAt, finishedAt: new Date().toISOString(), mode: providerInfo().fake ? "fake" as const : "live" as const, provider: run.provider, model: run.model, key: `${providerInfo().fake ? "fake" : "live"}:${run.model}`, cases: run.results.length, notes: [`/platform admin run — sandbox only, metered to the platform; cap $${run.capUsd.toFixed(2)}, spent $${run.spentUsd.toFixed(4)}.`] }, summary, cases: run.results };
    await s.save({ ...run, report, status: run.status === "running" ? "finished" : run.status });
    return NextResponse.json({ ok: true, report, markdown: reportMarkdown(report) });
  }
  return NextResponse.json({ error: "action is start, case or finish" }, { status: 400 });
}
