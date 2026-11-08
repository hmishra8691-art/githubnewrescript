import { readGenerationRequest } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { parseTranslationRequest } from "../tasks/handlers/translation.ts";
import type { Launcher } from "./launch.ts";
import { QPM, loiOf, type Understanding } from "./understandShared.ts";
export type { Understanding, Clarification } from "./understandShared.ts";

/**
 * WHAT DID THE RESEARCHER ASK FOR? (ResLens agents — natural-language entry, 2026-11-07)
 *
 * One sentence, typed or spoken in any language, becomes: which agent, the fields its launcher needs, what was
 * understood (objective, audience, length, language, logic), and the questions still open. It is read by the SAME
 * readers the Intelligent mode's planners use — `readGenerationRequest` (counts, exams, methods, edits, content
 * language), `parseTranslationRequest` (target languages and scope) — not by a second, looser chatbot. Spoken or
 * non-English input arrives with its English reading (the transcription route's normaliser), which is what the
 * readers see; the researcher's own words are kept beside it.
 *
 * Deterministic and offline: nothing here calls a model, so the same sentence always gets the same reading, and
 * every assumption it makes (a question count from a length of interview, say) is written out for the researcher
 * to accept or change before anything starts.
 */
const AUDIENCE_WORDS = /\b(patients?|customers?|consumers?|users?|voters?|students?|employees?|staff|doctors?|physicians?|nurses?|parents?|teachers?|shoppers?|drivers?|farmers?|respondents?|households?|smes?|businesses|decision[- ]makers?|it buyers?|gen ?z|millennials)\b/i;

function audienceOf(t: string): string | null {
  const stop = String.raw`(?=\s*(?:,|\.|;|\bwith\b|\band a\b|\busing\b|$))`;
  const target = new RegExp(String.raw`\b(?:target(?:ing|ed at)?|among|aimed at)\s+([^,.;]{3,80}?)` + stop, "i").exec(t)?.[1]
    ?? new RegExp(String.raw`\bfor\s+([^,.;]{3,80}?)` + stop, "i").exec(t)?.[1];
  const age = /\baged?\s*(\d{1,2})\s*(?:–|-|to)\s*(\d{1,2})\b/i.exec(t);
  const who = target && AUDIENCE_WORDS.test(target) ? target.trim() : AUDIENCE_WORDS.exec(t)?.[0] ?? null;
  if (!who && !age) return null;
  return [who, age && !(who ?? "").includes(age[1]) ? `aged ${age[1]}–${age[2]}` : null].filter(Boolean).join(", ");
}
const LANG_NAMES: Record<string, string> = { hi: "Hindi", ar: "Arabic", fr: "French", de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", ja: "Japanese", zh: "Chinese", ko: "Korean", ru: "Russian", ur: "Urdu", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", nl: "Dutch", tr: "Turkish", id: "Indonesian", vi: "Vietnamese", th: "Thai", pl: "Polish", sv: "Swedish" };
const langName = (code: string) => LANG_NAMES[code.toLowerCase().split(/[-_]/)[0]] ?? code.charAt(0).toUpperCase() + code.slice(1);

const ANALYSIS = /\b(?:run|apply|execute|re-?run|do)\b[^.]{0,40}\banaly[sz](?:is|es|e)\b|\banaly[sz]e\s+(?:the\s+)?(?:data|results|responses|survey)\b|\banalysis plan\b|\bcross-?tabs?\b|\bsignifican(?:ce|t) test/i;
const REPORT = /\b(?:report|deck|presentation|slides?|storyline|story|findings (?:report|deck|presentation)|executive summary)\b/i;
const DECIDE = /\b(?:recommend(?:ation)?s?|next steps?|should we|decide|decision|go\s*\/?\s*no[- ]go|what (?:should|do) we do)\b/i;
const REWORK = /\b(?:shorten|reword|rephrase|rewrite|improve|simplify|neutral|tighten|fix|clean up|restyle|polish|make (?:it|them|the questions?) )\b/i;
const BUILD = /\b(?:create|build|generate|make|design|write|draft|prepare|program|need|want)\b[^.]{0,60}\b(?:survey|questionnaire|study|screener|tracker|u&a|usage and attitude)\b|\b(?:survey|questionnaire)\s+(?:for|on|about)\b/i;

