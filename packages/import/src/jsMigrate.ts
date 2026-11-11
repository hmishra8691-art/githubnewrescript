import { codeGate, gateReason } from "@rescript/engine";

/**
 * QUALTRICS JAVASCRIPT → RESCRIPT SCRIPT MIGRATION (import brief §8, I3).
 *
 * A STATIC reading of the code: nothing here runs it. For each piece of
 * imported JavaScript it says
 *
 *   where it is attached and on which event (addOnload / addOnReady /
 *     addOnUnload / addOnPageSubmit → on_load / on_submit),
 *   what it reads and writes (embedded fields, questions),
 *   which Qualtrics API calls it makes and what each becomes here,
 *   whether it touches the page (DOM, jQuery) or the network,
 *
 * and gives ONE verdict:
 *
 *   compatible     every statement has a Rescript logic-script equivalent; a translated script is produced and
 *                  passes the script check — still imported switched OFF, for a person to review and switch on
 *   native         the code is a known pattern a native setting reproduces exactly (hide Next, show it after N
 *                  seconds = a page timer with a minimum time) — the setting is proposed, the code kept for reference
 *   partial        some calls translate, others need a person (the findings say which and how)
 *   incompatible   it needs the page itself or the network (jQuery, DOM, fetch, redirects) — kept for reference only
 *
 * The translated code is never enabled by the importer. The script check (S0 code gate) runs on it.
 */
export type MigrationVerdict = "compatible" | "native" | "partial" | "incompatible";
export type ScriptEvent = "on_load" | "on_submit";

export interface JsFinding { call: string; becomes: string; status: "translated" | "needs_review" | "not_possible"; why?: string }
export interface JsMigration {
  location: string;
  hooks: { hook: string; event: ScriptEvent }[];
  reads: { embedded: string[]; questions: string[] };
  writes: { embedded: string[] };
  findings: JsFinding[];
  touchesPage: boolean;
  network: boolean;
  verdict: MigrationVerdict;
  /** the logic-script body (compatible only) */
  translated?: { event: ScriptEvent; code: string; gate: { ok: boolean; reason?: string } };
  /** a native setting that reproduces the code exactly (native only) */
  native?: { kind: "page_timer"; minSeconds: number; detail: string } | { kind: "rules"; detail: string };
  /** one sentence for the script's notes and the report */
  summary: string;
}

const HOOKS: Record<string, ScriptEvent> = { addOnload: "on_load", addOnReady: "on_load", addOnUnload: "on_submit", addOnPageSubmit: "on_submit" };

