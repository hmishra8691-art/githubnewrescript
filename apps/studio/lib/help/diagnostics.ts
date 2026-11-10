import type { Question, SurveyDefinition } from "@rescript/schema";
import { diagnoseQuestion, lintLoops, lintPipingTokens, lintQuestionLogic, lintSurveyLogic, type LogicIssue } from "@rescript/engine";

/**
 * LEVEL 2: CHECK THE USER'S OWN SURVEY (2026-11-10). A troubleshooting question about a survey the user has open is
 * answered first by looking at that survey — with the same engine checks the Studio and Intelligent Mode use — not by
 * the model and not only by the generic guide.
 *
 *   1. which feature the problem is about (the words: piping, loop, validation, a question not showing, logic);
 *   2. which question (a code named in the message — Q12 — or the question selected in the Studio);
 *   3. the checks for that feature:
 *        not showing   diagnoseQuestion — every reason the question can be missed, in the order the runtime meets
 *                      them, with a verdict (never / sometimes / always shown)
 *        piping        lintPipingTokens on the question's text, options, rows and columns + the survey's piping lints
 *        loop          lintLoops
 *        validation    lintQuestionLogic for the question
 *        logic         lintQuestionLogic for the question, or lintSurveyLogic for the survey
 *   4. a fix: when a check finds something, the instruction for Intelligent Mode — Help never edits the survey; the
 *      change is proposed there and applied only when the user approves it.
 *
 * Every finding is VERIFIED — it is what the survey definition says, not a guess. When nothing is found that is said
 * too: the cause is then at runtime (the respondent's answers, test vs live data, a quota count), which the guide covers.
 */
export type Feature = "visibility" | "piping" | "loop" | "validation" | "logic";
export interface DiagFinding { severity: "blocking" | "warning" | "info"; message: string }
export interface SurveyDiagnosis {
  feature: Feature;
  /** the question checked, or null when the check covered the whole survey */
  target: { id: string; code: string } | null;
  /** what was checked, in words */
  checked: string;
  verdict?: "never" | "sometimes" | "always";
  findings: DiagFinding[];
  summary: string;
  /** an instruction for Intelligent Mode when something can be fixed in the survey */
  fix: string | null;
}

