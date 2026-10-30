import type { SurveyDefinition, UxBehavior } from "@rescript/schema";
import { uxBehaviorWords, validateUxItem, describeUxTarget } from "./ux.js";
import { codeGate } from "./codeGate.js";

/**
 * DEBUG / WHY / EXPLAIN A SCRIPT (S2a, audit D10 / IM-16, 2026-10-30).
 *
 * "Debug the script on Q5", "Why does the script on Q5 not work", "Explain what the script on Q5 does" used to be
 * deferred to the Studio's grammar (they start with debug / why / explain), which looked for a question called
 * "the script on Q5" and said "I could not find …" — the copilot was never asked. Now:
 *  - `scriptQuestion` recognises such a sentence when it names a script, JavaScript / js / code, a behaviour, a
 *    component or a Scripts-panel script by name;
 *  - `findScripts` resolves which ones (by question — "on Q5", "of Q5", the selection — or by name);
 *  - `scriptDossier` is what the copilot is given: each script IN FULL (up to the schema's 20,000 chars, not the
 *    outline's excerpt), its check verdict and warnings, what it reads and writes, and its script health (failures
 *    seen in the field), when the page sent a summary;
 *  - `explainScripts` is the engine's own answer when no model is configured: what each script does (its event,
 *    its effects, what it reads and writes), whether it passes the check, and what the field reported.
 * Read only: nothing here changes the survey.
 */

export const SCRIPT_QUESTION_REASON = "a question about a script — the language model reads it with the script in full, its check and its health; with no model the engine explains it from the script itself";

/** a script the sentence is about: a UX behaviour script (sandboxed page script) or a Scripts-panel logic script */
export interface ScriptRef { kind: "behavior" | "logic"; id: string; label: string; where: string; code: string; event?: string }
/** the script-health summary the page sends (GET /api/surveys/[id]/script-health), as far as it is used here */
export interface ScriptHealthLite { sessions: number; scripts: { script: string; name?: string; failures: number; sessions: number; messages?: { message: string; count?: number }[] }[] }

