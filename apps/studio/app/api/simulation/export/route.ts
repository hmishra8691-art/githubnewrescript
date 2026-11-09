import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { runSimulation, simulationStates, type SimulationConfig } from "@rescript/templates";
import { exportResponsesXlsx, responsesToCSV } from "@rescript/exporters";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/simulation/export { surveyId, definition, config, format: "xlsx" | "csv" } — the simulated respondents of a
 * run, as a file (2026-11-09). Deterministic from the definition and the configuration's seed, so the file holds exactly
 * the respondents the Studio previewed. Nothing is stored; every row is marked TEST with its SIMULATED_RUN.
 * `project.read` on a saved project; the sandbox may download without a session.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: { surveyId?: unknown; definition?: unknown; config?: unknown; format?: unknown; runId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  if (surveyId !== "sandbox") {
    if (isFailure(user)) return user.response;
    const ctx = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
  }
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open (definition)" }, { status: 400 });
  const cfg = (body.config ?? {}) as SimulationConfig;
  const count = Math.round(Number(cfg.count) || 0);
  if (count < 1 || count > 2000) return NextResponse.json({ error: "Simulate between 1 and 2000 respondents at a time." }, { status: 400 });
  const runId = typeof body.runId === "string" && /^[A-Z0-9]{1,12}$/.test(body.runId) ? body.runId : undefined;
  const report = runSimulation(parsed.data, { ...cfg, count }, runId ? { runId } : {});
  const states = simulationStates(report, { startedAt: Date.UTC(2026, 0, 1) });
  const name = `${(parsed.data.meta.code || "survey").replace(/[^A-Za-z0-9_-]/g, "")}_simulated_${report.runId}`;
  if (body.format === "csv") {
    const csv = responsesToCSV(parsed.data, states as never);
    return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
  }
  const buf = await exportResponsesXlsx(parsed.data, states.map((s) => ({ state: s as never, quality: null, review: { status: null } }) as never), { environmentColumn: true });
  return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}.xlsx"`, "cache-control": "no-store" } });
}
