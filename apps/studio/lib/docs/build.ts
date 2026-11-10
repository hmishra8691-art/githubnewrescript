import { existsSync } from "node:fs";
import { join } from "node:path";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, formatCondition, formatSetExpression } from "@rescript/engine";
import { DOC_EXAMPLES, exampleById, type DocExample } from "./examples.ts";

/**
 * AN EXAMPLE, BUILT (Developer Docs, 2026-11-09): the survey (actions through the engine, then the patch, then the
 * schema), the logic as the engine prints it, the stored JSON of the parts the example is about, and the builder
 * screenshots captured for it. Server-side; the page passes the result to the client example.
 */
export interface LogicLine { label: string; text: string }
export interface BuiltExample {
  id: string; title: string; tryIt: string;
  def: SurveyDefinition;
  logic: LogicLine[];
  json: string;
  builder: { images: string[]; caption: string; tab: string; question?: string; section?: string };
  embedded: Record<string, string>;
  errors: string[];
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

export function buildExampleDef(ex: DocExample): { def: SurveyDefinition; errors: string[] } {
  let n = 0;
  const ids = (prefix: string) => `${prefix}_${++n}`;
  const c = coerceSurveyActions(ex.actions);
  const errors = c.rejected.map((r) => `refused: ${String((r as { reason?: string }).reason ?? JSON.stringify(r))}`);
  const r = applySurveyActions(EMPTY(), c.actions, { ids, now: "2026-11-09T00:00:00.000Z" });
  errors.push(...r.errors);
  let def = r.def;
  if (ex.patch) {
    const raw = JSON.parse(JSON.stringify(def)) as Record<string, any>;
    const q = (code: string) => { const x = (raw.questions as Record<string, any>[]).find((y) => y.code === code); if (!x) throw new Error(`${ex.id}: no question ${code}`); return x; };
    try { ex.patch(raw, q); } catch (e) { errors.push(`patch: ${(e as Error).message}`); return { def, errors }; }
    const parsed = SurveyDefinition.safeParse(raw);
    if (!parsed.success) errors.push(`schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    else def = parsed.data;
  }
  return { def, errors };
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
  for (const qt of (def.quotas ?? []) as Record<string, any>[]) for (const cell of qt.cells ?? []) lines.push({ label: `Quota ${qt.name} — ${cell.label} (limit ${cell.limit})`, text: formatCondition(def, cell.when) });
  return lines;
}

const MEDIA = () => {
  const cands = [join(process.cwd(), "public", "docs-media", "builder"), join(process.cwd(), "apps", "studio", "public", "docs-media", "builder")];
  return cands.find((d) => existsSync(d)) ?? cands[0];
};

export function buildExample(id: string): BuiltExample | null {
  const ex = exampleById(id);
  if (!ex) return null;
  const { def, errors } = buildExampleDef(ex);
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
  if (def.ux && ((def.ux.styles?.length ?? 0) + (def.ux.behaviors?.length ?? 0)) > 0) extra.ux = { styles: def.ux.styles, behaviors: def.ux.behaviors };
  const json = JSON.stringify(compact({ questions: show, ...(flow.length ? { flow } : {}), ...extra }), null, 2);
  const dir = MEDIA();
  const pick = (base: string) => [`${base}.webp`, `${base}.png`].find((f) => existsSync(join(dir, f)));
  const images = [pick(`${id}-panel`), pick(id)].filter((f): f is string => !!f).map((f) => `/docs-media/builder/${f}`);
  return {
    id, title: ex.title, tryIt: ex.tryIt, def, logic: logicOf(def), json, embedded: ex.embedded ?? {}, errors,
    builder: { images, caption: ex.builder.caption, tab: ex.builder.tab ?? "Questions", question: ex.builder.question, section: ex.builder.section },
  };
}

export const allExampleIds = () => DOC_EXAMPLES.map((e) => e.id);
