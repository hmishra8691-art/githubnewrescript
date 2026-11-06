import type { FieldworkPlanRecord, SurveyDefinition } from "@rescript/schema";
import { FieldworkPlanRecord as FieldworkPlanSchema } from "@rescript/schema";
import type { ResearchBrief } from "./researchBrief.js";
import { effectiveLimit } from "./quotas.js";
/* the same rate as relevance.ts QUESTIONS_PER_MINUTE (imported there would close an import cycle through the action layer) */
const QUESTIONS_PER_MINUTE = 4;

/**
 * THE FIELDWORK PLAN FROM A BRIEF (Intelligent Mode IM5, 2026-11-06).
 *
 * From what the brief and the survey say — the completes, the markets, the time available, the length, the
 * incidence and the price when given — the plan a field manager would write: when it starts and closes, the soft
 * launch, the completes needed per day (overall, per market, per quota cell), the invitations the incidence implies,
 * the cost when a price or a budget is known, the milestones, and the risks, each with its *because* and what to do
 * about it. Every number says where it came from (`basis`): the brief, the survey, or an assumption that is named.
 *
 * What it does not do: price from the vendors' rate cards. That is the recruitment planner's job (Recruitment →
 * Plan), which has the rate cards and the margin; without a CPI or a budget the cost here is "not priced", never a
 * guess.
 */