const SCRIPT_WORD = /\b(?:scripts?|javascript|js|code|behaviou?rs?|custom components?|components?|event handlers?)\b|स्क्रिप्ट|जावा ?स्क्रिप्ट|कोड/i;
const ASK = /^(?:please\s+|can you\s+|could you\s+)?(?:why\b|debug\b|diagnose\b|troubleshoot\b|explain\b|describe\b|walk\s+me\s+through\b|tell\s+me\s+(?:about|what)\b|what\s+(?:does|is)\b|how\s+does\b|is\s+there\s+(?:a|an)\s+(?:bug|problem|error)\b)|^(?:the\s+)?(?:script|code|javascript|js)\b.{0,80}\b(?:not work|doesn'?t work|does not work|broken|fails?|failing|error)/i;

/** is this a question ABOUT a script (debug / why / explain …), not a request to write one? */
export function scriptQuestion(def: SurveyDefinition, text: string): boolean {
  const t = String(text ?? "").trim();
  if (!ASK.test(t)) return false;
  if (SCRIPT_WORD.test(t)) return true;
  // a Scripts-panel script or a behaviour named by its label ("why does “Total” not run")
  const low = t.toLowerCase();
  return [...(def.scripts ?? []).map((s) => s.name), ...(def.ux?.behaviors ?? []).filter((b) => b.script).map((b) => b.label)].some((n) => n && n.length >= 3 && low.includes(n.toLowerCase()));
}

const qCodeRe = /\b(?:on|of|in|for|at)\s+(?:question\s+)?([A-Za-z][\w.]*\d[\w.]*)\b/i;

/** the scripts a sentence is about: named ones first, then those of the question it names (or the selection), else every script when there are few */
export function findScripts(def: SurveyDefinition, text: string, ctx: { selectedId?: string | null } = {}): ScriptRef[] {
  const all: (ScriptRef & { qid?: string })[] = [
    ...(def.ux?.behaviors ?? []).filter((b) => !!b.script).map((b) => ({ kind: "behavior" as const, id: b.id, label: b.label, where: describeUxTarget(def, b.target), code: b.script!, qid: b.target.questionId })),
    ...(def.scripts ?? []).map((s) => ({ kind: "logic" as const, id: s.id, label: s.name, where: s.scope === "survey" ? "the survey" : s.scope === "question" ? (def.questions.find((q) => q.id === s.ref)?.code ?? s.ref ?? "?") : `${s.scope} ${s.ref ?? "?"}`, code: s.code, event: s.event, qid: s.scope === "question" ? s.ref : undefined })),
  ];
  const strip = ({ qid: _q, ...r }: ScriptRef & { qid?: string }) => r;
  const low = String(text ?? "").toLowerCase();
  const named = all.filter((s) => s.label && s.label.length >= 3 && low.includes(s.label.toLowerCase()));
  if (named.length) return named.map(strip);
  const m = qCodeRe.exec(String(text ?? ""));
  const q = m ? def.questions.find((x) => String(x.code).toLowerCase() === m[1].toLowerCase() || String(x.variableName ?? "").toLowerCase() === m[1].toLowerCase()) : ctx.selectedId ? def.questions.find((x) => x.id === ctx.selectedId) : undefined;
  if (q) return all.filter((s) => s.qid === q.id).map(strip);
  return all.length <= 5 ? all.map(strip) : [];
}

/** what a script reads, writes and hooks into — read from its text (rs api, the logic helpers, [data-qid] hooks) */
export function scriptReadsWrites(code: string): { reads: string[]; writes: string[]; hooks: string[]; events: string[]; effects: string[] } {
  const all = (re: RegExp) => [...new Set([...code.matchAll(re)].map((m) => m[1]))];
  const reads = all(/\b(?:rs\.getAnswer|ctx\.get|get)\s*\(\s*["'`]([^"'`]+)["'`]/g);
  const writes = [...all(/\brs\.(?:setAnswer|setEmbedded|setCalc|flag)\s*\(\s*["'`]([^"'`]+)["'`]/g), ...all(/\b(?:ctx\.)?(?:set|setCalc|setEmbedded)\s*\(\s*["'`]([^"'`]+)["'`]/g)];
  const hooks = all(/\[data-(?:qid|testid|rs-el)\s*=\s*\\?["']([^"'\\]+)\\?["']\]/g);
  const events = [...new Set([...code.matchAll(/\brs\.listen\s*\(\s*["'`]([\w-]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${m[1]} on ${m[2]}`))];
  const EFFECT: [RegExp, string][] = [[/\brs\.showMessage\s*\(/, "shows a message"], [/\brs\.popup\s*\(/, "opens a popup"], [/\brs\.closePopup\s*\(/, "closes the popup"], [/\brs\.(?:addClass|removeClass|toggleClass)\s*\(/, "changes a class"], [/\brs\.setStyle\s*\(/, "changes a style"], [/\brs\.goTo(?:Page|Section)\s*\(/, "moves to another page"], [/\brs\.after\s*\(/, "waits (rs.after)"], [/\bdocument\.createElement\s*\(/, "adds an element to the page"], [/\brs\.(?:setAnswer|setEmbedded|setCalc)\s*\(/, "asks the survey to write a value"], [/\b(?:ctx\.)?error\s*\(/, "raises a validation message"], [/\brs\.log\s*\(|console\.log\s*\(/, "logs"]];
  const effects = EFFECT.filter(([re]) => re.test(code)).map(([, w]) => w);
  return { reads, writes: [...new Set(writes)], hooks, events, effects };
}

/** the check's verdict on one script: the authoring gate for a behaviour, the code gate for a logic script */
export function scriptCheckOf(def: SurveyDefinition, s: ScriptRef): { ok: boolean; errors: string[]; warnings: string[] } {
  if (s.kind === "behavior") {
    const b = (def.ux?.behaviors ?? []).find((x) => x.id === s.id) as UxBehavior | undefined;
    if (!b) return { ok: false, errors: ["the behaviour no longer exists"], warnings: [] };
    const v = validateUxItem(def, "behavior", b, { authoring: true });
    return { ok: !v.errors.length, errors: v.errors, warnings: v.warnings };
  }
  const v = codeGate(s.code, "logic");
  return { ok: v.ok, errors: v.errors, warnings: [] };
}

const healthOf = (h: ScriptHealthLite | null | undefined, s: ScriptRef) => h?.scripts.find((x) => x.script === s.id || (!!x.name && x.name === s.label));
function healthWords(h: ScriptHealthLite | null | undefined, s: ScriptRef): string {
  if (!h) return "no field report (script health was not available)";
  const e = healthOf(h, s);
  if (!e || !e.failures) return `no errors reported in ${h.sessions} session${h.sessions === 1 ? "" : "s"}`;
  return `failed in ${e.sessions} of ${h.sessions} session${h.sessions === 1 ? "" : "s"} (${e.failures} failure${e.failures === 1 ? "" : "s"})${e.messages?.length ? `: ${e.messages.slice(0, 3).map((m) => `“${String(m.message).slice(0, 160)}”`).join("; ")}` : ""}`;
}

function describe(def: SurveyDefinition, s: ScriptRef): string {
  const rw = scriptReadsWrites(s.code);
  const b = s.kind === "behavior" ? (def.ux?.behaviors ?? []).find((x) => x.id === s.id) : undefined;
  const parts: string[] = [];
  if (b) parts.push(uxBehaviorWords(def, b));
  if (s.event) parts.push(`runs on ${s.event}`);
  if (rw.events.length) parts.push(`listens for ${rw.events.map((e) => e.replace(/^answer on self$/, `the answer to ${s.where}`)).join(", ")}`);
  if (rw.effects.length) parts.push(rw.effects.join(", "));
  parts.push(rw.reads.length ? `reads ${rw.reads.join(", ")}` : "reads no answers");
  parts.push(rw.writes.length ? `writes ${rw.writes.join(", ")} (each write is checked by the survey)` : "writes nothing");
  if (rw.hooks.length) parts.push(`page hooks ${rw.hooks.join(", ")}`);
  return parts.join("; ");
}

/** what the copilot is given about the scripts a debug / explain request names: each in full, with its check, reads/writes and health */
export function scriptDossier(def: SurveyDefinition, refs: ScriptRef[], health?: ScriptHealthLite | null): string {
  if (!refs.length) return "";
  const out = [`SCRIPTS THIS REQUEST IS ABOUT (${refs.length}; in full — explain or debug from these, and propose a fix as update_behavior "edits" or a native action when one fits):`];
  for (const s of refs.slice(0, 5)) {
    const v = scriptCheckOf(def, s);
    out.push(`- ${s.kind === "behavior" ? "behaviour" : "Scripts-panel logic script"} ${s.id} “${s.label}” on ${s.where}: ${describe(def, s)}`);
    out.push(`  check: ${v.ok ? "passes the script check" : `REFUSED by the script check — ${v.errors.slice(0, 5).join(" | ")}`}${v.warnings.length ? `; warnings: ${v.warnings.slice(0, 5).join(" | ")}` : ""}`);
    out.push(`  field: ${healthWords(health, s)}`);
    out.push(`  code (${s.code.length} chars): ${JSON.stringify(s.code.slice(0, 20_000))}`);
  }
  return out.join("\n");
}

/** the engine's own answer with no model: what each script does, its check, its field report */
export function explainScripts(def: SurveyDefinition, text: string, ctx: { selectedId?: string | null; health?: ScriptHealthLite | null } = {}): { understood: string; answer: string; sections: { title: string; items: { label: string }[] }[] } {
  const refs = findScripts(def, text, ctx);
  if (!refs.length) {
    const n = (def.ux?.behaviors ?? []).filter((b) => b.script).length + (def.scripts ?? []).length;
    return { understood: "A question about a script.", answer: n ? `No script matches “${String(text).slice(0, 80)}” — this survey has ${n} script${n === 1 ? "" : "s"}; name one by its question (“the script on Q5”) or its name.` : "This survey has no scripts (no behaviour scripts and nothing in the Scripts panel).", sections: [] };
  }
  const debug = /^(?:please\s+)?(?:why|debug|diagnose|troubleshoot|is there)\b|not work|doesn'?t work|broken|fail/i.test(String(text));
  const blocks = refs.slice(0, 5).map((s) => {
    const v = scriptCheckOf(def, s);
    const lines = [
      `What it does: ${describe(def, s)}.`,
      v.ok ? `Check: it passes the script check (it parses, uses the survey's real page hooks and the sandbox's rules)${v.warnings.length ? `, with warnings: ${v.warnings.slice(0, 3).join(" | ")}` : ""} — checked, not run here.` : `Check: refused by the script check — ${v.errors.slice(0, 3).join(" | ")}. This is why it does nothing on the page.`,
      `In the field: ${healthWords(ctx.health, s)}.`,
    ];
    return { title: `“${s.label}” (${s.kind === "behavior" ? "behaviour" : "Scripts panel"}, ${s.where})`, lines };
  });
  const sections = blocks.map((b) => ({ title: b.title, items: b.lines.map((label) => ({ label })) }));
  const head = refs.length === 1 ? `“${refs[0].label}” on ${refs[0].where}` : `${refs.length} scripts`;
  const tail = debug ? " No language model is configured, so this is the engine's reading of the script, its check and its field report — open Preview to run it, or ask again with a model configured for a diagnosis and a fix." : "";
  return { understood: `${debug ? "Debug" : "Explain"} ${head}.`, answer: `${blocks.map((x) => `${x.title}: ${x.lines.join(" ")}`).join("\n")}${tail}`, sections };
}

/** the page-sent script-health summary, made safe for a prompt: numbers bounded, names and messages clipped, at most 50 scripts / 3 messages each */
export function sanitizeScriptHealthLite(raw: unknown): ScriptHealthLite | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { sessions?: unknown; scripts?: unknown };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1_000_000, Math.floor(v))) : 0);
  // eslint-disable-next-line no-control-regex
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n) : "");
  const scripts = Array.isArray(r.scripts) ? r.scripts.slice(0, 50).filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({
    script: str(x.script, 120), name: str(x.name, 120) || undefined, failures: num(x.failures), sessions: num(x.sessions),
    messages: Array.isArray(x.messages) ? x.messages.slice(0, 3).filter((m): m is Record<string, unknown> => !!m && typeof m === "object").map((m) => ({ message: str(m.message, 200), count: num(m.count) })) : [],
  })).filter((x) => x.script) : [];
  return { sessions: num(r.sessions), scripts };
}
