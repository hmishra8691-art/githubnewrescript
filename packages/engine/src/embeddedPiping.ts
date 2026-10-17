import type { SurveyDefinition, FlowNode } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { createResponseState, getQuestionByCodeOrVar, type LoopContext, type ResponseState } from "./state.js";
import { PIPE_TOKEN_RE, parsePipeBody, type PipeToken } from "./pipingTokens.js";
import { lintPipingTokens, resolvePipingText } from "./piping.js";
import {
  applyEmbeddedField, coerceEmbedded, embeddedCatalog, embeddedFieldName, embeddedTypeOf,
  normalizeExpression, referencedNames, isNamedEmbeddedField, type EmbeddedField,
} from "./embedded.js";
import { noteCalcOutcome } from "./calcContext.js";
import { detectValueType } from "./listValue.js";
import "./systemPipes.js";

/**
 * PIPING IN AN EMBEDDED DATA VALUE (document 15/10/2026, item A).
 *
 * `TOTAL_CALORIES = {{ed.LOWCAL_1}}`, `Customer: {{ed.CustomerName}}`,
 * `{{ed.FirstName}} {{ed.LastName}}` — a Fixed value may pipe, with the
 * platform's own tokens and resolver (`piping.ts`). It used to be stored as
 * the literal text: the screenshot's `stored as string: "{{ed.ZIP_CODE}}"`.
 *
 * The value is resolved WHERE THE ELEMENT RUNS in the flow — the same walk
 * (`moveForward`) for a live respondent, a test link and the Studio's preview,
 * which all run the same Runner — so a field set earlier in the flow, or
 * earlier in the same element, is already there ("chained" fields), and what
 * is stored is the resolved value, typed by the field's declared type.
 *
 * A REFERENCE THAT RESOLVES TO NOTHING follows the survey's one setting for
 * empty embedded data, `calculationSettings.emptyEmbedded` — the setting
 * every calculation already obeys:
 *
 *   zero (default) — the reference reads as empty text; when the whole value
 *                    is that one reference and it (or this field) is numeric,
 *                    it reads as 0
 *   error          — this field gets no value, and the reason is recorded
 *                    (`state.calcErrors[name]`, shown by the test console)
 *   skip           — this field is left as it was; the reason is recorded
 *
 * In every case a value that resolves to nothing at all uses the field's
 * Default value first, when it has one.
 */

export interface PipedReference {
  /** the `{{…}}` text */
  token: string;
  /** what it resolved to, as plain text */
  value: string;
  missing: boolean;
  /** why it is missing, in the builder's words */
  reason?: string;
}

export interface TemplateResolution {
  text: string;
  refs: PipedReference[];
  missing: PipedReference[];
}

const hasPipe = (s: unknown): s is string => typeof s === "string" && /\{\{[^}]*\}\}/.test(s);

/** Resolve every token in a stored value, as plain text, noting the ones that came back empty. */
export function resolveEmbeddedTemplate(template: string, ctx: EvalContext): TemplateResolution {
  const refs: PipedReference[] = [];
  const text = template.replace(PIPE_TOKEN_RE, (token) => {
    let value = "";
    try { value = resolvePipingText(token, ctx); } catch { value = ""; }
    const ref: PipedReference = { token, value, missing: value === "" };
    if (ref.missing) ref.reason = missingReason(ctx.def, token, ctx.state);
    refs.push(ref);
    return value;
  });
  return { text, refs, missing: refs.filter((r) => r.missing) };
}

/** Why one token is empty, said the way the document asks. */
export function missingReason(def: SurveyDefinition, token: string, _state?: ResponseState | null): string {
  const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(token);
  const t = m ? parsePipeBody(m[1], token) : null;
  if (!t) return `"${token}" is not a valid piping reference.`;
  if (t.kind === "embedded") {
    if (!knownEmbedded(def, t.ref)) return `Embedded Data field "${t.ref}" was not found.`;
    return `Embedded Data field "${t.ref}" has no value at this point.`;
  }
  const problems = lintPipingTokens(def, token);
  if (problems.length) return `${problems[0]}.`.replace(/\.\.$/, ".");
  if (t.kind === "question") return `"${t.ref}" has no answer at this point.`;
  if (t.kind === "calc") return `Calculation "${t.ref}" has no value at this point.`;
  if (t.kind === "loop") return `${t.text} is only available inside a loop.`;
  if (t.kind === "system") return `${t.text} is not available here.`;
  return `${token} resolved to nothing.`;
}

