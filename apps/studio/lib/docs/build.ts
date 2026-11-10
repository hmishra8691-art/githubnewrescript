import { existsSync } from "node:fs";
import { join } from "node:path";
import { Branding, SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, formatCondition, formatSetExpression, interpretRequest, allPunchRules, formatPunchExpression, diffTheme, translatableElements, languageName } from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "@rescript/designs";
import { buildDataset, plannedAnalyses, runAnalysis, type AnalyticsRow } from "@rescript/analytics";
import { runSimulation } from "@rescript/templates";
import { DOC_EXAMPLES, exampleById, type DocExample } from "./examples.ts";

/**
 * AN EXAMPLE, BUILT (Developer Docs, 2026-11-09): the survey (actions through the engine, then the patch, then the
 * schema), the logic as the engine prints it, the stored JSON of the parts the example is about, and the builder
 * screenshots captured for it. Server-side; the page passes the result to the client example.
 */
export interface LogicLine { label: string; text: string }
/** one sentence as Intelligent Mode reads it */
export interface SaidLine { text: string; kind: string; understood: string; actions: string; applied: string[]; note?: string }
/** one analysis on simulated respondents, trimmed for the page */
export interface SampleOutput { name: string; n: number; table?: { title: string; columns: { key: string; label: string }[]; rows: Record<string, string>[] }; bars?: { label: string; value: number }[]; insights: string[]; warnings: string[]; error?: string }

registerBuiltinDesignGenerators();
export interface BuiltExample {
  id: string; title: string; tryIt: string;
  def: SurveyDefinition;
  logic: LogicLine[];
  json: string;
  builder: { images: string[]; caption: string; tab: string; question?: string; section?: string; group?: string; sub?: string };
  embedded: Record<string, string>;
  viewport?: "mobile" | "tablet";
  errors: string[];
  said: SaidLine[];
  /** the generated design file(s), as the Design Generators preview reads them */
  designs: { kind: string; name: string; file: { columns: string[]; rows: Record<string, unknown>[]; summary?: Record<string, unknown> } }[];
  output: SampleOutput[] | null;
  simulated: number;
}

const EMPTY = () => SurveyDefinition.parse({ meta: { id: "docs-example", code: "DOCS", title: "Docs example" }, questions: [], flow: [{ type: "end", id: "end_complete", status: "complete" }] });

/** drop what says nothing: undefined, empty lists and objects, false, and the default branding */
function compact(v: unknown): unknown {
  if (Array.isArray(v)) { const a = v.map(compact).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const c = compact(x); if (c !== undefined && c !== false) o[k] = c; }
    return Object.keys(o).length ? o : undefined;
  }
  return v === "" ? undefined : v;
}

function walk(nodes: unknown[], out: Record<string, unknown>[]) {
  for (const n of nodes as Record<string, unknown>[]) {
    out.push(n);
    for (const k of ["children", "otherwise"]) if (Array.isArray(n[k])) walk(n[k] as unknown[], out);
    if (Array.isArray(n.branches)) for (const b of n.branches as Record<string, unknown>[]) walk((b.children as unknown[]) ?? [], out);
  }
}

