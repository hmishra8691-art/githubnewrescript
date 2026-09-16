import type { SurveyDefinition, EmbeddedDataType, FlowNode } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { CALC_FUNCTION_NAMES, evaluateExpression, validateExpression } from "./calc.js";

/**
 * Typed embedded data (reqs §12–15).
 *
 * Everything that arrives from a URL or a panel is text. Without a declared
 * type, `score > 80` compares "9" with "80" as strings and answers yes, which
 * is the kind of bug that only shows up in live data. A type says how to read
 * the text ONCE, at capture, so every later comparison, calculation and piping
 * token sees a real number, boolean or date.
 *
 * Untyped fields stay strings — every survey written before this behaves
 * exactly as it did.
 */

export type EmbeddedField = Extract<FlowNode, { type: "embedded_data" }>["fields"][number];

export const EMBEDDED_TYPES: { value: EmbeddedDataType; label: string; hint: string }[] = [
  { value: "string", label: "String", hint: "text — the default" },
  { value: "integer", label: "Integer", hint: "whole number, e.g. 25" },
  { value: "decimal", label: "Decimal", hint: "number with a fraction, e.g. 12.5" },
  { value: "boolean", label: "Boolean", hint: "true / false (1, yes, y also count)" },
  { value: "date", label: "Date", hint: "YYYY-MM-DD" },
  { value: "datetime", label: "Date & time", hint: "ISO 8601 timestamp" },
];

export interface CoercionResult {
  value: string | number | boolean | null;
  /** Set when the raw text could not be read as the declared type. */
  error?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off", ""]);

/**
 * Read a raw value as its declared type. Never throws.
 *
 * No declared type means no conversion at all — not "convert to string". A
 * field written before typing existed may already hold a number, and turning
 * it into "42" here would change what every existing survey stores.
 */
export function coerceEmbedded(type: EmbeddedDataType | undefined, raw: unknown): CoercionResult {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (type === undefined) return { value: raw as CoercionResult["value"] };
  const t = type;
  const text = String(raw).trim();

  switch (t) {
    case "string":
      return { value: String(raw) };
    case "integer": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { value: null, error: `"${text}" is not a number` };
      if (!Number.isInteger(n)) return { value: Math.trunc(n), error: `"${text}" is not a whole number — truncated to ${Math.trunc(n)}` };
      return { value: n };
    }
    case "decimal": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { value: null, error: `"${text}" is not a number` };
      return { value: n };
    }
    case "boolean": {
      const lower = text.toLowerCase();
      if (TRUE_WORDS.has(lower)) return { value: true };
      if (FALSE_WORDS.has(lower)) return { value: false };
      return { value: null, error: `"${text}" is not true or false` };
    }
    case "date": {
      if (DATE_RE.test(text)) return { value: text };
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return { value: null, error: `"${text}" is not a date` };
      return { value: d.toISOString().slice(0, 10) };
    }
    case "datetime": {
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return { value: null, error: `"${text}" is not a date and time` };
      return { value: d.toISOString() };
    }
    default:
      return { value: String(raw) };
  }
}

/** The declared type of an embedded field, wherever it was declared. */
export function embeddedTypeOf(def: SurveyDefinition, name: string): EmbeddedDataType | undefined {
  const registered = def.embeddedData.find((e) => e.name === name);
  if (registered?.dataType) return registered.dataType;
  for (const field of allEmbeddedFields(def)) {
    if (field.name === name && field.dataType) return field.dataType;
  }
  return undefined;
}

/**
 * ONE RULE FOR WHAT COUNTS AS A NAMED EMBEDDED FIELD.
 *
 * The Studio creates an embedded-data node already holding one empty row
 * (`FlowPanel`: `fields: [{ name: "", source: "url", dataType: "string" }]`)
 * so the programmer has something to type into, and the schema accepts it
 * because `z.string()` has no minimum — deliberately, since tightening it
 * would make every draft that has an untyped row unsaveable mid-edit.
 *
 * The cost was that a row nobody had named yet was still a variable. It
 * created `state.embedded[""]`, it appeared in the piping picker as a blank
 * line, it exported as a column with no heading, and every consumer had to
 * remember the case. Whitespace-only names did the same thing while looking
 * different from each other: "a " and "a" were two variables.
 *
 * So the rule lives here, once: a field is a variable when its name has
 * non-whitespace in it, and the name is that text trimmed. An unnamed row is
 * an edit in progress — it is not an error, it simply does not exist yet.
 */