function knownEmbedded(def: SurveyDefinition, name: string): boolean {
  return name === "RESPONSE_ID" || name === "SURVEY_CODE" || embeddedCatalog(def).some((e) => e.name === name);
}

const NUMERIC = new Set(["integer", "decimal"]);

/**
 * Apply one Embedded Data field where the flow reaches it: piping in a Fixed
 * value first (see the header), then the source → default → type rules of
 * `applyEmbeddedField`, which every other source keeps using unchanged.
 */
export function applyEmbeddedFieldInFlow(
  def: SurveyDefinition,
  state: ResponseState,
  field: EmbeddedField,
  ctx?: Partial<Omit<EvalContext, "def" | "state">>,
): { value: unknown; error?: string; skipped?: boolean } {
  const name = embeddedFieldName(field);
  if (!name || field.source !== "static" || !hasPipe(field.value)) return applyEmbeddedField(def, state, field);

  const evalCtx: EvalContext = { def, state, loop: ctx?.loop ?? null, quotaCounts: ctx?.quotaCounts, locale: ctx?.locale, ui: ctx?.ui };
  const r = resolveEmbeddedTemplate(field.value, evalCtx);
  let raw = r.text;
  if (r.missing.length === 0) {
    noteCalcOutcome(state, name);
    return applyEmbeddedField(def, state, { ...field, value: raw });
  }
  const message = `Embedded data "${name}": ${r.missing.map((m) => m.reason).join(" ")}`;
  if (raw.trim() === "" && field.defaultValue) {
    noteCalcOutcome(state, name);
    return applyEmbeddedField(def, state, { ...field, value: field.defaultValue });
  }
  const rule = def.calculationSettings?.emptyEmbedded ?? "zero";
  if (rule === "error") {
    state.embedded[name] = null;
    noteCalcOutcome(state, name, message);
    return { value: null, error: message };
  }
  if (rule === "skip") {
    noteCalcOutcome(state, name, message);
    return { value: state.embedded[name] ?? null, error: message, skipped: true };
  }
  // zero: a lone numeric reference is 0; anything else reads the missing part as empty text
  if (r.refs.length === 1 && field.value.trim() === r.refs[0].token.trim()) {
    const t = parseOne(r.refs[0].token);
    const refType = t?.kind === "embedded" ? embeddedTypeOf(def, t.ref) : undefined;
    if (NUMERIC.has(String(field.dataType)) || NUMERIC.has(String(refType))) raw = "0";
  }
  noteCalcOutcome(state, name);
  return applyEmbeddedField(def, state, { ...field, value: raw });
}

function parseOne(token: string): PipeToken | null {
  const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(token.trim());
  return m ? parsePipeBody(m[1], token) : null;
}

/* ============================================================ the builder */

export interface EmbeddedPipingIssue {
  level: "warning";
  nodeId: string;
  field: string;
  message: string;
}

/**
 * The builder's warnings for piped Embedded Data values, in flow order:
 * a reference to something that does not exist, and a reference to an
 * Embedded Data field that is only set LATER in the flow (it would be empty
 * where this one runs). URL and panel fields count as set from the start —
 * the runtime captures them before the first element runs.
 */
export function lintEmbeddedPiping(def: SurveyDefinition): EmbeddedPipingIssue[] {
  const issues: EmbeddedPipingIssue[] = [];
  const setBefore = new Set<string>();
  for (const e of def.embeddedData ?? []) { const n = embeddedFieldName(e); if (n) setBefore.add(n); }
  const all = (nodes: any[], out: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "embedded_data") out.push(n);
      if (n?.children) all(n.children, out);
      if (n?.branches) for (const b of n.branches) all(b.children, out);
      if (n?.otherwise) all(n.otherwise, out);
    }
    return out;
  };
  const edNodes = all(def.flow as any[], []) as Extract<FlowNode, { type: "embedded_data" }>[];
  for (const n of edNodes) for (const f of n.fields ?? []) {
    if (isNamedEmbeddedField(f) && (f.source === "url" || f.source === "panel")) setBefore.add(embeddedFieldName(f));
  }
  for (const n of edNodes) {
    for (const f of n.fields ?? []) {
      const name = embeddedFieldName(f);
      if (!name) continue;
      if (f.source === "static" && hasPipe(f.value)) {
        for (const p of embeddedValueProblems(def, f.value, setBefore, name)) {
          issues.push({ level: "warning", nodeId: n.id, field: name, message: `Embedded data "${name}": ${p}` });
        }
      }
      setBefore.add(name);
    }
  }
  return issues;
}

