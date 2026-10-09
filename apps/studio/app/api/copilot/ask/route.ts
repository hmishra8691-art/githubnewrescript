import { NextRequest, NextResponse } from "next/server";
import { aiProviderName } from "@rescript/ai";
import { Condition, SurveyDefinition } from "@rescript/schema";
import type { DataQuery } from "@rescript/engine";
import { answerDataQuery, buildDataset, type AnalyticsRow } from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject, requireUser } from "@/lib/guard";
import { buildFor, loadDefinition } from "@/lib/analytics";

/**
 * A DATA QUESTION, ANSWERED ON THE SURVEY'S DATA (Research Engine audit,
 * Phase 4). The engine in the Studio read "which groups prefer Brand A?"
 * into a query — the variable, the option, the cut, the population; this
 * route answers it on the respondent data, which only the server holds,
 * through the same dataset the analytics workspace reads (the plan's
 * derived variables included). No model is involved: the answer is the
 * numbers and the test.
 *
 * Who may ask: a signed-in user with `analytics.read` on the survey. The
 * one carve-out mirrors the copilot turn route's: against the FAKE provider
 * the sandbox may ask without a session, sending its own definition and
 * rows, so the browser suites can see the whole path — a real survey's
 * rows never come from the request.
 */
const KINDS = new Set(["share", "count", "mean", "compare", "prefer", "top"]);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function readQuery(x: unknown): DataQuery | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const kind = str(o.kind), variable = str(o.variable), question = str(o.question) ?? "";
  if (!kind || !KINDS.has(kind)) return "the query needs a kind (share, count, mean, compare, prefer, top)";
  if (!variable) return "the query needs a variable";
  const opt = o.option as Record<string, unknown> | undefined;
  const option = opt && str(opt.code) != null ? { code: str(opt.code)!, label: str(opt.label) ?? str(opt.code)! } : undefined;
  const by = Array.isArray(o.by) ? o.by.filter((v): v is string => typeof v === "string" && !!v.trim()).slice(0, 12) : undefined;
  let population: DataQuery["population"];
  if (o.population && typeof o.population === "object") {
    const p = o.population as Record<string, unknown>;
    const cond = Condition.safeParse(p.condition);
    if (!cond.success) return "the population's condition does not parse";
    population = { condition: cond.data, expression: str(p.expression, 500) ?? "", words: str(p.words, 300) ?? "" };
  }
  return { kind: kind as DataQuery["kind"], variable, question, ...(option ? { option } : {}), ...(by?.length ? { by } : {}), ...(population ? { population } : {}), words: str(o.words, 400) ?? "" };
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let body: { surveyId?: unknown; query?: unknown; definition?: unknown; rows?: unknown; environment?: unknown; dataset?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : json({ error: "bad json" }, 400); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  const sandbox = surveyId === "sandbox";
  if (isFailure(authed) && !(sandbox && aiProviderName() === "fake")) return authed.response;
  const query = readQuery(body.query);
  if (typeof query === "string") return json({ error: query }, 400);

  if (sandbox) {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return json({ error: "send the survey as it is open in the editor (definition)" }, 400);
    const rows = Array.isArray(body.rows) ? (body.rows as AnalyticsRow[]).slice(0, 5000) : [];
    if (!rows.length) return json({ error: "The sandbox has no respondents to read — open a survey with fieldwork, or ask in the Analytics workspace of a live project.", code: "no_data" }, 409);
    const dataset = buildDataset(parsed.data, rows, { spec: { environment: "ALL", dataset: "all" } });
    return json({ answer: answerDataQuery(parsed.data, dataset, query), n: dataset.cases.length, environment: "ALL", dataset: "all", source: "sandbox" });
  }

  const ctx = await requireProject(req, surveyId, "analytics.read");
  if (isFailure(ctx)) return ctx.response;
  const db = supabaseService();
  const loaded = await loadDefinition(db, surveyId);
  if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
  const environment = body.environment === "TEST" || body.environment === "ALL" ? body.environment : "LIVE";
  const dataset = body.dataset === "all" ? "all" : "clean";
  const def = loaded.def as SurveyDefinition;
  const ds = await buildFor(db, surveyId, loaded, { name: "ask", kind: "descriptive", dataset: { environment, dataset }, variables: [query.variable] });
  return json({ answer: answerDataQuery(def, ds, query), n: ds.cases.length, environment, dataset, source: "data" });
}