export function embeddedFieldName(f: { name?: unknown }): string {
  return typeof f?.name === "string" ? f.name.trim() : "";
}

export function isNamedEmbeddedField(f: { name?: unknown }): boolean {
  return embeddedFieldName(f) !== "";
}

/**
 * Every embedded-data field declared anywhere in the flow, in flow order.
 *
 * Unnamed rows are left out — see `embeddedFieldName`. Callers that want the
 * raw rows (only the editor does) read `node.fields` themselves.
 */
export function allEmbeddedFields(def: SurveyDefinition): EmbeddedField[] {
  const out: EmbeddedField[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "embedded_data") {
        for (const f of n.fields ?? []) if (isNamedEmbeddedField(f)) out.push(f);
      }
      if (n?.children) walk(n.children);
      if (n?.branches) for (const b of n.branches) walk(b.children);
      if (n?.otherwise) walk(n.otherwise);
    }
  };
  walk(def.flow as any[]);
  return out;
}

/**
 * Every embedded name a programmer can reference, with its type — the source
 * list for the logic pickers and the piping picker (reqs §15–16).
 */
export function embeddedCatalog(
  def: SurveyDefinition,
): { name: string; dataType: EmbeddedDataType; label?: string; source?: string }[] {
  const byName = new Map<string, { name: string; dataType: EmbeddedDataType; label?: string; source?: string }>();
  for (const e of def.embeddedData) {
    const name = embeddedFieldName(e);
    if (!name) continue;
    byName.set(name, { name, dataType: e.dataType ?? "string", label: e.label, source: e.source });
  }
  for (const f of allEmbeddedFields(def)) {
    const name = embeddedFieldName(f);
    const existing = byName.get(name);
    if (existing) {
      if (f.dataType && !existing.dataType) existing.dataType = f.dataType;
      continue;
    }
    byName.set(name, { name, dataType: f.dataType ?? "string", source: f.source });
  }
  return [...byName.values()];
}

/* ---------------------------------------------------------- expressions */

/**
 * `IF x THEN y ELSE z` → `if(x, y, z)`.
 *
 * The calc DSL has always had `if(...)`; the brief asks for the readable form,
 * so it is rewritten before parsing rather than forked into a second language.
 * Nesting works because the rewrite runs innermost-first, and quoted strings
 * are skipped so `"IF THEN"` inside a label survives.
 */
export function normalizeExpression(src: string): string {
  let out = src;
  for (let pass = 0; pass < 12; pass++) {
    const rewritten = rewriteInnermostIf(out);
    if (rewritten === out) break;
    out = rewritten;
  }
  return out;
}

function rewriteInnermostIf(src: string): string {
  const positions = keywordPositions(src);
  // innermost = the LAST "IF" that still has a THEN after it
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i];
    if (p.word !== "if") continue;
    const then = positions.find((x) => x.word === "then" && x.start > p.end);
    if (!then) continue;
    const els = positions.find((x) => x.word === "else" && x.start > then.end);
    const cond = src.slice(p.end, then.start).trim();
    const yes = src.slice(then.end, els ? els.start : src.length).trim();
    const no = els ? src.slice(els.end).trim() : '""';
    if (!cond || !yes) continue;
    return `${src.slice(0, p.start)}if(${cond}, ${yes}, ${no || '""'})`;
  }
  return src;
}

interface KeywordPos { word: "if" | "then" | "else"; start: number; end: number }

/** Find IF/THEN/ELSE keywords outside string literals. */
function keywordPositions(src: string): KeywordPos[] {
  const out: KeywordPos[] = [];
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (!/[A-Za-z]/.test(ch)) continue;
    const rest = src.slice(i);
    const m = rest.match(/^(if|then|else)\b/i);
    // a bare word only — `iffy` and `if(` (already a call) are not keywords
    if (m && !(m[1].toLowerCase() === "if" && /^if\s*\(/i.test(rest))) {
      out.push({ word: m[1].toLowerCase() as KeywordPos["word"], start: i, end: i + m[1].length });
      i += m[1].length - 1;
      continue;
    }
    // skip the rest of this identifier so `MY_IF_VAR` is not scanned inside
    const ident = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (ident) i += ident[0].length - 1;
  }
  return out;
}

export interface ExpressionCheck {
  ok: boolean;
  error?: string;
  /** Names the expression reads that the survey does not define. */
  unknownRefs: string[];
  /** The type the result will be stored as, given the field's declared type. */
  resultNote?: string;
}

