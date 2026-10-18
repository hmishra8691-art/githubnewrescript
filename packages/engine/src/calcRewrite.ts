/**
 * A CALCULATION WRITTEN IN THE CONDITION LANGUAGE'S SPELLING, READ AS THE
 * CALCULATION LANGUAGE MEANS IT (production intents, 2026-10-18).
 *
 * Production evidence (`intelligent_operations`, 2026-10-08 and 2026-10-15):
 * the model wrote `(PERC_BATTERY.R1 + PERC_BATTERY.R2 + PERC_BATTERY.R3) / 3`
 * and `IF AGE <= 27 THEN 1 ELSE IF AGE <= 43 THEN 2 ELSE 3`; both were refused
 * ("the expression reads R1, R2 …", "reads THEN, ELSE, which are not in the
 * survey"). Each spelling has exactly one meaning, so the engine writes it the
 * way the calculation engine reads it instead of failing:
 *
 *   `GRID.R1` / `GRID.r1` / `Q6.R2`   a grid ROW, as the condition language reads
 *                                     it (the row coded 1, else the first row) →
 *                                     that row's variable, `GRID_r1` (the survey's
 *                                     own derived-name scheme)
 *   `IF c THEN a ELSE b` (ELSE IF …)   → `if(c, a, b)`, nested; no ELSE → `if(c, a, null)`
 *
 * Nothing else is rewritten: a name that is still unknown is refused with a
 * precise hint (`calcNameHint`).
 */
import type { SurveyDefinition } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { resolveRowOrOption } from "./logicExpression.js";
import { rowColumn } from "./derivedNames.js";

const RESERVED_HEADS = new Set(["ed", "embedded", "loop", "rule", "current_item"]);

/** `GRID.R1` → `GRID_r1` for every grid-row reference the survey resolves (outside string literals) */
function gridRows(def: SurveyDefinition, expr: string, said: string[]): string {
  return mapOutsideStrings(expr, (chunk) => chunk.replace(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)(?![\w.(])/g, (whole, head: string, seg: string) => {
    if (RESERVED_HEADS.has(head.toLowerCase())) return whole;
    const q = getQuestionByCodeOrVar(def, head);
    if (!q || !(q.rows ?? []).length) return whole;
    const hit = resolveRowOrOption(q, seg);
    if (!hit || hit.kind !== "row") return whole;
    const name = rowColumn(q.variableName, String(hit.code), def.variableNaming);
    said.push(`${whole} → ${name} (row ${String(hit.code)} of ${String(q.code)})`);
    return name;
  }));
}