/**
 * The problems with one piped value, as the editor shows them under the
 * field. `setBefore` (optional) names the Embedded Data fields that already
 * exist where this value runs.
 */
export function embeddedValueProblems(def: SurveyDefinition, value: string, setBefore?: Set<string>, self?: string): string[] {
  const out: string[] = [];
  for (const m of (value ?? "").matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (!t) { out.push(`"${m[0]}" is not a valid piping reference.`); continue; }
    if (t.kind === "embedded") {
      if (!knownEmbedded(def, t.ref)) { out.push(`Embedded Data field "${t.ref}" was not found.`); continue; }
      if (setBefore && t.ref !== self && !setBefore.has(t.ref) && t.ref !== "RESPONSE_ID" && t.ref !== "SURVEY_CODE") {
        out.push(`Embedded Data field "${t.ref}" is only set later in the flow — it will be empty here.`);
      }
      continue;
    }
    for (const p of lintPipingTokens(def, m[0])) out.push(`${p}.`.replace(/\.\.$/, "."));
  }
  return [...new Set(out)];
}

/* ============================================================ Test Value */

export interface TestReference {
  /** what the sample form keys by: the `{{…}}` token or the expression name */
  key: string;
  kind: PipeToken["kind"] | "name";
  /** the field / question / calculation it reads */
  ref: string;
  label: string;
  /** a starting sample: the referenced field's own fixed value, when it has a plain one */
  suggested?: string;
  /** a reference the survey cannot resolve — no sample is asked for */
  problem?: string;
  /** resolved by the platform at test time (date, random, survey…), not from sample data */
  automatic?: boolean;
}

/** Everything a value reads that the Test Value form should ask for. */
export function testReferences(def: SurveyDefinition, field: Pick<EmbeddedField, "source" | "value">): TestReference[] {
  const out: TestReference[] = [];
  const seen = new Set<string>();
  const add = (r: TestReference) => { if (!seen.has(r.key)) { seen.add(r.key); out.push(r); } };
  const value = field.value ?? "";
  for (const m of value.matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (!t) { add({ key: m[0], kind: "question", ref: m[0], label: m[0], problem: `"${m[0]}" is not a valid piping reference.` }); continue; }
    if (t.kind === "embedded") {
      add({ key: m[0], kind: t.kind, ref: t.ref, label: `Embedded Data ${t.ref}`, suggested: plainFixedValue(def, t.ref),
        problem: knownEmbedded(def, t.ref) ? undefined : `Embedded Data field "${t.ref}" was not found.` });
    } else if (t.kind === "question") {
      const q = getQuestionByCodeOrVar(def, t.ref);
      const problem = lintPipingTokens(def, m[0])[0];
      add({ key: m[0], kind: t.kind, ref: t.ref, label: q ? `${q.code} answer${t.property && t.property !== "label" ? ` (${t.property})` : ""}` : t.ref, problem: problem ? `${problem}.` : undefined });
    } else if (t.kind === "calc") {
      add({ key: m[0], kind: t.kind, ref: t.ref, label: `Calculation ${t.ref}`, problem: lintPipingTokens(def, m[0])[0] });
    } else if (t.kind === "loop") {
      add({ key: m[0], kind: t.kind, ref: t.ref, label: `Current loop item — ${t.ref || "label"}` });
    } else {
      const problem = lintPipingTokens(def, m[0])[0];
      add({ key: m[0], kind: t.kind, ref: t.ref, label: t.text, automatic: true, problem: problem ? `${problem}.` : undefined });
    }
  }
  if (field.source === "expression" && value.trim()) {
    const catalog = new Set(embeddedCatalog(def).map((e) => e.name));
    for (const raw of referencedNames(normalizeExpression(value.replace(PIPE_TOKEN_RE, " ")))) {
      const name = raw.replace(/^(?:ed|embedded)\./i, "");
      if (catalog.has(name)) add({ key: name, kind: "embedded", ref: name, label: `Embedded Data ${name}`, suggested: plainFixedValue(def, name) });
      else {
        const q = getQuestionByCodeOrVar(def, raw);
        if (q) add({ key: raw, kind: "question", ref: raw, label: `${q.code} answer` });
        else if ((def.calculations ?? []).some((c) => c.targetVariable === raw)) add({ key: raw, kind: "calc", ref: raw, label: `Calculation ${raw}` });
      }
    }
  }
  return out;
}

