import type { SurveyDefinition } from "@rescript/schema";
import { fieldEstimate, interviewLength, precisionOf, sampleForDifference, sampleForMargin, type Calc } from "./designCalc.js";

/**
 * A DESIGN QUESTION, ANSWERED BY ARITHMETIC (Level 5 roadmap A7 — 2026-11-23).
 *
 * "How many completes for ±3%?", "what can 400 completes detect?", "how long is this survey?", "how many
 * invitations at 25% incidence?" are questions with one right answer and a formula behind it. They are read here
 * and worked out by the design calculators: no model is called, and the answer carries its working and every
 * assumption it had to make. A sentence that is not plainly one of these is left alone (null).
 */
export type DesignTool = "design.sample_size_margin" | "design.sample_size_difference" | "design.precision" | "design.interview_length" | "design.field_estimate";
export interface DesignReading { tool: DesignTool; input: Record<string, unknown>; understood: string }
export interface DesignAnswer extends DesignReading { ok: boolean; answer: string; working: string[]; assumptions: string[] }

const N = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k\b)?`;
const toNum = (digits: string, k?: string): number => Number(digits.replace(/,/g, "")) * (k ? 1000 : 1);
const pct = (t: string, re: RegExp): number | null => { const m = re.exec(t); return m ? Number(m[1]) : null; };
/** a change to the questionnaire, a data question or a brief is somebody else's */
const NOT_A_QUESTION = /^(?:add|insert|create|make|set|change|delete|remove|rename|move|show|hide|plan|build|write|draft|generate)\b/i;
const ASKS = /^(?:how|what|which|is|are|do|does|can|could|will|would|should|tell me|work out|calculate|estimate)\b|\?$/i;
const SAMPLE_NOUN = /\b(?:completes?|sample size|sample|respondents?|interviews?|people|base)\b/i;

export function interpretDesignRequest(raw: string): DesignReading | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 300 || NOT_A_QUESTION.test(text) || !ASKS.test(text)) return null;
  const t = text.toLowerCase().replace(/per ?cent|percentage points?|points?\b|pts?\b/g, "%").replace(/\s+%/g, "%");
  const confidence = pct(t, /(\d{2}(?:\.\d+)?)%\s*(?:confidence|ci\b|level of confidence)/) ?? pct(t, /confidence(?: level)?(?: of| is| at)?\s*(\d{2}(?:\.\d+)?)%/);
  const power = pct(t, /(\d{2})%\s*power/) ?? pct(t, /power(?: of| is| at)?\s*(\d{2})%/);
  const population = (() => { const m = new RegExp(String.raw`(?:population|universe|customer base|out) of\s*${N}`).exec(t); return m ? toNum(m[1]!, m[2]) : null; })();
  const extras = { ...(confidence ? { confidence } : {}), ...(population ? { population } : {}) };

  /* ---- how long is the survey */
  if (/\bhow (?:long|many minutes)\b.*\b(?:survey|questionnaire|interview|it)\b|\b(?:interview length|length of (?:the )?(?:interview|survey|questionnaire)|loi)\b/.test(t) && !/\b(?:field|fieldwork|take to (?:field|complete the fieldwork)|days?|weeks?)\b/.test(t))
    return { tool: "design.interview_length", input: {}, understood: "Estimate the interview length from the questionnaire." };

  /* ---- invitations, starts and cost from rates */
  const completesGiven = (() => { const m = new RegExp(String.raw`${N}\s*(?:completes?|completed interviews?|interviews?|respondents?)`).exec(t) ?? new RegExp(String.raw`(?:sample|n)\s*(?:of|=|is)?\s*${N}`).exec(t); return m ? toNum(m[1]!, m[2]) : null; })();
  const incidence = pct(t, /(\d+(?:\.\d+)?)%\s*(?:incidence|ir\b|qualif)/) ?? pct(t, /incidence(?: rate)?(?: of| is| at)?\s*(\d+(?:\.\d+)?)%/);
  const response = pct(t, /(\d+(?:\.\d+)?)%\s*response/) ?? pct(t, /response rate(?: of| is| at)?\s*(\d+(?:\.\d+)?)%/);
  const completion = pct(t, /(\d+(?:\.\d+)?)%\s*completion/) ?? pct(t, /completion rate(?: of| is| at)?\s*(\d+(?:\.\d+)?)%/);
  const price = (() => { const m = /(?:([$€£₹])\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(usd|eur|gbp|inr|dollars?|euros?|pounds?|rupees?))\s*(?:per|a|each|\/)\s*(?:complete|interview|respondent)|(?:cpi|cost per (?:complete|interview)|price per complete)(?: of| is| at)?\s*([$€£₹])?\s*(\d+(?:\.\d+)?)/.exec(t); if (!m) return null; return { amount: Number(m[2] ?? m[3] ?? m[6]), currency: (m[1] ?? m[4] ?? m[5] ?? "").toUpperCase() }; })();
  if (completesGiven && (/\b(?:invitations?|invites?|starts?|contacts?|sample (?:do i|to) (?:buy|order)|send out)\b/.test(t) || (price && /\b(?:cost|budget|how much)\b/.test(t))) && (incidence || response || price))
    return { tool: "design.field_estimate", input: { completes: completesGiven, ...(incidence ? { incidence } : {}), ...(response ? { responseRate: response } : {}), ...(completion ? { completionRate: completion } : {}), ...(price ? { pricePerComplete: price.amount, ...(price.currency ? { currency: price.currency } : {}) } : {}) }, understood: "Work out the starts, invitations and cost for the completes." };

  /* ---- how many, to tell two shares apart */
  const two = /(\d+(?:\.\d+)?)%\s*(?:vs\.?|versus|and|against|from|to|compared (?:with|to))\s*(\d+(?:\.\d+)?)%/.exec(t);
  const wantsN = /\bhow (?:many|big|large)\b|\bwhat (?:sample|base|n)\b|\bsample size\b/.test(t) && SAMPLE_NOUN.test(t);
  if (wantsN && two && /\b(?:detect|tell apart|difference|significan|distinguish|compare|show)\b/.test(t))
    return { tool: "design.sample_size_difference", input: { share1: Number(two[1]), share2: Number(two[2]), ...(power ? { power } : {}) }, understood: `Work out the sample to tell ${two[1]}% from ${two[2]}%.` };

  /* ---- how many, for a margin of error */
  const margin = pct(t, /(?:±|\+\/?-|plus or minus|within|margin(?: of error)?(?: of| is| at)?|accurate to|precision(?: of)?)\s*(\d+(?:\.\d+)?)%/) ?? pct(t, /(\d+(?:\.\d+)?)%\s*(?:margin|moe\b|precision|accuracy)/);
  if (wantsN && margin != null) return { tool: "design.sample_size_margin", input: { margin, ...extras }, understood: `Work out the sample for a margin of error of ±${margin} points.` };

  /* ---- what a sample gives */
  if (completesGiven && /\bmargin(?: of error)?\b|\bhow (?:precise|accurate)\b|\bprecision\b|\b(?:difference|gap).*\bdetect|\bdetect\b/.test(t) && margin == null) {
    const groups = (() => { const m = /(\d+|two|three|four|five)\s*(?:equal )?(?:groups|segments|cells|subgroups|markets|arms)/.exec(t); return m ? ({ two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[m[1]!] ?? Number(m[1]) : /\bdetect\b|\bdifference\b/.test(t) ? 2 : null; })();
    return { tool: "design.precision", input: { completes: completesGiven, ...extras, ...(groups ? { groups } : {}), ...(power ? { power } : {}) }, understood: `Work out what ${completesGiven.toLocaleString("en")} completes can show.` };
  }
  return null;
}

const n = (x: number) => x.toLocaleString("en");

/** read the sentence and work it out; null when it is not a design question */
export function answerDesignRequest(def: SurveyDefinition, raw: string): DesignAnswer | null {
  const r = interpretDesignRequest(raw);
  if (!r) return null;
  const out = (c: Calc<unknown>, say: (v: never) => string): DesignAnswer => (c.ok ? { ...r, ok: true, answer: say(c.value as never), working: c.working, assumptions: c.assumptions } : { ...r, ok: false, answer: c.reason, working: [], assumptions: [] });
  switch (r.tool) {
    case "design.sample_size_margin": return out(sampleForMargin(r.input), (v: { completes: number }) => `You need ${n(v.completes)} completes for a margin of error of ±${r.input.margin} points.`);
    case "design.sample_size_difference": return out(sampleForDifference(r.input), (v: { completes: number; perGroup: number; groups: number }) => `You need ${n(v.perGroup)} completes in each group (${n(v.completes)} in all) to tell ${r.input.share1}% from ${r.input.share2}%.`);
    case "design.precision": return out(precisionOf(r.input), (v: { marginPoints: number; detectablePoints?: number }) => `${n(Number(r.input.completes))} completes give a margin of error of ±${v.marginPoints} points${v.detectablePoints != null ? `, and can detect a difference of ${v.detectablePoints} points between ${r.input.groups} equal groups` : ""}.`);
    case "design.interview_length": return out(interviewLength(def), (v: { typicalMinutes: number; longestMinutes: number; questions: number }) => `About ${v.typicalMinutes} minutes for a typical respondent${v.longestMinutes > v.typicalMinutes ? `, up to about ${v.longestMinutes} for one who sees everything` : ""} (${v.questions} questions). This is a planning estimate, not a measured time.`);
    case "design.field_estimate": return out(fieldEstimate(r.input), (v: { completes: number; starts?: number; invitations?: number; cost?: number; currency?: string; missing: string[] }) => [v.starts != null ? `${n(v.completes)} completes need about ${n(v.starts)} starts${v.invitations != null ? ` and ${n(v.invitations)} invitations` : ""}.` : "", v.cost != null ? `Cost: ${n(v.cost)}${v.currency ? ` ${v.currency}` : ""}.` : "", v.missing.length ? `Not worked out: ${v.missing.join("; ")}.` : ""].filter(Boolean).join(" "));
  }
}