export function buildExampleDef(ex: DocExample): { def: SurveyDefinition; errors: string[]; said: SaidLine[] } {
  let n = 0;
  const ids = (prefix: string) => `${prefix}_${++n}`;
  const c = coerceSurveyActions(ex.actions);
  const errors = c.rejected.map((r) => `refused: ${String((r as { reason?: string }).reason ?? JSON.stringify(r))}`);
  const r = applySurveyActions(EMPTY(), c.actions, { ids, now: "2026-11-09T00:00:00.000Z" });
  errors.push(...r.errors);
  let def = r.def;
  const said: SaidLine[] = [];
  for (const text of ex.say ?? []) {
    const it = interpretRequest(def, text) as Record<string, any>;
    const line: SaidLine = { text, kind: it.kind, understood: String(it.understood ?? ""), actions: it.actions ? JSON.stringify(it.actions, null, 2) : "", applied: [] };
    if (it.kind === "actions") {
      const cc = coerceSurveyActions(it.actions);
      const o = applySurveyActions(def, cc.actions, { ids, now: "2026-11-09T00:00:00.000Z" });
      if (o.errors.length) line.note = `Refused at the gate: ${o.errors.join("; ")}`;
      else { def = o.def; line.applied = o.results.map((x) => x.description); }
    } else if (it.kind === "refused") line.note = String(it.reason ?? "");
    else if (it.kind === "model") line.note = `Handed to the language model: ${String(it.reason ?? "")}`;
    else if (it.kind === "clarify") line.note = `Asked back: ${String(it.question ?? "")}`;
    else if (it.kind === "answer") line.note = String(it.answer ?? "").slice(0, 400);
    said.push(line);
  }
  if (ex.patch) {
    const raw = JSON.parse(JSON.stringify(def)) as Record<string, any>;
    const q = (code: string) => { const x = (raw.questions as Record<string, any>[]).find((y) => y.code === code); if (!x) throw new Error(`${ex.id}: no question ${code}`); return x; };
    try { ex.patch(raw, q); } catch (e) { errors.push(`patch: ${(e as Error).message}`); return { def, errors, said }; }
    const parsed = SurveyDefinition.safeParse(raw);
    if (!parsed.success) errors.push(`schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    else def = parsed.data;
  }
  return { def, errors, said };
}

const DEFAULT_BRANDING = Branding.parse({});

/** the branding fields that differ from a new survey's, in the schema's own shape */
function brandingDiff(a: unknown, b: unknown): unknown {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (b && typeof b === "object" && !Array.isArray(b) && a && typeof a === "object" && !Array.isArray(a)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(b as object)) { const d = brandingDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]); if (d !== undefined) out[k] = d; }
    return Object.keys(out).length ? out : undefined;
  }
  return b;
}

function logicOf(def: SurveyDefinition): LogicLine[] {
  const lines: LogicLine[] = [];
  const code = (id?: string) => def.questions.find((q) => q.id === id)?.code ?? id ?? "?";
  for (const q of def.questions) {
    const x = q as unknown as Record<string, any>;
    if (x.displayLogic) lines.push({ label: `Display ${q.code} if`, text: formatCondition(def, x.displayLogic) });
    for (const s of (x.skipLogic ?? []) as Record<string, any>[]) {
      const t = s.target ?? {};
      const to = t.kind === "question" ? code(t.ref) : t.kind === "terminate" ? `terminate (${t.status ?? "terminated"})` : t.kind === "end" ? "the end" : `${t.kind} ${t.ref ?? ""}`.trim();
      lines.push({ label: `After ${q.code}, skip to ${to} if`, text: formatCondition(def, s.when) });
    }
    for (const v of (x.validation ?? []) as Record<string, any>[]) {
      if (v.kind === "condition" && v.check) lines.push({ label: `${q.code} is invalid when`, text: formatCondition(def, v.check) });
      else if (v.kind !== "required") lines.push({ label: `${q.code} validation`, text: `${v.kind}${v.value !== undefined ? ` ${JSON.stringify(v.value)}` : ""}${v.message ? `  -- "${v.message}"` : ""}` });
    }
    const pipes = [x.text, x.instruction].filter(Boolean).join(" ").match(/\{\{[^}]+\}\}/g);
    if (pipes) lines.push({ label: `Piping in ${q.code}`, text: [...new Set(pipes)].join("  ") });
    for (const [key, what] of [["mask", "options"], ["rowMask", "rows"], ["columnMask", "columns"]] as const) {
      const m = x[key];
      if (m?.expr) lines.push({ label: `${q.code} ${what} mask (${m.action ?? "display"})`, text: formatSetExpression(def, m.expr) });
    }
    if (x.carryForward) lines.push({ label: `${q.code} carry-forward`, text: `${x.carryForward.filter} options of ${code(x.carryForward.sourceQuestionId)} → ${x.carryForward.into}` });
    for (const l of (x.listLogic ?? []) as Record<string, any>[]) lines.push({ label: `${q.code} list logic`, text: `${l.action} ${l.which} options of ${code(l.sourceQuestionId)}` });
    if (x.randomization?.enabled) lines.push({ label: `${q.code} randomization`, text: `${x.randomization.method ?? "shuffle"} ${x.randomization.scope ?? "options"}; anchored options stay in place` });
  }
  const nodes: Record<string, unknown>[] = [];
  walk(def.flow as unknown[], nodes);
  for (const nd of nodes as Record<string, any>[]) {
    if (nd.type === "branch") for (const b of nd.branches ?? []) lines.push({ label: `Branch “${b.label ?? nd.title ?? "path"}” when`, text: formatCondition(def, b.when) });
    if (nd.type === "quota_check") lines.push({ label: "Quota check", text: `quotas ${(nd.quotaIds ?? []).join(", ")}; when full: ${nd.onFull?.kind ?? "terminate"}` });
    if (nd.type === "redirect") lines.push({ label: "Redirect to", text: nd.url });
  }
  /* auto-punch rules, written exactly as the builder's Auto punch editor shows them */
  const punches = new Map<string, string[]>();
  for (const { target, rule } of allPunchRules(def)) punches.set(target.code, [...(punches.get(target.code) ?? []), formatPunchExpression(def, target, rule)]);
  for (const [c, rules] of punches) lines.push({ label: `Auto-punch on ${c}`, text: rules.join("\n") });
  /* the translations: per language, each translated element and its status, as the Translate tab lists them */
  for (const [lang, entries] of Object.entries(def.localization?.translations ?? {})) {
    const els = new Map(translatableElements(def).map((e) => [e.key, e.label]));
    const rows = Object.entries(entries as Record<string, { text: string; status?: string }>).map(([k, v]) => `${els.get(k) ?? k}  [${v.status ?? "?"}]  ${v.text}`);
    if (rows.length) lines.push({ label: `Translations — ${languageName(lang)} (${lang})`, text: rows.join("\n") });
  }
  /* the theme: every setting that differs from a new survey's, as the Branding workspace names the change */
  const theme = diffTheme(DEFAULT_BRANDING, def.branding);
  if (theme.length) lines.push({ label: "Theme (Branding) — what differs from the defaults", text: theme.join("\n") });
  for (const qt of (def.quotas ?? []) as Record<string, any>[]) for (const cell of qt.cells ?? []) lines.push({ label: `Quota ${qt.name} — ${cell.label} (limit ${cell.limit})`, text: formatCondition(def, cell.when) });
  return lines;
}

const fmt = (v: unknown): string => (v == null || v === "" ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : typeof v === "object" ? JSON.stringify(v) : String(v));

/** the example's analyses on the Studio's own simulated respondents */
export function sampleOutput(ex: DocExample, def: SurveyDefinition): { output: SampleOutput[]; n: number } | null {
  if (!ex.analysis) return null;
  const count = ex.simulate ?? 150;
  const report = runSimulation(def, { count, seed: 20261109, edgeRate: 0, completeShare: 1, probeInvalid: false });
  const rows: AnalyticsRow[] = report.journeys.map((j, i) => ({ id: `sim${i}`, session_id: `sim${i}`, status: j.endStatus === "complete" ? "complete" : j.endStatus, answers: j.answers, calculated: j.calculated, embedded: {}, flags: [] }) as AnalyticsRow);
  const spec = { environment: "LIVE" as const, dataset: "all" as const };
  const ds = buildDataset(def, rows, { spec });
  const defs = ex.analysis === "plan"
    ? plannedAnalyses(def, spec).map((p) => p.definition)
    : ex.analysis.map((a) => ({ name: a.label ?? a.kind, kind: a.kind, dataset: spec, variables: a.variables, ...(a.rows ? { rows: a.rows } : {}), ...(a.columns ? { columns: a.columns } : {}), ...(a.options ? { options: a.options } : {}) }));
  const output: SampleOutput[] = [];
  for (const d of defs.slice(0, 3)) {
    let res: Record<string, any>;
    try { res = runAnalysis(d as never, ds) as unknown as Record<string, any>; } catch (e) { output.push({ name: String(d.name), n: 0, insights: [], warnings: [], error: (e as Error).message }); continue; }
    const t = res.tables?.[0];
    const chart = res.chart ?? {};
    const series = chart.series?.[0];
    output.push({
      name: String(d.name), n: res.base?.n ?? 0,
      ...(t ? { table: { title: t.title, columns: t.columns.slice(0, 8).map((c: { key: string; label: string }) => ({ key: c.key, label: c.label })), rows: t.rows.slice(0, 12).map((row: Record<string, unknown>) => Object.fromEntries(t.columns.slice(0, 8).map((c: { key: string }) => [c.key, fmt(row[c.key])]))) } } : {}),
      ...(series && Array.isArray(chart.categories) ? { bars: chart.categories.slice(0, 12).map((label: unknown, i: number) => ({ label: String(label), value: Number(series.values?.[i] ?? 0) || 0 })) } : {}),
      insights: (res.insights ?? []).slice(0, 3), warnings: (res.warnings ?? []).slice(0, 2),
      ...(res.error ? { error: res.error.message } : {}),
    });
  }
  return { output, n: report.journeys.length };
}

const MEDIA = () => {
  const cands = [join(process.cwd(), "public", "docs-media", "builder"), join(process.cwd(), "apps", "studio", "public", "docs-media", "builder")];
  return cands.find((d) => existsSync(d)) ?? cands[0];
};

const CACHE = new Map<string, BuiltExample>();
export function buildExample(id: string): BuiltExample | null {
  const hit = CACHE.get(id);
  if (hit && process.env.NODE_ENV === "production") return hit;
  const ex = exampleById(id);
  if (!ex) return null;
  const { def, errors, said } = buildExampleDef(ex);
  const sample = sampleOutput(ex, def);
  const show = ex.show ? def.questions.filter((q) => ex.show!.includes(String(q.code))) : def.questions;
  const nodes: Record<string, unknown>[] = [];
  walk(def.flow as unknown[], nodes);
  const flow = (ex.flow ?? []).flatMap((t) => nodes.filter((nd) => nd.type === t)).map((nd) => {
    const { children: _c, ...rest } = nd as Record<string, unknown>;
    return Array.isArray(_c) ? { ...rest, children: (_c as Record<string, unknown>[]).map((k) => `${k.type}${k.title ? ` “${k.title}”` : ""} (${k.id})`) } : rest;
  });
  const extra: Record<string, unknown> = {};
  if (def.embeddedData?.length) extra.embeddedData = def.embeddedData;
  if (def.quotas?.length) extra.quotas = def.quotas;
  if ((def as Record<string, any>).panels?.length) extra.panels = (def as Record<string, any>).panels;
  if ((def as Record<string, any>).alerts) extra.alerts = (def as Record<string, any>).alerts;
  if (def.designs?.length) extra.designs = def.designs.map((d) => ({ id: d.id, kind: d.kind, name: d.name, version: d.version, seed: d.seed, config: d.config, file: `${d.file?.rows?.length ?? 0} rows (shown above as the design)` }));
  const bd = brandingDiff(DEFAULT_BRANDING, def.branding);
  if (bd) extra.branding = bd;
  if (def.localization && Object.keys(def.localization.translations ?? {}).length) extra.localization = def.localization;
  if (def.ux && ((def.ux.styles?.length ?? 0) + (def.ux.behaviors?.length ?? 0)) > 0) extra.ux = { styles: def.ux.styles, behaviors: def.ux.behaviors };
  const json = JSON.stringify(compact({ questions: show, ...(flow.length ? { flow } : {}), ...extra }), null, 2);
  const dir = MEDIA();
  const pick = (base: string) => [`${base}.webp`, `${base}.png`].find((f) => existsSync(join(dir, f)));
  const images = [pick(`${id}-say`), pick(`${id}-panel`), pick(id)].filter((f): f is string => !!f).map((f) => `/docs-media/builder/${f}`);
  const built: BuiltExample = {
    id, title: ex.title, tryIt: ex.tryIt, def, logic: logicOf(def), json, embedded: ex.embedded ?? {}, errors, said, output: sample?.output ?? null,
    designs: (def.designs ?? []).filter((d) => d.file?.rows?.length).map((d) => ({ kind: d.kind, name: d.name, file: { columns: d.file!.columns ?? [], rows: (d.file!.rows as Record<string, unknown>[]).slice(0, 3000), ...(d.file!.summary ? { summary: d.file!.summary as Record<string, unknown> } : {}) } })), simulated: sample?.n ?? 0,
    builder: { images, caption: ex.builder.caption, tab: ex.builder.intelligent ? "Intelligent Mode" : ex.builder.tab ?? "Questions", question: ex.builder.question, section: ex.builder.section, group: ex.builder.group, sub: ex.builder.sub },
    viewport: ex.viewport,
  };
  CACHE.set(id, built);
  return built;
}

export const allExampleIds = () => DOC_EXAMPLES.map((e) => e.id);