/** A field's fixed value when it is plain text (no pipes) — a sensible sample to start from. */
function plainFixedValue(def: SurveyDefinition, name: string): string | undefined {
  const walk = (nodes: any[]): string | undefined => {
    for (const n of nodes ?? []) {
      if (n?.type === "embedded_data") {
        for (const f of n.fields ?? []) if (embeddedFieldName(f) === name && f.source === "static" && f.value && !hasPipe(f.value)) return f.value;
      }
      const inner = walk(n?.children ?? []) ?? (n?.branches ?? []).map((b: any) => walk(b.children)).find(Boolean) ?? walk(n?.otherwise ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return walk(def.flow as any[]) ?? (def.embeddedData ?? []).find((e) => embeddedFieldName(e) === name)?.defaultValue;
}

export interface EmbeddedValueTest {
  /** the value as written */
  expression: string;
  /** after piping, before the type reads it (static values) */
  resolved: string;
  /** what would be stored */
  stored: unknown;
  /** the type the stored value is read as */
  storedType: string;
  error?: string;
  warnings: string[];
  /** true: the result came from SAMPLE data entered for the test, not from any respondent */
  sample: true;
}

/**
 * TEST VALUE (document 15/10, item E): run the field exactly as the flow
 * would — the same `applyEmbeddedFieldInFlow` — against a throwaway state
 * holding the SAMPLE values typed into the test form. Nothing is saved.
 */
export function testEmbeddedValue(
  def: SurveyDefinition,
  field: EmbeddedField,
  samples: Record<string, string>,
  opts: { loop?: boolean } = {},
): EmbeddedValueTest {
  const name = embeddedFieldName(field) || "TEST_VALUE";
  const state = createResponseState(def, { sessionId: "test-sample", seed: 20261017 });
  const refs = testReferences(def, field);
  let loop: LoopContext | null = null;
  for (const r of refs) {
    if (r.problem || r.automatic) continue;
    const v = samples[r.key] ?? r.suggested ?? "";
    if (v === "") continue;
    if (r.kind === "embedded") state.embedded[r.ref] = v;
    else if (r.kind === "calc") state.calculated[r.ref] = v;
    else if (r.kind === "question") {
      const q = getQuestionByCodeOrVar(def, r.ref);
      if (q) state.answers[q.id] = (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v) as never;
    } else if (r.kind === "loop") {
      loop ??= { loopVar: "loop", code: "1", label: "", index: 1, count: 1, references: {} };
      const key = r.ref || "label";
      if (key === "label" || key === "item") loop.label = v;
      else if (key === "code") loop.code = v;
      else if (key === "index") loop.index = Number(v) || 1;
      else if (key === "count") loop.count = Number(v) || 1;
      else loop.references = { ...loop.references, [key]: v };
    }
  }
  if (opts.loop && !loop) loop = { loopVar: "loop", code: "1", label: "Item 1", index: 1, count: 1, references: {} };
  const warnings = refs.filter((r) => r.problem).map((r) => r.problem!);
  const testField = { ...field, name, when: undefined } as EmbeddedField;
  let resolved = field.value ?? "";
  if (field.source === "static" && hasPipe(field.value)) {
    const r = resolveEmbeddedTemplate(field.value, { def, state, loop });
    resolved = r.text;
    for (const m of r.missing) if (m.reason && !warnings.includes(m.reason)) warnings.push(m.reason);
  }
  const out = applyEmbeddedFieldInFlow(def, state, testField, { loop });
  const stored = state.embedded[name] ?? out.value ?? null;
  const declared = field.dataType;
  const storedType = declared === undefined ? "string" : declared === "auto" ? `auto → ${autoTypeWord(stored)}` : declared;
  const coercion = field.source === "static" && !hasPipe(field.value) ? coerceEmbedded(declared, field.value) : null;
  return {
    expression: field.value ?? "",
    resolved,
    stored,
    storedType,
    error: out.error ?? coercion?.error ?? state.calcErrors?.[name],
    warnings,
    sample: true,
  };
}

function autoTypeWord(v: unknown): string {
  const d = detectValueType(v);
  return d === "empty" ? "nothing" : d;
}