/** a call the analyser knows, what it becomes, and whether that is automatic */
const CALLS: { re: RegExp; call: string; becomes: string; status: JsFinding["status"]; why?: string; page?: boolean; net?: boolean }[] = [
  { re: /Qualtrics\.SurveyEngine\.set(?:JS)?EmbeddedData\s*\(/g, call: "setEmbeddedData", becomes: "setEmbedded(name, value)", status: "translated" },
  { re: /Qualtrics\.SurveyEngine\.getEmbeddedData\s*\(/g, call: "getEmbeddedData", becomes: "getEmbedded(name)", status: "translated" },
  { re: /\$\{e:\/\/Field\/[\w.-]+\}/g, call: "${e://Field/…} piped into the code", becomes: "getEmbedded(name)", status: "translated" },
  { re: /\$\{q:\/\/QID\d+\/[^}]*\}/g, call: "${q://…} piped into the code", becomes: "get(question code)", status: "needs_review", why: "Qualtrics pipes the choice TEXT; get() returns the answer CODE — check every comparison that uses it" },
  { re: /\.(?:hide|show)NextButton\s*\(/g, call: "hide/showNextButton", becomes: "a page timer (minimum time), or rs.hide/rs.show(\"next\") in a UX script", status: "needs_review", why: "Rescript scripts do not hold the Next button; a minimum time before Next is a native page-timer setting", page: true },
  { re: /\.(?:disable|enable)NextButton\s*\(/g, call: "disable/enableNextButton", becomes: "a page timer (minimum time) or validation", status: "needs_review", page: true },
  { re: /\.clickNextButton\s*\(/g, call: "clickNextButton", becomes: "a page timer with auto-advance (limit + advance)", status: "needs_review", why: "advancing the page is the runtime's job; a timer's onTimeout: advance does it natively", page: true },
  { re: /\.clickPreviousButton\s*\(/g, call: "clickPreviousButton", becomes: "—", status: "not_possible", why: "a script cannot move the respondent back", page: true },
  { re: /\.setChoiceValue(?:ByRecodeValue)?\s*\(/g, call: "setChoiceValue", becomes: "a punch rule (preferred) or set(code, value)", status: "needs_review", why: "an answer set by code is a punch rule in Rescript, applied on every device and in the server replay" },
  { re: /\.(?:getChoiceValue|getSelectedChoices|getSelectedAnswerValue|getChoiceAnswerValue)\s*\(/g, call: "getChoiceValue / getSelectedChoices", becomes: "get(question code)", status: "needs_review", why: "the question is named by its Rescript code, not `this`" },
  { re: /\.getQuestionContainer\s*\(|\.getQuestionTextContainer\s*\(|\.questionContainer\b/g, call: "getQuestionContainer", becomes: "a UX-layer rule on the question", status: "not_possible", why: "logic scripts run in a sandbox without the page; visual changes are UX rules", page: true },
  { re: /\bjQuery\s*\(|\$\s*\(|\$j\s*\(/g, call: "jQuery", becomes: "a UX-layer rule", status: "not_possible", why: "jQuery is not loaded and scripts do not reach the page", page: true },
  { re: /\bdocument\.(?:getElementById|querySelector(?:All)?|getElementsBy\w+|createElement)\s*\(/g, call: "document DOM access", becomes: "a UX-layer rule", status: "not_possible", why: "scripts run in a sandbox without the respondent's page", page: true },
  { re: /\b(?:fetch|XMLHttpRequest|navigator\.sendBeacon)\b|\$\.(?:ajax|get|post|getJSON)\s*\(|jQuery\.(?:ajax|get|post)\s*\(/g, call: "network request", becomes: "—", status: "not_possible", why: "scripts cannot reach the network; a signed webhook (Alerts) sends data out", net: true },
  { re: /\b(?:window\.)?location(?:\.href)?\s*=|window\.open\s*\(|location\.(?:assign|replace)\s*\(/g, call: "redirect / window.location", becomes: "an end element with a redirect URL", status: "not_possible", why: "redirects are part of the flow, with piped parameters", net: true },
  { re: /\bsetInterval\s*\(/g, call: "setInterval", becomes: "—", status: "not_possible", why: "scripts run once per event and are stopped after a time limit" },
  { re: /\bsetTimeout\s*\(/g, call: "setTimeout", becomes: "a page timer, or nothing", status: "needs_review", why: "scripts run once and are bounded; delays belong to timers" },
];

/** the body of each hook: Qualtrics.SurveyEngine.addOnload(function(){ BODY }) */
function hooksOf(code: string): { hook: string; event: ScriptEvent; body: string }[] {
  const out: { hook: string; event: ScriptEvent; body: string }[] = [];
  const re = /Qualtrics\.SurveyEngine\.(addOnload|addOnReady|addOnUnload|addOnPageSubmit)\s*\(\s*function\s*\([^)]*\)\s*\{/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1, i = re.lastIndex;
    for (; i < code.length && depth; i++) { const ch = code[i]; if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === "'" || ch === '"' || ch === "`") { const q = ch; for (i++; i < code.length && code[i] !== q; i++) if (code[i] === "\\") i++; } }
    out.push({ hook: m[1], event: HOOKS[m[1]], body: code.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/** strip comments so a commented-out call is not counted */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");

export function analyzeQualtricsJs(rawCode: string, location: string, questionRefs: (qid: string) => string | undefined = () => undefined): JsMigration {
  const code = stripComments(rawCode);
  const hooks = hooksOf(code);
  const findings: JsFinding[] = [];
  let touchesPage = false, network = false;
  for (const c of CALLS) {
    const n = [...code.matchAll(c.re)].length;
    if (!n) continue;
    findings.push({ call: n > 1 ? `${c.call} (×${n})` : c.call, becomes: c.becomes, status: c.status, ...(c.why ? { why: c.why } : {}) });
    if (c.page) touchesPage = true;
    if (c.net) network = true;
  }
  const ed = (re: RegExp) => [...new Set([...code.matchAll(re)].map((m) => m[1]))];
  const writes = { embedded: ed(/set(?:JS)?EmbeddedData\s*\(\s*["']([\w.-]+)["']/g) };
  const reads = { embedded: [...new Set([...ed(/getEmbeddedData\s*\(\s*["']([\w.-]+)["']/g), ...ed(/\$\{e:\/\/Field\/([\w.-]+)\}/g)])], questions: [...new Set(code.match(/QID\d+/g) ?? [])] };
  const base = { location, hooks: hooks.map(({ hook, event }) => ({ hook, event })), reads, writes, findings, touchesPage, network };

  /* NATIVE: hide Next, then show it again after a fixed delay (and nothing else) = a minimum time on the page */
  const flat = code.replace(/\s+/g, " ");
  const delay = /\.hideNextButton\(\)\s*;?.*setTimeout\s*\(\s*function\s*\(\)\s*\{\s*[\w.]*\.showNextButton\(\)\s*;?\s*\}\s*,\s*(\d+)\s*\)/.exec(flat);
  const onlyTimerCalls = findings.every((f) => /hide\/showNextButton|setTimeout|EmbeddedData|e:\/\/Field/.test(f.call));
  if (delay && onlyTimerCalls && !network) {
    const secs = Math.max(1, Math.round(Number(delay[1]) / 1000));
    const extra = writes.embedded.length ? ` Its embedded-data writes (${writes.embedded.join(", ")}) are translated into a script kept switched off.` : "";
    return { ...base, verdict: "native", native: { kind: "page_timer", minSeconds: secs, detail: `hides Next and shows it after ${delay[1]} ms` }, ...(writes.embedded.length ? { translated: translate(hooks.map((h) => ({ ...h, body: [...h.body.matchAll(/Qualtrics\.SurveyEngine\.set(?:JS)?EmbeddedData\s*\([^;]*?\)\s*;?/g)].map((m) => m[0].trim().replace(/;?$/, ";")).join("\n") })).filter((h) => h.body), questionRefs) } : {}), summary: `Native: the code hides Next for ${secs} s — a page timer with a ${secs}-second minimum does exactly that.${extra}` };
  }
  if (network || findings.some((f) => f.status === "not_possible" && f.call !== "setInterval" && !/clickPrevious/.test(f.call)) && !findings.some((f) => f.status === "translated")) {
    return { ...base, verdict: "incompatible", summary: `Incompatible: it ${network ? "uses the network or redirects" : "works on the page itself (DOM / jQuery)"}; Rescript scripts run in a sandbox without either. Kept for reference — ${findings.filter((f) => f.status === "not_possible").map((f) => `${f.call}: ${f.why ?? "not possible"}${f.becomes !== "—" ? ` (use ${f.becomes})` : ""}`).join("; ")}.` };
  }
  if (findings.length && findings.every((f) => f.status === "translated") && hooks.length) {
    const t = translate(hooks, questionRefs);
    if (t.gate.ok) return { ...base, verdict: "compatible", translated: t, summary: `Compatible: ${findings.map((f) => `${f.call} → ${f.becomes}`).join("; ")}. A translated script (${t.event}) is attached, switched off, and passes the script check.` };
    return { ...base, verdict: "partial", translated: t, summary: `Partial: the calls translate, but the translated script does not pass the script check (${t.gate.reason}).` };
  }
  return { ...base, verdict: findings.some((f) => f.status === "translated") || !findings.length ? "partial" : touchesPage ? "incompatible" : "partial", summary: `${findings.some((f) => f.status !== "translated") ? "Needs a person" : "Partial"}: ${findings.length ? findings.map((f) => `${f.call} → ${f.becomes}${f.status !== "translated" ? ` (${f.why ?? f.status.replace("_", " ")})` : ""}`).join("; ") : "no Qualtrics API calls were recognised; read the code"}.` };
}

/** the logic-script body for code whose every call translates */
function translate(hooks: { hook: string; event: ScriptEvent; body: string }[], questionRefs: (qid: string) => string | undefined): { event: ScriptEvent; code: string; gate: { ok: boolean; reason?: string } } {
  const event: ScriptEvent = hooks.some((h) => h.event === "on_submit") && !hooks.some((h) => h.event === "on_load") ? "on_submit" : "on_load";
  const body = hooks.filter((h) => h.event === event).map((h) => h.body).join("\n")
    .replace(/Qualtrics\.SurveyEngine\.set(?:JS)?EmbeddedData\s*\(/g, "setEmbedded(")
    .replace(/Qualtrics\.SurveyEngine\.getEmbeddedData\s*\(/g, "getEmbedded(")
    .replace(/(["'])\$\{e:\/\/Field\/([\w.-]+)\}\1/g, (_m, _q, f: string) => `getEmbedded(${JSON.stringify(f)})`)
    .replace(/\$\{q:\/\/(QID\d+)\/[^}]*\}/g, (_m, qid: string) => `" + get(${JSON.stringify(questionRefs(qid) ?? qid)}) + "`)
    .replace(/\bvar\b/g, "let")
    .trim();
  const g = codeGate(body, "logic");
  return { event, code: body, gate: g.ok ? { ok: true } : { ok: false, reason: gateReason(g) } };
}
