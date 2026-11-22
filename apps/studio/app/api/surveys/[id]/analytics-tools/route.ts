import { NextRequest, NextResponse } from "next/server";
import { autoTabPlan, checkTabPlan, runTabPlan, turfPortfolio, type AnalysisDefinition, type DatasetSpec, type TabPlan } from "@rescript/analytics";
import { buildTabBook } from "@rescript/analytics/export";
import { can } from "@rescript/access";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { buildFor, loadDefinition } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * ANALYTICS TOOLS THAT NEED THE DATA (Level 5 roadmap M2, M3 — screens 2026-11-22).
 *
 * POST { tool: "tab_plan", banner: { columns: string[] }, plan?: TabPlan, dataset?, format?: "json" | "xlsx" }
 *        the draft plan (from the banner) or the plan given, run over the data: every table with its base and
 *        warnings, and the plan's problems; "xlsx" returns the tab book (contents sheet, one sheet per table) and
 *        needs report downloads (Data Analytics: Export)
 * POST { tool: "turf_portfolio", battery: string[], portfolio: string[], dataset? }
 *        the line-up's reach and frequency, each item's unique reach, the best item to add and the best swap
 *
 * The MaxDiff share and price what-ifs need no data — they read the analysis result already on screen.
 * Who may call: Data Analytics: View.
 */
const MAX_TABLES_JSON = 200;
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.read");
  if (isFailure(gate)) return gate.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Send a JSON body with a tool." }, 400);
  const loaded = await loadDefinition(gate.db as never, params.id);
  if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
  const spec = ((body.dataset && typeof body.dataset === "object" ? body.dataset : null) ?? { environment: "LIVE", dataset: "all" }) as DatasetSpec;
  const ds = await buildFor(gate.db as never, params.id, loaded, { kind: "descriptive", name: "tools", variables: [], dataset: spec } as unknown as AnalysisDefinition);
  if (!ds.cases.length) return json({ error: `No ${spec.environment === "TEST" ? "test" : "live"} completes yet, so there is nothing to tabulate.` }, 409);

  if (body.tool === "tab_plan") {
    const columns = Array.isArray((body.banner as { columns?: unknown })?.columns) ? ((body.banner as { columns: unknown[] }).columns).map(String).filter((c) => ds.byName.has(c)).slice(0, 8) : [];
    if (!columns.length && !body.plan) return json({ error: "Choose at least one banner variable (the columns every table is cut by)." }, 400);
    const plan = (body.plan as TabPlan | undefined) ?? autoTabPlan(ds, { columns }, { name: `${gate.survey.title} — tables`, dataset: spec });
    const problems = checkTabPlan(plan, ds);
    const run = runTabPlan(plan, ds);
    if (body.format === "xlsx") {
      if (!can(gate.grant, "analytics.export")) return json({ error: "Your access to this project does not include report downloads.", code: "insufficient_role" }, 403);
      const labelOf = (v: string) => ds.byName.get(v)?.label ?? v;
      const buf = await buildTabBook(run, { labelOf, meta: { Survey: gate.survey.title, Respondents: ds.cases.length, Banner: plan.banner.columns.map(labelOf).join(", ") } });
      void audit({ action: "analytics.export_generated", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "analytics", entityId: null, detail: { name: plan.name, format: "xlsx", tabBook: true, tables: run.tables.length } });
      return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${(gate.survey.title || "tables").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "tables"}_tab_book.xlsx"` } });
    }
    return json({ plan, problems: [...new Set([...problems, ...run.problems])], respondents: ds.cases.length, tables: run.tables.slice(0, MAX_TABLES_JSON).map((t) => ({ id: t.id, number: t.number, title: t.title, kind: t.kind, base: t.base, warnings: t.warnings, table: t.table })), truncated: run.tables.length > MAX_TABLES_JSON ? run.tables.length : undefined });
  }

  if (body.tool === "turf_portfolio") {
    const battery = Array.isArray(body.battery) ? body.battery.map(String) : [];
    const portfolio = Array.isArray(body.portfolio) ? body.portfolio.map(String) : [];
    const r = turfPortfolio(ds, battery, portfolio);
    return "error" in r ? json({ error: r.error }, 400) : json(r);
  }
  return json({ error: "tool is tab_plan or turf_portfolio." }, 400);
}