export interface FieldworkInput {
  brief?: ResearchBrief | null;
  completes?: number;
  timelineDays?: number;
  loiMinutes?: number;
  incidence?: number;
  /** % of invited who complete, for the invitation count (default: not applied) */
  responseRate?: number;
  cpi?: number;
  budget?: number;
  currency?: string;
  /** "per market": the brief's "1,000 completes each" */
  perMarket?: boolean;
  markets?: string[];
  now?: number;
}
export interface FieldworkPlan extends FieldworkPlanRecord {
  cellPacing: { quota: string; cell: string; limit: number; perDay: number }[];
  lines: string[];
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmt = (n: number) => Math.round(n).toLocaleString("en");

export function fieldworkPlan(def: SurveyDefinition, input: FieldworkInput = {}): FieldworkPlan | { error: string } {
  const b = input.brief ?? null;
  const basis: Record<string, string> = {};
  const marketsIn = input.markets ?? b?.countries ?? [];
  const marketCount = Math.max(marketsIn.length, b?.marketCount ?? 0, 1);
  const perMarket = input.perMarket ?? (marketCount > 1 && /country|market|\beach$/i.test(b?.sampleBasis ?? ""));
  const base = input.completes ?? b?.sampleSize ?? def.research?.sampleSize;
  if (!base) return { error: "The plan needs the number of completes — say it (“1,000 completes”) or set the study's sample size." };
  const completes = perMarket ? base * marketCount : base;
  basis.completes = input.completes ? "the request" : b?.sampleSize ? `the brief${perMarket ? ` (${fmt(base)} in each of ${marketCount} markets)` : ""}` : "the research design's sample size";

  const fieldDays = Math.max(3, input.timelineDays ?? b?.timelineDays ?? 14);
  basis.fieldDays = input.timelineDays || b?.timelineDays ? "the brief" : "assumed: two weeks of fieldwork (no timeline was given)";
  const questions = def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data"].includes(q.type)).length;
  const loi = input.loiMinutes ?? b?.loiMinutes ?? (questions ? Math.max(1, Math.round(questions / QUESTIONS_PER_MINUTE)) : undefined);
  if (loi) basis.loiMinutes = input.loiMinutes || b?.loiMinutes ? "the brief" : `the survey: ${questions} questions at about ${QUESTIONS_PER_MINUTE} a minute`;
  const now = input.now ?? Date.now();
  /* two working days to set up: the production-like test, the soft-launch links */
  const start = now + 2 * DAY;
  const end = start + (fieldDays - 1) * DAY;
  const softLaunch = Math.min(completes, Math.max(20, Math.round(completes * 0.1)));
  const dailyTarget = Math.ceil((completes - softLaunch) / Math.max(1, fieldDays - 2));
  basis.softLaunch = "10 % of the completes (at least 20) on day one, checked before the full launch";

  const incidence = input.incidence;
  const rr = input.responseRate;
  const invitations = incidence ? Math.ceil(completes / (incidence / 100) / ((rr ?? 100) / 100)) : undefined;
  if (incidence) basis.invitations = `${fmt(completes)} ÷ ${incidence} % incidence${rr ? ` ÷ ${rr} % response` : ""}`;
  const cost = input.cpi !== undefined ? completes * input.cpi : undefined;
  if (cost !== undefined) basis.cost = `${fmt(completes)} × ${input.cpi} ${input.currency ?? ""}`.trim();

  const markets = marketsIn.length ? marketsIn.map((m, i) => ({ market: m, completes: perMarket ? base : Math.floor(completes / marketsIn.length) + (i < completes % marketsIn.length ? 1 : 0) })) : [];

  const cellPacing = def.quotas.flatMap((q) => q.cells.map((c) => {
    const limit = effectiveLimit(q, c.limit, c.limitType);
    return { quota: q.name, cell: c.label, limit, perDay: Math.round((limit / fieldDays) * 10) / 10 };
  }));

  const milestones = [
    { date: iso(now), what: "Plan agreed; run the production-like test against the live gates and quotas" },
    { date: iso(start), what: `Soft launch: ${fmt(softLaunch)} completes, then check the data (lengths, drop-off, quality flags, quota fill)` },
    { date: iso(start + DAY), what: `Full launch: about ${fmt(dailyTarget)} completes a day` },
    { date: iso(start + Math.floor(fieldDays / 2) * DAY), what: `Mid-field review: ${fmt(Math.round(completes / 2))} completes expected; slow cells re-targeted` },
    { date: iso(end), what: "Fieldwork closes (the live link's closing date)" },
    { date: iso(end + 2 * DAY), what: "Data cleaned and quality decisions made; analysis starts" },
  ];

  /* the risks, from properties of the study */
  const risks: FieldworkPlanRecord["risks"] = [];
  if (b?.professional && completes / fieldDays > 40) risks.push({ risk: "Pace for a professional audience", because: `${fmt(completes / fieldDays)} completes a day from ${b.population ?? "professionals"} is fast — professional panels are small and slow to respond.`, mitigation: "Add a second panel source, lengthen the field period, or set a higher incentive from day one." });
  if (incidence !== undefined && incidence < 15) risks.push({ risk: "Low incidence", because: `at ${incidence} % incidence about ${fmt(invitations!)} people must be invited for ${fmt(completes)} completes — cost and time rise with every screen-out.`, mitigation: "Pre-target the panel on the screening criteria; ask the vendor for a feasibility at this incidence before launch." });
  if (loi && loi > 20) risks.push({ risk: "Length", because: `about ${loi} minutes is long; drop-out rises after 15–20 minutes, more on mobile.`, mitigation: "Cut what no hypothesis or analysis uses (“make it shorter”), keep the progress bar, allow resume." });
  const small = cellPacing.filter((c) => c.limit > 0 && c.limit < 30);
  if (small.length) risks.push({ risk: "Small quota cells", because: `${small.length} cell${small.length === 1 ? "" : "s"} under 30 completes (${small.slice(0, 3).map((c) => c.cell).join(", ")}${small.length > 3 ? ", …" : ""}) — too few to report or test on their own.`, mitigation: "Merge adjacent bands, or raise the total so each reported group has at least 30–50." });
  if (marketCount > 1 && (b?.languages.length ?? 0) > 1) risks.push({ risk: "Translations on the critical path", because: `${marketCount} markets in ${b!.languages.length} languages: each version must be translated and checked before its market launches.`, mitigation: "Translate after the source is final; launch markets as their versions pass the completeness check." });
  if (fieldDays <= 7 && completes >= 1000) risks.push({ risk: "Short field period", because: `${fmt(completes)} completes in ${fieldDays} days leaves no room to recover a slow day.`, mitigation: "Plan for 20 % above the daily target in the first days; agree an extension trigger with the client." });
  if (cost !== undefined && input.budget !== undefined && cost > input.budget) risks.push({ risk: "Over budget", because: `${fmt(cost)} at ${input.cpi} a complete exceeds the budget of ${fmt(input.budget)}.`, mitigation: "Lower the completes, negotiate the CPI, or shorten the survey (price falls with length)." });
  if (!def.quotas.length && (b?.quotas.length ?? 0) > 0) risks.push({ risk: "Quotas not set up", because: `the brief asks for ${b!.quotas.join(", ")} quotas and the survey has none — the sample will fall as the panel delivers it.`, mitigation: `Say “${fmt(completes)} completes split … by ${b!.quotas[0]}” to create them before launch.` });

  const lines: string[] = [];
  lines.push(`${fmt(completes)} completes${markets.length > 1 ? ` across ${markets.length} markets (${markets.map((m) => `${m.market} ${fmt(m.completes)}`).join(", ")})` : markets.length === 1 ? ` in ${markets[0].market}` : ""}, ${fieldDays} field days: ${iso(start)} → ${iso(end)}.`);
  lines.push(`Soft launch ${fmt(softLaunch)} on day one, then about ${fmt(dailyTarget)} completes a day.${loi ? ` Length about ${loi} minutes (${basis.loiMinutes}).` : ""}`);
  if (invitations) lines.push(`Invitations: about ${fmt(invitations)} (${basis.invitations}).`); else lines.push("Invitations: give the incidence (“30 % incidence”) to size them.");
  lines.push(cost !== undefined ? `Cost: ${fmt(cost)} ${input.currency ?? ""} (${basis.cost}).`.replace(/\s+\(/, " (") : input.budget !== undefined ? `Budget ${fmt(input.budget)} ${input.currency ?? ""}: at most ${(input.budget / completes).toFixed(2)} a complete.` : "Cost: not priced — Recruitment → Plan prices it from the vendors' rate cards with the margin, or give a CPI here.");
  if (cellPacing.length) lines.push(`Quota pacing: ${cellPacing.slice(0, 8).map((c) => `${c.cell} ${c.perDay}/day`).join(", ")}${cellPacing.length > 8 ? `, and ${cellPacing.length - 8} more` : ""}.`);
  for (const r of risks) lines.push(`Risk — ${r.risk}: ${r.because} ${r.mitigation}`);
  const assumed = Object.values(basis).filter((x) => x.startsWith("assumed"));
  if (assumed.length) lines.push(`Assumed: ${assumed.map((x) => x.replace(/^assumed:\s*/, "")).join("; ")}.`);

  return {
    completes, startDate: iso(start), endDate: iso(end), fieldDays, softLaunch, dailyTarget,
    ...(loi ? { loiMinutes: loi } : {}), ...(incidence !== undefined ? { incidence } : {}), ...(invitations ? { invitations } : {}),
    ...(input.cpi !== undefined ? { cpi: input.cpi } : {}), ...(input.budget !== undefined ? { budget: input.budget } : {}), ...(input.currency ? { currency: input.currency } : {}), ...(cost !== undefined ? { cost } : {}),
    markets, milestones, risks, basis, plannedAt: new Date(now).toISOString(), cellPacing, lines,
  };
}

/* ------------------------------------------------------------ set_fieldwork_plan: the plan of record */
export type FieldworkAction = { op: "set_fieldwork_plan"; plan: FieldworkPlanRecord | null };
export const FIELDWORK_ACTION_OPS = ["set_fieldwork_plan"] as const;
export function coerceFieldworkAction(o: Record<string, unknown>): FieldworkAction | string {
  if (o.plan === null) return { op: "set_fieldwork_plan", plan: null };
  const p = FieldworkPlanSchema.safeParse(o.plan);
  if (!p.success) return `set_fieldwork_plan: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  return { op: "set_fieldwork_plan", plan: p.data };
}
export function applyFieldworkAction(def: SurveyDefinition, a: FieldworkAction): { description: string; warnings: string[]; touched: string[] } {
  const research = def.research ?? ({ hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] } as unknown as NonNullable<SurveyDefinition["research"]>);
  if (a.plan === null) { delete research.fieldwork; def.research = research; return { description: "Fieldwork plan removed", warnings: [], touched: [] }; }
  research.fieldwork = a.plan;
  if (!research.sampleSize) research.sampleSize = a.plan.completes;
  def.research = research;
  const warnings = research.sampleSize !== a.plan.completes ? [`the research design's sample size is ${research.sampleSize}; the fieldwork plan fields ${a.plan.completes}`] : [];
  return { description: `Fieldwork plan: ${a.plan.completes} completes, ${a.plan.startDate} → ${a.plan.endDate}`, warnings, touched: [] };
}
export const describeFieldworkAction = (a: FieldworkAction) => a.plan ? `Set the fieldwork plan (${a.plan.completes} completes, ${a.plan.startDate} → ${a.plan.endDate})` : "Remove the fieldwork plan";
