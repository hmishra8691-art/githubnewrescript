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

/* ------------------------------------------------------------------------------------------------
 * AUTHORING CHECKS — what a script that is being ADDED must get right (P0, 2026-10-16).
 *
 * The runtime gate (`validateUxScript`) decides whether a stored script may run; it stays lenient
 * so a survey that was saved yesterday keeps running today. These checks are stricter and apply
 * where a script is being written — Intelligent Mode's create_behavior / update_behavior /
 * set_custom_code — because each of them describes a script that cannot do what it was written
 * for on a survey page, while looking perfectly reasonable as code:
 *
 *   - every alternative of a selector belongs to some other survey tool (SurveyJS `.sd-…`,
 *     Qualtrics `#NextButton`, `[data-variable=…]`, `input[name="AGE_SCR"]`): it matches nothing,
 *     the element is null, and the script either throws or waits for ever;
 *   - it disables or hides the Next / Back button: the sandbox refuses that (a script that fails
 *     half-way would strand the respondent), so the button only LOOKS disabled. Stopping a
 *     respondent is the question's validation — the platform holds Next, says why, and the
 *     server checks it again;
 *   - it waits for an element by calling itself on a timer: on a survey page the elements exist
 *     when the script starts, so the wait only ever ends when the selector is right.
 *
 * Seen in the field: a Hindi request for "JavaScript" on AGE_SCR produced exactly this (all
 * three), was accepted with one warning, and did nothing in the live survey.
 * ------------------------------------------------------------------------------------------------ */

type AuthoringDef = { questions: { id: string; code: string; variableName?: string; type?: string }[] };

