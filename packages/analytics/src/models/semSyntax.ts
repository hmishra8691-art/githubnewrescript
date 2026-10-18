/**
 * A LAVAAN-LIKE MODEL SYNTAX, the subset this SEM estimator supports:
 *
 *   visual  =~ x1 + x2 + x3          measurement (first loading fixed to 1 unless scaled by variance)
 *   ind60   =~ NA*x1 + x2            NA* frees a loading; 1* / 0.5* fixes one
 *   dem60   ~ a*ind60                regression; `a*` labels the path
 *   y1 ~~ y5                         (residual) covariance; `x ~~ x` a variance
 *   dem65   ~ c*ind60 + b*dem60
 *   ind     := a*b                   defined parameter (delta-method SE)
 *
 * One statement per line (or separated by `;`), `#` comments, several
 * left-hand names joined by `+` (`y1 + y2 ~ x`). The same label on two
 * parameters constrains them to be equal. Not supported, and refused with the
 * line number: intercepts / means (`~ 1`), thresholds (`|`), `start()` and
 * other modifier functions, `==`/`<`/`>` constraints, formative `<~`.
 */

export type SemOp = "=~" | "~" | "~~";
export interface SemTerm { name: string; fixed?: number; label?: string; free?: boolean }
export interface SemStatement { line: number; lhs: string; op: SemOp; rhs: SemTerm }
export interface SemDefined { line: number; name: string; expr: string; labels: string[] }
export interface SemParse { statements: SemStatement[]; defined: SemDefined[]; errors: string[] }

const NAME = /^[A-Za-z_.][A-Za-z0-9_.]*$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function parseTerm(raw: string, line: number, errors: string[]): SemTerm | null {
  const t = raw.trim();
  if (!t) { errors.push(`Line ${line}: an empty term (check for a doubled “+”).`); return null; }
  const parts = t.split("*").map((s) => s.trim());
  if (parts.length > 2) { errors.push(`Line ${line}: “${t}” — only one modifier per term (e.g. a*x or 1*x).`); return null; }
  const name = parts[parts.length - 1];
  if (name === "1") { errors.push(`Line ${line}: intercepts and means (“~ 1”) are not supported — the model is fitted to the covariance matrix only.`); return null; }
  if (!NAME.test(name)) { errors.push(`Line ${line}: “${name}” is not a variable name.`); return null; }
  if (parts.length === 1) return { name };
  const mod = parts[0];
  if (/\(/.test(mod)) { errors.push(`Line ${line}: modifier functions such as start() or equal() are not supported (“${mod}”).`); return null; }
  if (mod === "NA") return { name, free: true };
  if (NUMBER.test(mod)) return { name, fixed: Number(mod) };
  if (NAME.test(mod)) return { name, label: mod };
  errors.push(`Line ${line}: “${mod}” is not a number, a label or NA.`);
  return null;
}

export function parseSemSyntax(text: string): SemParse {
  const statements: SemStatement[] = []; const defined: SemDefined[] = []; const errors: string[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = i + 1;
    for (const piece of rawLine.replace(/[#!].*$/, "").split(";")) {
      const s = piece.trim();
      if (!s) continue;
      if (/<~/.test(s)) { errors.push(`Line ${line}: formative indicators (“<~”) are not supported.`); continue; }
      if (/\|/.test(s)) { errors.push(`Line ${line}: thresholds (“|”) are not supported — ordinal indicators are treated as continuous; declare them as ordinary indicators.`); continue; }
      if (/==|[<>]/.test(s.replace(/:=/, ""))) { errors.push(`Line ${line}: equality / inequality constraints are not supported — give two parameters the same label to make them equal.`); continue; }
      const def = s.match(/^([A-Za-z_.][A-Za-z0-9_.]*)\s*:=\s*(.+)$/);
      if (def) {
        const expr = def[2].trim();
        if (!/^[A-Za-z0-9_.+\-*/()\s]+$/.test(expr)) { errors.push(`Line ${line}: a defined parameter may use labels, numbers, + − * / and parentheses only.`); continue; }
        const labels = [...new Set((expr.match(/[A-Za-z_.][A-Za-z0-9_.]*/g) ?? []))];
        defined.push({ line, name: def[1], expr, labels });
        continue;
      }
      const m = s.match(/^(.*?)\s*(=~|~~|~)\s*(.*)$/);
      if (!m) { errors.push(`Line ${line}: “${s}” — expected one of =~ (measured by), ~ (regressed on), ~~ (covaries with) or := (defined).`); continue; }
      const [, lhsRaw, op, rhsRaw] = m;
      const lhs = lhsRaw.split("+").map((x) => x.trim()).filter(Boolean);
      if (!lhs.length) { errors.push(`Line ${line}: nothing on the left of “${op}”.`); continue; }
      if (!rhsRaw.trim()) { errors.push(`Line ${line}: nothing on the right of “${op}”.`); continue; }
      const bad = lhs.find((x) => !NAME.test(x));
      if (bad) { errors.push(`Line ${line}: “${bad}” is not a variable name.`); continue; }
      const terms = rhsRaw.split("+").map((x) => parseTerm(x, line, errors));
      if (terms.some((t) => !t)) continue;
      for (const l of lhs) for (const t of terms as SemTerm[]) {
        if (op === "=~" && t.name === l) { errors.push(`Line ${line}: “${l}” cannot be measured by itself.`); continue; }
        if (op === "~" && t.name === l) { errors.push(`Line ${line}: “${l}” cannot be regressed on itself.`); continue; }
        statements.push({ line, lhs: l, op: op as SemOp, rhs: t });
      }
    }
  });
  if (!statements.length && !errors.length) errors.push("The model is empty — write at least one line such as “F =~ x1 + x2 + x3”.");
  return { statements, defined, errors };
}

/** every name a model refers to, latent and observed (the observed ones must be dataset variables) */
export function semNames(p: SemParse): { latent: string[]; observed: string[] } {
  const latent = [...new Set(p.statements.filter((s) => s.op === "=~").map((s) => s.lhs))];
  const lat = new Set(latent);
  const observed: string[] = [];
  const add = (n: string) => { if (!lat.has(n) && !observed.includes(n)) observed.push(n); };
  for (const s of p.statements) { if (s.op === "=~") add(s.rhs.name); }
  for (const s of p.statements) { if (s.op !== "=~") { add(s.lhs); add(s.rhs.name); } }
  return { latent, observed };
}