/** apply `fn` to the parts of an expression that are not inside quotes */
function mapOutsideStrings(expr: string, fn: (s: string) => string): string {
  return expr.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

/* ------------------------------------------------------------ IF … THEN … ELSE */

type Tk = { k: "str" | "open" | "close" | "comma" | "word" | "other" | "space"; v: string };
function lex(src: string): Tk[] {
  const out: Tk[] = [];
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\()|(\))|(,)|([A-Za-z_][A-Za-z0-9_.]*)|(\s+)|([^\sA-Za-z_(),"']+)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) out.push({ k: "str", v: m[1] });
    else if (m[2]) out.push({ k: "open", v: "(" });
    else if (m[3]) out.push({ k: "close", v: ")" });
    else if (m[4]) out.push({ k: "comma", v: "," });
    else if (m[5]) out.push({ k: "word", v: m[5] });
    else if (m[6]) out.push({ k: "space", v: " " });
    else out.push({ k: "other", v: m[7] });
  }
  return out;
}
const kw = (t: Tk | undefined, w: string) => !!t && t.k === "word" && t.v.toUpperCase() === w;
const STOP = ["THEN", "ELSE", "END", "ENDIF"];

class IfParser {
  i = 0;
  constructor(private t: Tk[]) {}
  /** does a THEN follow at this nesting depth before the group ends? (the keyword form, not the `if(` function) */
  private thenAhead(): boolean {
    let depth = 0;
    for (let j = this.i + 1; j < this.t.length; j++) {
      const x = this.t[j];
      if (x.k === "open") depth++;
      else if (x.k === "close") { if (depth === 0) return false; depth--; }
      else if (depth === 0 && kw(x, "THEN")) return true;
    }
    return false;
  }
  /** a run of tokens up to a stop keyword at depth 0, an unmatched ")" or a "," at depth 0 */
  expr(stops: string[]): string {
    let out = "";
    while (this.i < this.t.length) {
      const x = this.t[this.i];
      if (x.k === "close" || x.k === "comma") break;
      if (x.k === "word" && stops.includes(x.v.toUpperCase())) break;
      if (kw(x, "IF") && this.thenAhead()) { out += this.ifForm(); continue; }
      if (x.k === "open") {
        this.i++;
        let inner = this.expr(STOP.filter((s) => s !== "END"));
        while (this.t[this.i]?.k === "comma") { this.i++; inner += `, ${this.expr(STOP)}`; }
        if (this.t[this.i]?.k === "close") this.i++;
        out += `(${inner.trim()})`;
        continue;
      }
      out += x.v;
      this.i++;
    }
    return out;
  }
  private ifForm(): string {
    this.i++; // IF
    const cond = this.expr(["THEN"]).trim();
    if (!kw(this.t[this.i], "THEN")) throw new Error("IF without THEN");
    this.i++;
    const a = this.expr(["ELSE", "END", "ENDIF"]).trim();
    let b = "null";
    if (kw(this.t[this.i], "ELSE")) { this.i++; b = this.expr(["ELSE", "END", "ENDIF"]).trim(); }
    while (this.t[this.i]?.k === "space") this.i++;
    if (kw(this.t[this.i], "ENDIF")) this.i++;
    else if (kw(this.t[this.i], "END")) {
      this.i++;
      /* "END IF": the IF closes this one (it has no THEN of its own) */
      if (this.t[this.i]?.k === "space" && kw(this.t[this.i + 1], "IF")) { const save = this.i; this.i++; if (this.thenAhead()) this.i = save; else this.i++; }
    }
    if (!cond || !a || !b) throw new Error("an empty part");
    return `if(${cond}, ${a}, ${b}) `;
  }
}

/** `IF c THEN a ELSE b` (any case, ELSE IF chains, optional END / END IF) → `if(c, a, b)`; null when there is none or it does not read */
export function ifThenElse(expr: string): string | null {
  if (!/\bTHEN\b/i.test(mapOutsideStrings(expr, (s) => s).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ""))) return null;
  try {
    const p = new IfParser(lex(expr));
    const out = p.expr([]).replace(/\s+/g, " ").replace(/\s+([),])/g, "$1").trim();
    if (p.i < lex(expr).length) return null;
    return /\b(?:THEN|ELSE)\b/i.test(out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")) ? null : out;
  } catch { return null; }
}

/** The expression as the calculation engine reads it, and what was rewritten (said on the card). */
export function normalizeCalcExpression(def: SurveyDefinition, expression: string): { expression: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = gridRows(def, expression, rewrites);
  const conditional = ifThenElse(out);
  if (conditional && conditional !== out) { rewrites.push("IF … THEN … ELSE → if(condition, then, else)"); out = conditional; }
  return { expression: out, rewrites };
}

/**
 * The hint that goes with an unknown name — so the refusal (and the one repair call, which sends the
 * refusal back to the model) says what to write instead of only what is wrong.
 */
export function calcNameHint(def: SurveyDefinition, unknown: string[]): string {
  const hints: string[] = [];
  if (unknown.some((n) => /^[RC]\d+$/i.test(n))) {
    const grid = def.questions.find((q) => (q.rows ?? []).length);
    const eg = grid ? `${rowColumn(grid.variableName, String(grid.rows[0].code), def.variableNaming)} (row ${String(grid.rows[0].code)} of ${String(grid.code)})` : "GRID_r1";
    hints.push(`a grid row in a calculation is that row's variable — e.g. ${eg} — not R1 on its own`);
  }
  if (unknown.some((n) => /^(?:THEN|ELSE|ELSEIF|END|ENDIF)$/i.test(n))) hints.push("a condition in a calculation is if(condition, then, else), nested for more cases — not IF … THEN … ELSE");
  return hints.length ? ` (${hints.join("; ")})` : "";
}
