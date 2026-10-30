import { lexJs } from "./ux.js";
import { readScript, tokenize, type StyleSet } from "./scriptAst.js";

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
  // 4. (S1a) rs.setAnswer with a FIXED value: that is a default value (or a punch rule), which the survey applies itself —
  //    rs.setAnswer is for a value the script computes (a timer, a count, something only code can know)
  for (const m of bare.matchAll(/\brs\s*\.\s*setAnswer\s*\(/g)) {
    const at = m.index! + m[0].length;
    const ref = strings.find((x) => x.start >= at && /^\s*$/.test(bare.slice(at, x.start)));
    if (!ref) continue;
    const rest = bare.slice(ref.end);
    const lit = /^\s*,\s*(-?\d+(?:\.\d+)?|true|false|null|(["'`])\s*\2|\[[\s\d,."'`-]*\])\s*(?:,[^)]*)?\)/.exec(rest);
    if (lit) { errors.push(`scripts cannot fill in a fixed answer — rs.setAnswer("${ref.value}", …) with a constant is a starting answer: set its default value (set_default_value, or Properties → Default value), or a punch rule when it follows another answer. rs.setAnswer is for a value only the script can work out (a timer, a count, something it measured)`); break; }
  }
  errors.push(...popupProblems(code));
  return [...new Set(errors)];
}

/* ------------------------------------------------------------------------------------------------
 * POPUPS (P3, 2026-10-17). "When Q3 has option 1 selected, display a popup" produced scripts that
 * built their own overlay: a position:fixed div appended to the body, its own fade timers, nothing
 * that closed it when the answer changed — one landed in the far left corner of the screen. The
 * survey has a popup of its own (the show_popup effect, rs.popup in a script): centred or anchored,
 * sized for phones, accessible, one per behaviour, closed when its condition stops. So:
 *
 *   - a script that appends a position:fixed element to the body that covers the screen or is
 *     plainly a popup (popup / modal / overlay / dialog / backdrop) is refused with that alternative;
 *   - a script that opens rs.popup from an answer event (select, deselect, answer, change, an
 *     input / change listener) and never calls rs.closePopup is refused: when the answer changes
 *     the popup would still be saying something that is no longer true. REFUSED, not warned,
 *     because staying in step with the answer is the whole requirement, the fix is one line (or the
 *     declarative effect, which closes itself), and a refusal is what sends the model its one
 *     repair with the reason; it is an authoring check, so a stored script keeps running.
 * ------------------------------------------------------------------------------------------------ */

/** the code with comments blanked but string contents kept (style text lives in strings) */
function withoutComments(code: string): string {
  const { bare, strings } = lexJs(code);
  let out = bare;
  for (const s of strings) out = out.slice(0, s.start) + code.slice(s.start, s.end) + out.slice(s.end);
  return out;
}

export const POPUP_ALTERNATIVE = 'use the survey\'s own popup instead — a behaviour effect {"do":"show_popup","text":"…","title":"…","placement":"center"} (on select_option with "options" it shows only while the option is selected and closes by itself), or in a script rs.popup(text, {title, placement: "center"|"anchored"|"top"|"inline", target}) with rs.closePopup()';

export function popupProblems(code: string): string[] {
  const src = withoutComments(code);
  const { bare } = lexJs(code);
  const out: string[] = [];
  /* #14b (2026-10-22): read from the script's tokens, in any spelling the sandbox lets through — not from its text */
  const o = overlaySignals(code);
  if (o.overlay) {
    const sets = [o.zIndex !== null && o.zIndex >= HIGH_Z ? `z-index ${o.zIndex}` : "", o.backdrop ? "a dimmed backdrop" : ""].filter(Boolean);
    const seen = [sets.length ? `it sets ${sets.join(" and ")}` : "", o.words.length ? `its names say ${o.words.slice(0, 2).map((w) => `“${w}”`).join(", ")}` : ""].filter(Boolean);
    out.push(`the script builds its own popup (a position: ${o.position} element appended to ${o.onBody ? "document.body" : "the page"}${o.covers ? " that covers the whole screen" : ""}) — it is not sized for phones, not reachable by keyboard or a screen reader, and nothing closes it when the answer changes${seen.length ? ` (${seen.join("; ")})` : ""}; ${POPUP_ALTERNATIVE}`);
  }
  const opens = /\brs\s*\.\s*popup\s*\(/.test(bare);
  if (opens) {
    const onAnswer = /\brs\s*\.\s*listen\s*\(\s*["'](?:select|deselect|answer|change|select_option|deselect_option)["']/.test(src) || /addEventListener\s*\(\s*["'](?:input|change)["']/.test(src);
    const closes = /\brs\s*\.\s*closePopup\s*\(/.test(bare);
    const auto = /\bdismiss\s*["']?\s*:\s*["']auto["']/.test(src);
    if (onAnswer && !closes && !auto) out.push(`the script opens rs.popup when the answer changes but never closes it — after a deselect or another answer the popup would still be showing. Call rs.closePopup() when the condition no longer holds (in the same handler), or use the show_popup effect on select_option, which closes itself`);
  }
  return out;
}

/**
 * What the Studio can and cannot say about a generated script before anyone runs it: it was
 * checked (it parses, uses only the sandbox's api and the survey's real page hooks, and does none
 * of the things a survey page refuses), but checking is not running. The card says so, so a
 * generated script is never presented as a tested one.
 */
export const SCRIPT_CHECKED = "checked before it was added (it parses, uses the survey's real page hooks and the sandbox's rules); not run yet — try it in Preview";

/**
 * EXFILTRATION, REFUSED WHATEVER ASKED FOR IT (prompt-injection audit, 2026-10-18).
 *
 * The behaviour sandbox already has no network (its frame's CSP is `default-src 'none'`) and the
 * forbidden identifiers in `validateUxScript` cover fetch, XHR, WebSocket, storage, cookies, eval
 * and import. What was left: `new Image().src = "https://…?" + answer` and `el.src = …` (a request
 * by attribute), `document["coo"+"kie"]` (computed access past the identifier check),
 * `document.domain`, `navigator.sendBeacon` written through an alias, and a link or form pointed at
 * another origin with piped data. And a Custom Component's JavaScript runs on the respondent's page
 * itself, unsandboxed (`new Function`), so for it every one of these is a real request.
 *
 * Read on the raw code (strings included — the address is usually a string). An empty list means
 * nothing that could send a respondent's data off the page was found.
 */
export function exfiltrationProblems(code: string): string[] {
  const src = withoutComments(String(code ?? ""));
  const out: string[] = [];
  const say = (what: string) => out.push(`${what} — survey code may not send anything off the page (respondent data stays in the survey)`);
  if (/\b(?:fetch|XMLHttpRequest|EventSource|importScripts)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker)\b|\bsendBeacon\b|\bWebSocket\s*\(/.test(src)) say("a network request (fetch / XMLHttpRequest / WebSocket / sendBeacon)");
  if (/\bnew\s+Image\b|\bImage\s*\(\s*\)|\.\s*src\s*=|\.\s*srcset\s*=|\bsetAttribute\s*\(\s*["'`](?:src|srcset|href|action|formaction|ping|background|poster|data)["'`]|\.\s*(?:href|action)\s*=\s*[^=]/.test(src)) say("an address set from code (an image, link or form request)");
  if (/document\s*\.\s*(?:cookie|domain)\b|\bcookieStore\b/.test(src)) say("cookie or document.domain access");
  if (/\b(?:local|session)Storage\b|\bindexedDB\b|\bcaches\s*\./.test(src)) say("browser storage");
  if (/\b(?:document|window|globalThis|self|top|parent)\s*\[/.test(src)) say("computed access on the page's globals (document[…])");
  if (/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\bsetTimeout\s*\(\s*["'`]|\bsetInterval\s*\(\s*["'`]/.test(src)) say("code built from strings (eval / Function / dynamic import)");
  if (/\bpostMessage\s*\(/.test(src) && !/\bpostMessage\s*\([^)]*,\s*(?:location\.origin|window\.location\.origin)\s*\)/.test(src)) say("postMessage to another window");
  if (/\b(?:window\s*\.\s*)?(?:location\s*(?:\.\s*(?:href|assign|replace)\s*[=(]|=)|open\s*\(\s*["'`]https?:)/.test(src)) say("navigation to another address");
  if (/https?:\/\/[^"'`\s]*(?:\{\{|\$\{)/.test(src)) say("an external address carrying piped or computed data");
  /*
   * D4 (audit 2026-10-30): a CSS url() / image-set() BUILT from pieces — `"url(" + x + ")"`, `url(${x})`, or a
   * literal containing it joined to something computed — makes the browser fetch an address carrying data. The
   * runtime refuses every url() set from code (checkDeclarations origin "script"); refusing the built ones here
   * says why before anyone previews it.
   */
  if (/(?:\burl|image-set)\s*\([^\n]*?["'`]\s*\+|\+\s*["'`][^"'`\n]*(?:\burl|image-set)\s*\(|`[^`]*(?:\burl|image-set)\s*\([^`]*\$\{|\.\s*concat\s*\([^)]*(?:\burl|image-set)\s*\(/i.test(src)) say("a CSS url() built from code (a style that would load an address carrying data)");
  return [...new Set(out)];
}

/* ------------------------------------------------------------------------------------------------
 * HAND-BUILT OVERLAYS, READ FROM THE TOKENS (engine weakness #14b, 2026-10-22).
 *
 * The old check was two regular expressions: `position … fixed` somewhere in the text and `body.appendChild(` —
 * so `el["style"]["position"] = "fixed"`, `Object.assign(s, {position: "fixed", inset: 0})` on an alias, a style
 * string built from pieces, an absolute full-viewport box with a huge z-index or an overlay mounted somewhere other
 * than the body all got through. `readScript` gives every style the script sets, in any spelling the sandbox
 * allows (dot, bracket, alias, Object.assign, setProperty, cssText, setAttribute("style"), inline style="" in HTML
 * it writes, a CSS string assigned later), the elements it creates and where it mounts them. An overlay is:
 *
 *   an element the script creates or mounts, AND
 *   position: fixed with (the whole viewport | z-index ≥ 1000 | a dimmed backdrop | popup words), OR
 *   position: absolute covering the whole viewport with (z-index ≥ 1000 | a backdrop | popup words)
 *
 * A small fixed badge ("2/5" in a corner) or an element placed in the question card is not an overlay.
 * ------------------------------------------------------------------------------------------------ */

const HIGH_Z = 1000;
const POPUP_WORDS = /overlay|modal|backdrop|dialog|pop-?up|lightbox|toast|scrim|curtain/i;
const zero = (v: string | undefined) => !!v && /^\s*-?0(?:px|%|vh|vw|rem|em)?\s*$/.test(v);
const full = (v: string | undefined, axis: "w" | "h") => !!v && (/^\s*100(?:\.0+)?\s*%\s*$/.test(v) || (axis === "w" ? /^\s*(?:1\d\d|100)\s*(?:vw|dvw|svw|lvw)\s*$/ : /^\s*(?:1\d\d|100)\s*(?:vh|dvh|svh|lvh)\s*$/).test(v) || /calc\(\s*100(?:vw|vh|%)/.test(v));

export interface OverlaySignals {
  overlay: boolean;
  position: "fixed" | "absolute" | null;
  covers: boolean;
  zIndex: number | null;
  backdrop: boolean;
  onBody: boolean;
  creates: boolean;
  words: string[];
}
export function overlaySignals(code: string): OverlaySignals {
  const r = readScript(code);
  const last = new Map<string, string>();
  const anyOf = (p: string) => r.styles.filter((s: StyleSet) => s.prop === p).map((s) => s.value);
  for (const s of r.styles) last.set(s.prop, s.value);
  const positions = anyOf("position");
  const position = positions.some((v) => /\bfixed\b/.test(v)) ? "fixed" : positions.some((v) => /\babsolute\b/.test(v)) ? "absolute" : null;
  const inset = anyOf("inset").some((v) => v.split(/\s+/).every((x) => zero(x)));
  const edges = ["top", "right", "bottom", "left"].filter((p) => anyOf(p).some((v) => zero(v)));
  const wide = ["width", "min-width"].some((p) => anyOf(p).some((v) => full(v, "w"))), tall = ["height", "min-height"].some((p) => anyOf(p).some((v) => full(v, "h")));
  const covers = inset || edges.length === 4 || (wide && tall) || (edges.includes("top") && edges.includes("left") && (wide || edges.includes("right")) && (tall || edges.includes("bottom")));
  const zs = anyOf("z-index").map((v) => Number(v)).filter((n) => Number.isFinite(n));
  const zIndex = zs.length ? Math.max(...zs) : null;
  const backdrop = ["background", "background-color"].some((p) => anyOf(p).some((v) => /rgba?\([^)]*,\s*(?:0?\.\d+|0)\s*\)|hsla\([^)]*,\s*(?:0?\.\d+)\s*\)|#[0-9a-f]{8}\b|#[0-9a-f]{4}\b|transparent/i.test(v))) || anyOf("backdrop-filter").length > 0 || anyOf("-webkit-backdrop-filter").length > 0;
  /* popup words: in its class names, ids, attributes (role="dialog", aria-modal) and its own variable / function names — never rs.popup / rs.closePopup themselves */
  const t = tokenize(code);
  const words = new Set<string>();
  for (const n of r.names) if (POPUP_WORDS.test(n)) words.add(n);
  for (const a of r.attributes) if ((a.name === "role" && /dialog/i.test(a.value)) || a.name === "aria-modal" || ((a.name === "class" || a.name === "id") && POPUP_WORDS.test(a.value))) words.add(a.value || a.name);
  for (let i = 0; i < t.length; i++) { const x = t[i]!; if (x.k === "id" && POPUP_WORDS.test(x.v) && !(t[i - 1]?.v === "." && t[i - 2]?.v === "rs") && x.v !== "closePopup") words.add(x.v); }
  const creates = r.creates.length > 0;
  const mounted = r.mounts.length > 0;
  const onBody = r.mounts.some((m) => m.onBody) || /\bdocument\s*(?:\.\s*body|\[\s*["'`]body["'`]\s*\])/.test(code);
  const highZ = zIndex !== null && zIndex >= HIGH_Z;
  const overlay = (creates || mounted) && ((position === "fixed" && (covers || highZ || backdrop || words.size > 0)) || (position === "absolute" && covers && (highZ || backdrop || words.size > 0)));
  return { overlay, position, covers, zIndex, backdrop, onBody, creates, words: [...words] };
}
