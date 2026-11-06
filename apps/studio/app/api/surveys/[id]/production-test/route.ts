import { NextRequest, NextResponse } from "next/server";
import { productionTest, type QuotaFill } from "@rescript/templates";
import type { QuotaCounts } from "@rescript/engine";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { publishGate } from "@/lib/publishGate";
import { surveyBaseUrl } from "@/lib/runtime-url";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A PRODUCTION-LIKE TEST (Intelligent Mode IM3, 2026-11-06).
 *
 *   POST { count?: 10–2000, fill?: [{ quota, cell?, share 0–1 }], seed? }
 *
 * The definition a launch would publish (the autosaved draft, as the test link and the regression suite use),
 * walked by simulated respondents against the LIVE quota counts (plus any simulated fullness), with the live
 * gates checked — the fieldwork window, the password, the unique links that exist — and the publish gate the
 * Publish button runs. READ-ONLY: this route reads quota_counts and counts respondents; it writes no response,
 * no counter (live or test) and no run row. `responses.read` is enough — a simulation changes nothing.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  const body = (await req.json().catch(() => ({}))) as { count?: unknown; fill?: unknown; seed?: unknown };
  const count = typeof body.count === "number" && Number.isFinite(body.count) ? Math.max(10, Math.min(2000, Math.round(body.count))) : 200;
  const fill: QuotaFill[] = Array.isArray(body.fill)
    ? body.fill.slice(0, 20).flatMap((f) => {
      const o = f as Record<string, unknown>;
      const quota = typeof o.quota === "string" ? o.quota.slice(0, 200) : "";
      const share = typeof o.share === "number" && Number.isFinite(o.share) ? Math.max(0, Math.min(1, o.share)) : 1;
      return quota ? [{ quota, ...(typeof o.cell === "string" ? { cell: o.cell.slice(0, 200) } : {}), share }] : [];
    })
    : [];

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const def = loaded.def;

  const { data: rows, error } = await db.from("quota_counts").select("quota_id, cell_id, count, is_test").eq("survey_id", params.id).eq("is_test", false);
  if (error) return NextResponse.json({ error: `The live quota counts could not be read: ${error.message}` }, { status: 500 });
  const liveCounts: QuotaCounts = {};
  for (const r of (rows ?? []) as { quota_id: string; cell_id: string; count: number }[]) (liveCounts[r.quota_id] ??= {})[r.cell_id] = r.count;

  let links: number | null = null;
  if (def.deployment.access.mode === "unique_links" || def.deployment.access.mode === "invitation") {
    const { count: n } = await db.from("respondents").select("id", { count: "exact", head: true }).eq("survey_id", params.id).eq("is_test", false);
    links = n ?? 0;
  }
  /* the same conditions for a person: the test link with the live counters and the simulated full cells */
  const { data: testDep } = await db.from("deployments").select("client_slug, study_slug").eq("survey_id", params.id).eq("mode", "test").eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const fullCells = def.quotas.flatMap((q) => q.cells.filter((c) => fill.some((f) => f.share >= 1 && (f.cell ? f.cell.toLowerCase() === c.label.toLowerCase() || f.cell === c.id : f.quota.toLowerCase() === q.name.toLowerCase() || f.quota.toLowerCase() === c.label.toLowerCase()))).map((c) => c.id));
  const testLink = testDep ? `${surveyBaseUrl(def.deployment.customDomain)}/t/${testDep.client_slug}/${testDep.study_slug}?counts=live${fullCells.length ? `&full=${encodeURIComponent(fullCells.join(","))}` : ""}` : null;
  const verdict = publishGate(def);
  const started = Date.now();
  const report = productionTest(def, { count, fill, liveCounts, links, publishBlockers: verdict.ok ? [] : verdict.problems.slice(0, 5).map((p) => `Publish would refuse: ${p.message}`), ...(typeof body.seed === "number" ? { seed: body.seed } : {}) });
  console.info("[rescript:production-test]", JSON.stringify({ surveyId: params.id, count, fills: fill.length, verdict: report.verdict, outcomes: report.outcomes, ms: Date.now() - started }));
  return NextResponse.json({ report, testLink, runsAgainst: { source: loaded.source, version: loaded.version, revision: loaded.revision } }, { headers: { "cache-control": "no-store" } });
}