/** selector alternatives that never match on a survey page, with what to use instead */
const FOREIGN_HOOKS: { test: (part: string, def: AuthoringDef) => boolean; use: (part: string, def: AuthoringDef) => string }[] = [
  ...UX_DOM_HOOKS.map((h) => ({ test: (p: string) => h.guess.test(p), use: () => `${h.what} is ${h.use}` })),
  { test: (p) => /\.(?:sd|sv)[-_]|\.sv_[a-z]/i.test(p), use: () => "SurveyJS class names do not exist here" },
  { test: (p) => /\[\s*aria-label\s*[~|^$*]?=\s*["']?(?:next|back|previous|prev|submit|continue)\b/i.test(p), use: () => 'the Next / Submit button is [data-testid="rs-next"] and Back is [data-testid="rs-back"] (they carry no aria-label)' },
  { test: (p) => /#(?:NextButton|PreviousButton)\b|\.(?:QuestionBody|QuestionOuter|QuestionText|InputText|ChoiceStructure|Skin)\b/.test(p), use: () => "Qualtrics element names do not exist here" },
  { test: (p) => /\[\s*data-(?:role|variable|var|name|field|question-id|question-code|qcode)\s*(?:[~|^$*]?=|\])/i.test(p), use: () => "survey elements carry data-qid, data-testid, data-rs-el and data-code, not that attribute" },
  {
    // radios are named by the question's id ("q3"), never by its code or variable name
    test: (p, def) => { const m = /\[\s*name\s*[~|^$*]?=\s*["']?([^"'\]]+)/i.exec(p); return !!m && !def.questions.some((q) => m[1].trim().startsWith(q.id)); },
    use: () => "answer boxes have no name — use the question's card",
  },
];

const cssAlternatives = (sel: string) => {
  const out: string[] = []; let depth = 0, cur = "", quote: string | null = null;
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

/** the question a selector is trying to reach, by its code or variable name */
function questionNamedIn(sel: string, def: AuthoringDef) {
  return def.questions.find((q) => [q.code, q.variableName].filter(Boolean).some((n) => new RegExp(`(^|[^\\w])${String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(sel)));
}

const answerHook = (q: AuthoringDef["questions"][number]) => {
  const box = ["single_select", "multi_select", "yes_no", "image_select"].includes(q.type ?? "") ? '[data-rs-el="option"]' : "input";
  return `[data-qid="${q.id}"] ${box}`;
};

export function scriptAuthoringProblems(code: string, def: AuthoringDef): string[] {
  const { bare, strings } = lexJs(code);
  const errors: string[] = [];
  // 1. selectors from another survey tool
  for (const s of strings) {
    if (!/(querySelector(All)?|closest|matches)\s*\(\s*$/.test(bare.slice(Math.max(0, s.start - 40), s.start))) continue;
    const parts = cssAlternatives(s.value);
    if (!parts.length) continue;
    const foreign = parts.map((p) => FOREIGN_HOOKS.find((h) => h.test(p, def)));
    if (foreign.some((f) => !f)) continue; // one alternative is a real hook: the selector can match
    const q = questionNamedIn(s.value, def);
    const why = [...new Set(foreign.map((f, i) => f!.use(parts[i], def)))].join("; ");
    errors.push(`the selector “${s.value}” matches nothing on a survey page (${why})${q ? ` — the answer box of ${q.code} is ${answerHook(q)}, its card [data-qid="${q.id}"]` : ""}`);
  }
  // 1b. the ids and codes a selector names must exist in this survey (the model writes the code where the id belongs)
  for (const s of strings) {
    for (const m of s.value.matchAll(/data-qid\s*=\s*["']?([^"'\]\s]+)/g)) {
      const id = m[1];
      if (def.questions.some((q) => q.id === id)) continue;
      const byName = def.questions.find((q) => q.code === id || q.variableName === id);
      errors.push(byName ? `[data-qid="${id}"] names ${byName.code} by its ${byName.code === id ? "code" : "variable name"} — a card carries the question's id: [data-qid="${byName.id}"]` : `[data-qid="${id}"] — there is no question with the id “${id}” (the ids are in the outline)`);
    }
    const qid = /data-qid\s*=\s*["']?([^"'\]\s]+)/.exec(s.value)?.[1];
    const q = qid ? def.questions.find((x) => x.id === qid) as (AuthoringDef["questions"][number] & { options?: { code: unknown }[]; rows?: { code: unknown }[] }) | undefined : undefined;
    if (!q) continue;
    for (const m of s.value.matchAll(/data-rs-el\s*=\s*["']?(option|row)["']?\s*\]\s*\[\s*data-rs-id\s*=\s*["']?([^"'\]]+)/g)) {
      const list = (m[1] === "option" ? q.options : q.rows) ?? [];
      if (!list.some((o) => String(o.code) === m[2])) errors.push(`${q.code} has no ${m[1]} coded “${m[2]}” (${m[1]}s: ${list.slice(0, 12).map((o) => String(o.code)).join(", ") || "none"})`);
    }
  }
  if (errors.length) errors[errors.length - 1] += `. The survey's real hooks: Next [data-testid="rs-next"], Back [data-testid="rs-back"], a question's card [data-qid="<question id>"] (the ids are in the outline), its answer box [data-qid="<id>"] input, an option [data-rs-el="option"]`;
  // 2. disabling or hiding the Next / Back button
  const navRef = /rs-next|rs-back|rs-nav|next|back|submit|continue|prev/i;
  const disables = [...bare.matchAll(/([A-Za-z_$][\w$]*(?:\s*\(\s*\))?)\s*\.\s*(disabled|hidden)\s*=(?!=)\s*([^;\n]*)/g)]
    .filter((m) => navRef.test(m[1]) && !/^\s*false\b/.test(m[3]));
  const setAttr = [...bare.matchAll(/([A-Za-z_$][\w$]*(?:\s*\(\s*\))?)\s*\.\s*(?:setAttribute|toggleAttribute)\s*\(/g)].filter((m) => navRef.test(m[1]));
  const setAttrNav = setAttr.some((m) => { const lit = strings.find((x) => x.start > m.index! && x.start - (m.index! + m[0].length) < 4); return !!lit && /^(disabled|hidden)$/i.test(lit.value); });
  const directNav = strings.some((s) => /rs-next|rs-back|rs-nav/.test(s.value) && /^\s*\)\s*\.\s*(disabled|hidden)\s*=(?!=)/.test(bare.slice(s.end, s.end + 30)));
  if (disables.length || setAttrNav || directNav) {
    errors.push("a script cannot disable or hide the Next / Back button — if the script stopped half-way the respondent would be stranded, so the survey keeps the button working and it would only LOOK disabled. To stop a respondent continuing (an age limit, an eligibility rule, a required format), give the question validation with its message — set_validation, e.g. {\"kind\":\"min_value\",\"value\":18,\"message\":\"You must be 18 or above to participate.\"}: the survey then refuses Next, shows the message, and the server checks it again. A script may still show your own messages and change Next's classes and styles");
  }
  // 3b. CSS and code are not elements a script makes: <style>/<link>/<script> and document.head are dropped by the sandbox, so
  //     keyframes defined that way never exist and an animation that names them silently does nothing
  const makes = strings.filter((x) => /createElement\s*\(\s*$/.test(bare.slice(Math.max(0, x.start - 20), x.start)) && /^(style|link|script|iframe|object|embed|meta|base)$/i.test(x.value.trim()));
  if (makes.length || /\bdocument\s*\.\s*head\b/.test(bare)) {
    errors.push(`a script cannot add ${makes.length ? `a <${makes[0].value.trim().toLowerCase()}> element` : "to document.head"} — the survey drops it, so CSS or keyframes added that way never apply. For CSS use create_style (scoped to the question; @keyframes allowed there); for motion use create_animation (presets: fade-in, fade-up, pop, pulse, shake, bounce, glow…) or rs.animate(target, preset); a script may still set inline styles and transitions on its own elements (el.style.transition / el.style.opacity)`);
  }
  // 3c. an inline animation that names keyframes nobody defined
  for (const m of code.matchAll(/animation(?:-name)?\s*:\s*([A-Za-z_][\w-]*)/g)) {
    const name = m[1];
    if (/^(none|inherit|initial|unset)$/i.test(name) || /^rs-ux-/.test(name)) continue;
    if (!/@keyframes/.test(code) || makes.length || /document\s*\.\s*head/.test(code)) {
      errors.push(`the inline animation “${name}” names keyframes the survey does not have, so nothing moves — use rs.animate(target, "fade-in"|"pop"|"pulse"…) or create_animation, or animate with transitions (set el.style.transition, then change opacity/transform after rs.after(30, …))`);
      break;
    }
  }
  // 3. waiting for an element by calling itself on a timer
  for (const fn of bare.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    const name = fn[1];
    let depth = 0, i = fn.index! + fn[0].length - 1, end = bare.length;
    for (; i < bare.length; i++) { if (bare[i] === "{") depth++; else if (bare[i] === "}" && --depth === 0) { end = i; break; } }
    const body = bare.slice(fn.index!, end);
    const self = new RegExp(`(?:setTimeout|rs\\s*\\.\\s*after)\\s*\\(\\s*(?:${name}\\b|function\\s*\\([^)]*\\)\\s*\\{\\s*${name}\\s*\\(|\\([^)]*\\)\\s*=>\\s*\\{?\\s*${name}\\s*\\()|(?:setTimeout|rs\\s*\\.\\s*after)\\s*\\(\\s*\\d+\\s*,\\s*(?:${name}\\b|\\([^)]*\\)\\s*=>\\s*\\{?\\s*${name}\\s*\\()`);
    if (self.test(body)) errors.push(`${name}() waits for an element by calling itself on a timer — on a survey page the elements a script names already exist when it starts (one that is never found means its selector is wrong, and the timer would run for ever); for something that appears later use rs.listen or a MutationObserver`);
  }
  return [...new Set(errors)];
}

/**
 * What the Studio can and cannot say about a generated script before anyone runs it: it was
 * checked (it parses, uses only the sandbox's api and the survey's real page hooks, and does none
 * of the things a survey page refuses), but checking is not running. The card says so, so a
 * generated script is never presented as a tested one.
 */
export const SCRIPT_CHECKED = "checked before it was added (it parses, uses the survey's real page hooks and the sandbox's rules); not run yet — try it in Preview";
