import type { SurveyDefinition } from "@rescript/schema";

/**
 * WHAT A SCRIPT READS AND WRITES, FOR THE DEPENDENCY GRAPH (S2b item 5, 2026-10-30; audit D18 / MM-10).
 *
 * Behaviour scripts (`ux.behaviors[].script`) and Scripts-panel logic scripts (`scripts[].code`) name questions,
 * calculations and embedded fields in calls: `rs.getAnswer("Q3")`, `rs.setAnswer("SEG", 1)`, `rs.getCalc` /
 * `rs.setCalc`, `rs.getEmbedded` / `rs.setEmbedded`, the logic ctx's `get("Q3")` / `set(…)` / `getCalc` / `setCalc` /
 * `getEmbedded` / `setEmbedded`, and page hooks `[data-qid="<question id>"]`. Only LITERAL strings are read: a name
 * assembled at run time (`get("Q" + i)`) is invisible here, and the impact text says "literal references".
 *
 * Custom components are not in the survey definition (they live in the component library), so they are not indexed.
 */

export interface ScriptLiteralRef {
  /** the name (or, for a hook, the question id) exactly as written */
  name: string;
  write: boolean;
  /** "call" — an api call's first argument; "hook" — a [data-qid="…"] selector */
  via: "call" | "hook";
  /** where the literal's text starts and ends (inside the quotes) */
  start: number;
  end: number;
}

const CALL = /\b(?:rs\s*\.\s*|ctx\s*\.\s*)?(getAnswer|setAnswer|getCalc|setCalc|getEmbedded|setEmbedded|get|set)\s*\(\s*(["'])([A-Za-z_][\w.]{0,80})\2(?=\s*[,)])/g;
const HOOK = /\[data-qid\s*=\s*\\?(["'])([^"'\\\]]{1,80})\\?\1\s*\]/g;

/** the literal references in one script's code */
export function scriptLiteralRefs(code: string): ScriptLiteralRef[] {
  const out: ScriptLiteralRef[] = [];
  for (const m of String(code ?? "").matchAll(CALL)) {
    const fn = m[1];
    const before = code.slice(Math.max(0, m.index! - 1), m.index!);
    // a bare get/set must not be a method of something else (map.get("x"), url.searchParams.get("x"))
    if ((fn === "get" || fn === "set") && !/^(?:rs|ctx)\s*\./.test(m[0]) && /[.\w$]/.test(before)) continue;
    const start = m.index! + m[0].length - m[3].length - 1;
    out.push({ name: m[3], write: fn.startsWith("set"), via: "call", start, end: start + m[3].length });
  }
  for (const m of String(code ?? "").matchAll(HOOK)) {
    const start = m.index! + m[0].indexOf(m[2]);
    out.push({ name: m[2], write: false, via: "hook", start, end: start + m[2].length });
  }
  return out;
}

export interface ScriptSource { id: string; kind: "behavior" | "logic"; name: string; code: string; path: string }

/** every script in the definition, with the path its code lives at */
export function surveyScripts(def: SurveyDefinition): ScriptSource[] {
  const out: ScriptSource[] = [];
  (def.ux?.behaviors ?? []).forEach((b, i) => { if (b.script) out.push({ id: `behavior/${b.id}`, kind: "behavior", name: b.label || b.id, code: b.script, path: `ux.behaviors[${i}].script` }); });
  (def.scripts ?? []).forEach((s, i) => { out.push({ id: `logic/${s.id}`, kind: "logic", name: s.name || s.id, code: s.code, path: `scripts[${i}].code` }); });
  return out;
}

/**
 * RENAME: rewrite the LITERAL references to `from` in every script's api calls (not a string anywhere else — a
 * message that happens to say "Q3" is left alone). Returns the scripts changed and how many references, and changes
 * `def` in place. A name built at run time is not seen and is not changed.
 */
export function rewriteScriptReferences(def: SurveyDefinition, from: string, to: string): { scripts: string[]; count: number } {
  const changed: string[] = [];
  let count = 0;
  const fix = (code: string): string => {
    const refs = scriptLiteralRefs(code).filter((r) => r.via === "call" && r.name === from).sort((a, b) => b.start - a.start);
    let out = code;
    for (const r of refs) { out = out.slice(0, r.start) + to + out.slice(r.end); count++; }
    return out;
  };
  for (const b of def.ux?.behaviors ?? []) if (b.script) { const n = fix(b.script); if (n !== b.script) { b.script = n; changed.push(b.label || b.id); } }
  for (const s of def.scripts ?? []) { const n = fix(s.code); if (n !== s.code) { s.code = n; changed.push(s.name || s.id); } }
  return { scripts: changed, count };
}