/**
 * Validate an embedded-data expression against the survey (req §13).
 * Type mismatches are reported as errors the programmer can act on rather
 * than being silently coerced at runtime.
 */
export function checkEmbeddedExpression(
  def: SurveyDefinition,
  expression: string,
  dataType?: EmbeddedDataType,
): ExpressionCheck {
  const src = normalizeExpression(expression ?? "");
  if (!src.trim()) return { ok: false, error: "expression is empty", unknownRefs: [] };

  const syntax = validateExpression(src);
  if (syntax) return { ok: false, error: syntax, unknownRefs: [] };

  const known = new Set<string>([
    ...def.questions.map((q) => q.variableName),
    ...def.questions.map((q) => q.code),
    ...def.calculations.map((c) => c.targetVariable),
    ...embeddedCatalog(def).map((e) => e.name),
    ...def.variables.map((v) => v.name),
  ]);
  const unknownRefs = [...new Set(referencedNames(src))].filter(
    (n) => !known.has(n) && !known.has(n.split(".")[0]) && !n.includes("*"),
  );

  const note = dataType && dataType !== "string"
    ? `Result is stored as ${dataType}.`
    : undefined;

  return { ok: unknownRefs.length === 0, unknownRefs, resultNote: note, error: unknownRefs.length ? `unknown reference${unknownRefs.length > 1 ? "s" : ""}: ${unknownRefs.join(", ")}` : undefined };
}

/*
 * The engine's own list, plus the three boolean keywords the tokenizer treats
 * as operators. This was a hand-written duplicate that drifted the moment a
 * function was added to calc.ts — `upper`, `trim`, `substring` and the rest
 * would have been reported here as unknown VARIABLES.
 */
const FUNCTION_NAMES = new Set([...CALC_FUNCTION_NAMES, "and", "or", "not"]);

/** Variable names an expression reads (function names and strings excluded). */
export function referencedNames(src: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (!/[A-Za-z_]/.test(ch)) continue;
    const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.*]*/);
    if (!m) continue;
    const name = m[0];
    i += name.length - 1;
    const after = src.slice(i + 1).match(/^\s*\(/);
    if (after) continue; // a call, not a variable
    if (FUNCTION_NAMES.has(name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}

/**
 * Apply one embedded-data field to the response state.
 *
 * Order: the configured source, then the default when that produced nothing,
 * then the declared type. Returns the coercion problem, if any, so the test
 * runtime can show it instead of storing a silent null.
 */
export function applyEmbeddedField(
  def: SurveyDefinition,
  state: ResponseState,
  field: EmbeddedField,
): { value: unknown; error?: string } {
  /*
   * A row the programmer has not named yet. It writes nothing — not even a
   * null under the empty key, which is what used to happen and what put a
   * nameless variable into every response, every export and every picker.
   */
  const name = embeddedFieldName(field);
  if (!name) return { value: null };

  let raw: unknown = null;

  switch (field.source) {
    case "static":
      raw = field.value ?? null;
      break;
    case "expression": {
      if (field.value) {
        /*
         * `flattenVariables` used to sit OUTSIDE this try. It walks the whole
         * definition and the whole response state, so a survey it could not
         * flatten threw out of `applyEmbeddedField`, out of `compileFlow`, and
         * out of the Runner's init effect — where nothing caught it and the
         * respondent waited on "Loading survey…" for the rest of the session.
         * An embedded field that cannot be computed is a field with no value,
         * and it reports the reason; it is not the end of the interview.
         */
        try {
          const flat = flattenVariables(def, state);
          const v = evaluateExpression(normalizeExpression(field.value), {
            resolver: (n) => flat[n],
            names: () => Object.keys(flat),
          });
          raw = Array.isArray(v) ? v.join(",") : v;
        } catch (e) {
          state.embedded[name] = null;
          return { value: null, error: (e as Error).message };
        }
      }
      break;
    }
    default:
      // url / panel: captured at session start, already in state
      raw = state.embedded[name] ?? null;
      break;
  }

  if (raw === null || raw === undefined || raw === "") {
    raw = field.defaultValue ?? null;
    /**
     * Nothing arrived, nothing was declared, nothing to write.
     *
     * Writing an explicit null here would create the key — and a column of
     * nulls in every export — for surveys that captured URL fields long before
     * types and defaults existed. Silence is what they have always produced.
     */
    if (raw === null && field.dataType === undefined && !(name in state.embedded)) {
      return { value: null };
    }
  }

  const { value, error } = coerceEmbedded(field.dataType, raw);
  state.embedded[name] = value;
  return { value, error };
}