export function understand(input: { text: string; english?: string; language?: string; survey: SurveyDefinition }): Understanding {
  const original = input.text.trim();
  const t = (input.english ?? original).trim();
  const def = input.survey;
  const nQ = def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data"].includes(q.type)).length;
  const u: Understanding = { launcher: null, fields: {}, understood: [], assumptions: [], questions: [], confidence: "low", alternatives: [] };
  if (input.language && input.language !== "en") u.understood.push(`You wrote in ${langName(input.language)}; read as: “${t.slice(0, 160)}”`);
  if (!t) { u.questions.push({ key: "what", question: "What would you like the agents to do?" }); return u; }
  const g = readGenerationRequest(t, def);

  /* 1. translation */
  const tr = g.translation || /\btranslat|locali[sz]e/i.test(t) ? parseTranslationRequest(t, def) : null;
  if (tr || g.translation) {
    u.launcher = "translate"; u.confidence = tr ? "high" : "medium";
    if (tr) {
      const names = tr.languages.map(langName);
      u.fields.language = names.join(" and ");
      u.fields.scope = tr.scopeLabel;
      u.understood.push(`Translate ${tr.scopeLabel} into ${names.join(" and ")}`);
    } else u.questions.push({ key: "language", question: "Into which language?", suggestions: ["Hindi", "French", "Arabic", "Spanish"] });
    if (!nQ) u.questions.push({ key: "nothing", question: "This survey has no questions to translate yet — write or import the questionnaire first." });
    return u;
  }

  /* 2. an exam with an answer key */
  if (g.assessment && !ANALYSIS.test(t)) {
    u.launcher = "exam"; u.confidence = g.count ? "high" : "medium";
    u.fields.topic = t; if (g.count) u.fields.count = String(g.count);
    u.understood.push(`A scored exam${g.count ? ` of ${g.count} questions` : ""} with an answer key`);
    if (!g.count) u.questions.push({ key: "count", question: "How many questions should the exam have? (20 or more runs as an agent task)", suggestions: ["20", "30", "50"] });

    return u;
  }

  /* 3–5. the research agents */
  const isBuild = g.kind === "generate" || g.kind === "methods" || BUILD.test(t);
  if (ANALYSIS.test(t) && !isBuild) {
    u.launcher = "analyse"; u.confidence = "high";
    u.fields.dataset = /\btest (?:data|responses)\b/i.test(t) ? "TEST" : /\ball (?:data|responses)\b/i.test(t) ? "ALL" : "LIVE";
    u.fields.clean = /\bclean(?:ed)?\b/i.test(t) ? "clean" : "all";
    u.understood.push(`Run every planned analysis on the ${u.fields.dataset === "TEST" ? "test" : u.fields.dataset === "ALL" ? "full" : "production"} responses${u.fields.clean === "clean" ? " (clean dataset)" : ""}, then verify findings and verdicts`);
    if (!def.research?.analysisPlan) u.assumptions.push("No analysis plan is written, so the framework derived from the questionnaire will run.");
    if (REPORT.test(t)) u.alternatives.push("report");
    return u;
  }
  if (REPORT.test(t) && !isBuild) {
    u.launcher = "report"; u.confidence = "high";
    u.fields.audience = /\b(?:exec(?:utive)?s?|board|leadership|c-?suite|management)\b/i.test(t) ? "executive" : /\bresearch(?:er|ers| team)\b/i.test(t) ? "researcher" : "client";
    const focus = /\b(?:lead(?:ing)? with|focus(?:ing)? on|highlight(?:ing)?|emphasi[sz]e)\s+([^.;]{3,120})/i.exec(t)?.[1]?.trim();
    if (focus) u.fields.focus = focus;
    u.understood.push(`A findings storyline for ${u.fields.audience === "executive" ? "an" : "a"} ${u.fields.audience} audience${focus ? `, leading with ${focus}` : ""}, from the latest verified run`);
    if (DECIDE.test(t)) u.alternatives.push("decide");
    return u;
  }
  if (DECIDE.test(t) && !isBuild) {
    u.launcher = "decide"; u.confidence = "high";
    const q = /\b(should we [^?.]{3,200})\??/i.exec(t)?.[1];
    if (q) u.fields.question = `${q.charAt(0).toUpperCase()}${q.slice(1)}?`;
    u.understood.push(`Recommended actions from the verdicts and the findings that hold${q ? ` for: ${u.fields.question}` : ""}`);
    return u;
  }

  /* 6. rework what exists */
  if ((g.kind === "bulk_edit" || (REWORK.test(t) && !isBuild)) && nQ) {
    u.launcher = "edit"; u.confidence = g.kind === "bulk_edit" ? "high" : "medium";
    u.fields.goal = t;
    u.understood.push(`Rework ${g.targets.length ? `${g.targets.length} question${g.targets.length === 1 ? "" : "s"} (${g.targets[0]}${g.targets.length > 1 ? `–${g.targets[g.targets.length - 1]}` : ""})` : "the questions you named"}: ${t.slice(0, 120)}`);
    return u;
  }

  /* 7. a new questionnaire */
  if (isBuild) {
    u.launcher = "build";
    u.fields.brief = t;
    const loi = loiOf(t);
    let count = g.count;
    if (!count && loi) { count = Math.max(10, Math.min(120, Math.round(loi * QPM))); u.assumptions.push(`About ${count} questions for a ${loi}-minute interview (roughly ${QPM} closed questions a minute) — change the number if your questions are longer or shorter.`); }
    if (count) u.fields.count = String(count);
    u.confidence = count ? "high" : "medium";
    const objective = /\b(?:about|on|for|regarding)\s+(?:an?\s+|the\s+)?([^,.;]{4,100}?)(?=\s*(?:,|\.|;|\btarget|\bamong|\bwith\b|$))/i.exec(t)?.[1];
    if (objective) u.understood.push(`Study: ${objective.trim()}`);
    const aud = audienceOf(t);
    if (aud) u.understood.push(`Audience: ${aud}`);
    if (loi) u.understood.push(`Length of interview: ${loi} minutes`);
    if (/\bscreen(?:er|ing)\b/i.test(t)) u.understood.push("Screening questions to qualify the audience");
    const h = g.hints;
    const extras = [h.logic && "skip logic", h.grids && "grids", h.quotas && "quotas", h.randomization && "randomisation", h.piping && "piping"].filter(Boolean);
    if (extras.length) u.understood.push(`Programming: ${extras.join(", ")}`);
    if (g.method) u.understood.push(`Method: ${g.method === "maxdiff" ? "MaxDiff" : g.method.toUpperCase()} design`);
    if (g.language) u.understood.push(`Questions written in ${langName(g.language)}`);
    else if (input.language && input.language !== "en") u.assumptions.push(`You spoke ${langName(input.language)}; the questionnaire will be written in English unless you add “in ${langName(input.language)}”.`);
    if (!count) u.questions.push({ key: "count", question: "How many questions — or how long should the interview take?", suggestions: ["20", "30", "40", "10-minute LOI"] });
    if (!aud) u.assumptions.push("No audience was named — the screener will be generic. Say who it is for to tailor it.");
    return u;
  }

  /* nothing recognisable: say so and offer the agents */
  u.questions.push({ key: "what", question: "I could not tell which job this is. Which of these do you want?" });
  u.alternatives = ["build", "edit", "translate", "analyse", "report", "decide"];
  return u;
}

