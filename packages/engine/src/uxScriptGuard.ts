import { lexJs } from "./ux.js";

/**
 * LOOPS IN SURVEY SCRIPTS, BOUNDED RATHER THAN BANNED.
 *
 * Survey scripts used to refuse every `for`/`while`/`do` outright, because a
 * loop that never ends hangs the page the script runs on. That ruled out the
 * most ordinary DOM code there is —
 *
 *     for (const input of document.querySelectorAll("input")) { … }
 *
 * — so a script an AI or a programmer wrote the normal way was refused, and
 * the scripts that did run could only use the `rs` api. The loop is now
 * allowed, and bounded: this rewrites the script so every loop body begins
 * with `__g();`, a counter the sandbox resets at the start of each entry
 * (the script itself, one event, one timer) and which throws after a fixed
 * number of iterations. An endless loop becomes an error with a message
 * instead of a frozen page.
 *
 * Only a loop whose body is a `{ block }` can be instrumented, so a braceless
 * loop (`for (…) x++;`) is refused with that reason. That is a limit on how
 * the loop is written, not on what it may do.
 */
export const SCRIPT_LOOP_LIMIT = 100_000;

export interface GuardedScript { code: string; errors: string[] }

export function guardScriptLoops(code: string): GuardedScript {
  const { bare } = lexJs(code);
  const errors: string[] = [];
  const inserts: number[] = [];
  const re = /(^|[^\w$.])(while|for|do)(?![\w$])/g;
  const skipSpace = (i: number) => { while (i < bare.length && /\s/.test(bare[i])) i++; return i; };
  const closeParen = (open: number) => {
    let depth = 0;
    for (let i = open; i < bare.length; i++) {
      if (bare[i] === "(") depth++;
      else if (bare[i] === ")" && --depth === 0) return i;
    }
    return -1;
  };
  for (const m of bare.matchAll(re)) {
    const kw = m[2];
    const kwStart = m.index! + m[1].length;
    let after = kwStart + kw.length;
    if (kw === "do") {
      const b = skipSpace(after);
      if (bare[b] === "{") inserts.push(b + 1);
      else errors.push("a do…while loop needs braces — write do { … } while (…)");
      continue;
    }
    // `for await (…)` is still a for loop
    let p = skipSpace(after);
    if (kw === "for" && /^await(?![\w$])/.test(bare.slice(p))) p = skipSpace(p + 5);
    if (bare[p] !== "(") continue; // an identifier that merely contains the word, or a property
    const close = closeParen(p);
    if (close < 0) continue; // unbalanced: the parse check reports it
    const b = skipSpace(close + 1);
    if (kw === "while" && bare[b] === ";") {
      // `do { … } while (…);` — the tail of a do loop, already guarded at its `do`
      const prev = bare.slice(0, kwStart).trimEnd().slice(-1);
      if (prev === "}") continue;
      errors.push("a loop with an empty body (while (…);) never does anything and cannot be stopped — give it a { block }");
      continue;
    }
    if (bare[b] === "{") inserts.push(b + 1);
    else errors.push(`a ${kw} loop needs braces around its body — write ${kw} (…) { … }`);
  }
  let out = code;
  for (const at of [...new Set(inserts)].sort((a, b) => b - a)) out = `${out.slice(0, at)} __g();${out.slice(at)}`;
  return { code: out, errors: [...new Set(errors)] };
}

/**
 * The names the survey page actually uses. A script written by something that
 * has never seen the page guesses (`.next-button`, `#next`, `.question`) and a
 * guess that matches nothing is the commonest reason a script "does not run",
 * so a literal selector that looks like one of those guesses is named, with the
 * real hook, before the survey is ever opened.
 */
export const UX_DOM_HOOKS = [
  { what: "the Next / Submit button", use: '[data-testid="rs-next"]', guess: /\.(next|submit|continue)[-_]?(button|btn)\b|\.btn[-_]?(next|submit)\b|#(next|submit|continue)(?![\w-])|button\[type=["']?submit/i },
  { what: "the Back button", use: '[data-testid="rs-back"]', guess: /\.(back|prev|previous)[-_]?(button|btn)\b|\.btn[-_]?(back|prev)\b|#(back|prev|previous)(?![\w-])/i },
  { what: "a question card", use: '[data-qid="<question id>"] (or [data-rs-el="question"])', guess: /\.(survey[-_])?question(?![\w-])|\.question[-_](card|container|wrapper|block)\b/i },
  { what: "the progress bar", use: ".rs-progress-fill (inside .rs-progress-track)", guess: /\.progress[-_]?bar\b|#progress\b|\.progress(?![\w-])/i },
] as const;

/** the guesses that appear in the literal selectors of a script, with what to use instead */
export function selectorGuesses(code: string): string[] {
  const { bare, strings } = lexJs(code);
  const out: string[] = [];
  for (const s of strings) {
    if (!/(querySelector(All)?|closest|matches)\s*\(\s*$/.test(bare.slice(Math.max(0, s.start - 40), s.start))) continue;
    for (const h of UX_DOM_HOOKS) if (h.guess.test(s.value)) out.push(`“${s.value}” will not match anything on a survey page — ${h.what} is ${h.use}`);
  }
  return [...new Set(out)];
}