const FEATURES: [Feature, RegExp][] = [
  ["piping", /\bpip(?:e|ed|ing)\b|\{\{|\bplaceholder\b|\b(?:text|name|answer|label) (?:is |shows? (?:as )?)?(?:blank|empty)\b|\bshows? (?:up )?(?:blank|empty|the code)\b/i],
  ["loop", /\bloops?\b|\biterations?\b|\brepeat(?:ed|ing)? (?:for|questions)\b/i],
  ["validation", /\bvalidat|\berror message\b|\bcan'?t (?:continue|proceed|submit|go (?:on|to the next))\b|\bnext button\b|\bstuck on\b|\brequired\b/i],
  ["visibility", /\b(?:not|isn'?t|aren'?t|doesn'?t|don'?t|never|won'?t)\b.{0,20}\b(?:show|showing|shown|appear|appearing|display|displaying|displayed|asked|see|seeing|reach(?:ed|able)?)\b|\bunreachable\b|\bhidden\b|\bmissing question\b|\bskipped\b/i],
  ["logic", /\blogic\b|\bconditions?\b|\bskip\b|\bbranch(?:ing)?\b|\bdisplay rules?\b/i],
];

export function featureFor(text: string): Feature | null {
  for (const [f, re] of FEATURES) if (re.test(text)) return f;
  return null;
}

const plain = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** a question code named in the message (whole word, any case), else the question selected in the Studio */
export function targetQuestion(def: SurveyDefinition, text: string, selectedCode?: string | null): Question | null {
  const byCode = new Map<string, Question>();
  for (const q of def.questions) {
    if (q.code) byCode.set(String(q.code).toLowerCase(), q);
    const v = (q as { variableName?: string }).variableName;
    if (v && !byCode.has(v.toLowerCase())) byCode.set(v.toLowerCase(), q);
  }
  /* only words with a digit (Q12, S3a, BRAND_2): a code like "age" is also an ordinary word */
  for (const w of text.match(/\b[A-Za-z_]\w*\d\w*\b/g) ?? []) {
    const q = byCode.get(w.toLowerCase());
    if (q) return q;
  }
  if (selectedCode) return byCode.get(selectedCode.toLowerCase()) ?? null;
  return null;
}

const issue = (i: LogicIssue): DiagFinding => ({ severity: i.level === "error" ? "blocking" : "warning", message: `${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}` });
const dedupe = (xs: DiagFinding[]) => [...new Map(xs.map((x) => [x.message, x])).values()];

function pipingTexts(q: Question): string[] {
  const x = q as unknown as { text?: string; options?: { label?: string }[]; rows?: { label?: string }[]; columns?: { label?: string }[]; instructions?: string };
  return [x.text, x.instructions, ...(x.options ?? []).map((o) => o.label), ...(x.rows ?? []).map((r) => r.label), ...(x.columns ?? []).map((c) => c.label)].filter((t): t is string => typeof t === "string" && t.includes("{{"));
}

export function diagnoseSurvey(def: SurveyDefinition, message: string, selectedCode?: string | null): SurveyDiagnosis | null {
  const feature = featureFor(message);
  if (!feature) return null;
  const q = targetQuestion(def, message, selectedCode);
  const target = q ? { id: q.id, code: String(q.code) } : null;
  let findings: DiagFinding[] = [];
  let verdict: SurveyDiagnosis["verdict"];
  let checked = "";

  if (feature === "visibility" && q) {
    const d = diagnoseQuestion(def, q.id);
    checked = `why ${q.code} could be missed: its placement in the flow, the path to its page, its display logic, earlier skip rules and the quality check`;
    if (d) {
      verdict = d.verdict;
      findings = d.findings.map((f) => ({ severity: f.severity === "conditional" ? "warning" : f.severity, message: f.message }));
    }
  } else if (feature === "piping") {
    const qs = q ? [q] : def.questions;
    checked = q ? `every piping token in ${q.code}'s text, options, rows and columns` : "every piping token in the survey's questions";
    for (const x of qs) for (const t of pipingTexts(x)) for (const m of lintPipingTokens(def, t, x)) findings.push({ severity: "blocking", message: `${x.code}: ${m}` });
    findings.push(...lintSurveyLogic(def).filter((i) => /pip|\{\{/i.test(i.message) && (!q || !i.questionId || i.questionId === q.id)).map(issue));
  } else if (feature === "loop") {
    checked = "the survey's loops: their source, items, references and the questions inside them";
    findings = lintLoops(def).map(issue);
  } else if ((feature === "validation" || feature === "logic" || feature === "visibility") && q) {
    checked = `${q.code}'s ${feature === "validation" ? "validation and required settings" : "logic"}`;
    findings = lintQuestionLogic(def, q).filter((i) => feature !== "validation" || /valid|required|min|max|range|regex|pattern/i.test(`${i.path} ${i.message}`)).map(issue);
  } else if (feature === "logic") {
    checked = "the logic of every question in the survey";
    findings = lintSurveyLogic(def).filter((i) => i.level === "error").map(issue);
  } else {
    /* "not showing" / "validation" with no question to look at: nothing specific to check */
    return null;
  }

  findings = dedupe(findings).slice(0, 8);
  const serious = findings.filter((f) => f.severity !== "info");
  const what = target ? target.code : "your survey";
  let summary: string;
  if (feature === "visibility" && verdict) {
    summary = verdict === "never" ? `${what} can never be shown as the survey is programmed now.`
      : verdict === "sometimes" ? `${what} is shown only to some respondents — the conditions below decide who.`
      : `${what} is shown to every respondent who reaches its page: nothing in the survey hides it. If a particular respondent didn't see it, the cause is in their answers or the version they took.`;
  } else summary = serious.length ? `I found ${serious.length === 1 ? "one problem" : `${serious.length} problems`} in ${what}.` : `I found nothing wrong in ${what}'s ${feature === "visibility" ? "logic" : feature} — the cause is likely at runtime (the answers given, test vs live data, the version deployed).`;

  const fixable = feature !== "visibility" ? serious : findings.filter((f) => f.severity === "blocking" || /never be true|not there|before it exists/i.test(f.message));
  const fix = fixable.length
    ? feature === "visibility"
      ? `Find out why ${what} is not shown and fix it: ${fixable[0].message}`
      : `Fix the ${feature === "logic" ? "logic" : feature} problem${fixable.length > 1 ? "s" : ""} in ${what}: ${fixable.slice(0, 3).map((f) => f.message).join("; ")}`
    : null;
  return { feature, target, checked, ...(verdict ? { verdict } : {}), findings, summary, fix: fix ? fix.slice(0, 400) : null };
}

/** the diagnosis as the answer's opening section */
export function diagnosisText(d: SurveyDiagnosis): string {
  const icon = { blocking: "✖", warning: "⚠", info: "ℹ" } as const;
  const lines = [`**What I found in your survey** (checked: ${d.checked})`, "", d.summary];
  if (d.findings.length) lines.push("", ...d.findings.map((f) => `- ${icon[f.severity]} ${plain(f.message)}`));
  return lines.join("\n");
}
