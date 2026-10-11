import type { SurveyDefinition } from "@rescript/schema";
import { runQualityCheck } from "@rescript/engine";

/**
 * THE PROJECT OVERVIEW (dashboard brief §2): the facts a researcher wants
 * before opening any tool — what the project is, how far each part of it is
 * set up, what it has spent, what happened last. Every state here is READ
 * FROM SAVED DATA: the definition as it is (draft first), the deployments
 * table, the quota counters, the reports and runs, the project
 * configuration, the usage events. Nothing is inferred from the lifecycle
 * status alone and nothing is hard-coded.
 *
 * Pure where it can be: `moduleStates(def, facts)` reads the definition and a
 * bag of facts the route has fetched, so the states are unit-testable
 * without a database.
 */
export type ModuleKey = "programming" | "quotas" | "collection" | "quality" | "research" | "analysis" | "reporting" | "languages" | "fieldwork" | "project";
export type ModuleState = "configured" | "incomplete" | "not_configured" | "needs_attention";

export interface ModuleStatus {
  key: ModuleKey;
  label: string;
  state: ModuleState;
  /** one line: what is there, or what is missing */
  detail: string;
  /** the Studio tab that edits it */
  tab: string;
  /** a number worth showing beside the label (questions, quotas, languages…) */
  count?: number;
}

/** what the route fetches beside the definition — all optional, so a database missing a table still answers */
export interface OverviewFacts {
  deployments?: { mode: string; active: boolean; version_id?: string | null }[];
  /** quotaId → cellId → count, for LIVE */
  quotaCounts?: Record<string, Record<string, number>>;
  reports?: { kind: string }[];
  analyses?: number;
  latestRun?: { computedAt: string; n: number; trigger: string } | null;
  config?: { clientName?: string | null; projectManager?: string | null; fieldworkFrom?: string | null; fieldworkTo?: string | null; dueDate?: string | null } | null;
  sampleSources?: number;
  status?: string;
}

const n = (k: number, w: string, pl = `${w}s`) => `${k} ${k === 1 ? w : pl}`;

export function moduleStates(def: SurveyDefinition, facts: OverviewFacts = {}): ModuleStatus[] {
  const out: ModuleStatus[] = [];
  const asked = def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data"].includes(q.type));

  /* programming: the questionnaire and whether its logic holds */
  if (!asked.length) out.push({ key: "programming", label: "Questionnaire", state: "not_configured", detail: "No questions yet — program the questionnaire or import one.", tab: "questions", count: 0 });
  else {
    const q = runQualityCheck(def);
    const logic = def.questions.filter((x) => x.displayLogic || (x.skipLogic?.length ?? 0) > 0).length;
    const base = `${n(asked.length, "question")}${logic ? ` · ${n(logic, "question")} with logic` : ""}`;
    if (q.errors > 0) out.push({ key: "programming", label: "Questionnaire", state: "needs_attention", detail: `${base} · ${n(q.errors, "logic error")} to fix before deploying`, tab: "logic", count: asked.length });
    else out.push({ key: "programming", label: "Questionnaire", state: "configured", detail: `${base}${q.warnings ? ` · ${n(q.warnings, "warning")}` : ""}`, tab: "questions", count: asked.length });
  }

  /* quotas: defined, and how full */
  const quotas = def.quotas ?? [];
  if (!quotas.length) out.push({ key: "quotas", label: "Quotas", state: "not_configured", detail: "No quotas — every respondent counts.", tab: "quotas", count: 0 });
  else {
    const cells = quotas.reduce((a, q) => a + q.cells.length, 0);
    const checked = JSON.stringify(def.flow).includes("\"quota_check\"");
    let fill = "";
    if (facts.quotaCounts) {
      let have = 0, limit = 0;
      for (const q of quotas) for (const c of q.cells) { have += facts.quotaCounts[q.id]?.[c.id] ?? 0; if (typeof c.limit === "number") limit += c.limit; }
      fill = limit ? ` · ${have} of ${limit} live completes` : "";
    }
    out.push({ key: "quotas", label: "Quotas", state: checked ? "configured" : "incomplete", detail: `${n(quotas.length, "quota")}, ${n(cells, "cell")}${fill}${checked ? "" : " · no quota check in the flow yet"}`, tab: "quotas", count: quotas.length });
  }

  /* collection: the links that exist and whether a live survey actually has one */
  const deps = facts.deployments ?? [];
  const live = deps.find((d) => d.mode === "live" && d.active);
  const test = deps.find((d) => d.mode === "test" && d.active);
  if (live) out.push({ key: "collection", label: "Response collection", state: "configured", detail: `Live link active${test ? " · test link active" : ""}`, tab: "versions" });
  else if (facts.status === "live") out.push({ key: "collection", label: "Response collection", state: "needs_attention", detail: "The project is marked live but no live link is deployed.", tab: "versions" });
  else if (test) out.push({ key: "collection", label: "Response collection", state: "incomplete", detail: "Test link active · not deployed live", tab: "versions" });
  else out.push({ key: "collection", label: "Response collection", state: "not_configured", detail: "Not deployed — save a version and deploy a test or live link.", tab: "versions" });

  /* data quality */
  const quality = def.quality;
  if (quality?.enabled) out.push({ key: "quality", label: "Data quality", state: "configured", detail: `Quality engine on${quality.profile ? ` · profile “${quality.profile}”` : ""}`, tab: "data" });
  else out.push({ key: "quality", label: "Data quality", state: "not_configured", detail: "Quality checks off — responses are not scored.", tab: "data" });

  /* research design */
  const r = def.research;
  const hyps = r?.hypotheses.length ?? 0;
  if (r?.objective && hyps) out.push({ key: "research", label: "Research design", state: "configured", detail: `Objective recorded · ${n(hyps, "hypothesis", "hypotheses")}${r.constructs.length ? ` · ${n(r.constructs.length, "construct")}` : ""}${r.strict ? " · enforced" : ""}`, tab: "settings", count: hyps });
  else if (r?.objective || hyps || r?.brief) out.push({ key: "research", label: "Research design", state: "incomplete", detail: r?.objective ? "Objective recorded · no hypotheses yet" : r?.brief ? "Brief recorded · no objective yet" : `${n(hyps, "hypothesis", "hypotheses")} · no objective`, tab: "settings", count: hyps });
  else out.push({ key: "research", label: "Research design", state: "not_configured", detail: "No objective or hypotheses — the analysis cannot be planned.", tab: "settings", count: 0 });

  /* analysis plan and its runs */
  const plan = r?.analysisPlan;
  if (plan) {
    const run = facts.latestRun;
    out.push({ key: "analysis", label: "Analysis plan", state: "configured", detail: `${n(plan.crosstabs.length, "crosstab")}, ${n(plan.tests.length, "test")}${run ? ` · last run ${run.computedAt.slice(0, 10)} on ${run.n} completes` : " · not run yet"}`, tab: "questions", count: plan.crosstabs.length + plan.tests.length });
  } else out.push({ key: "analysis", label: "Analysis plan", state: "not_configured", detail: "No plan — ask Intelligent mode to plan the analysis.", tab: "questions", count: 0 });

  /* reporting: dashboards and reports, saved analyses */
  const reports = facts.reports ?? [];
  const dashboards = reports.filter((x) => x.kind === "dashboard").length;
  const docs = reports.filter((x) => x.kind === "report").length;
  if (reports.length) out.push({ key: "reporting", label: "Dashboards & reports", state: "configured", detail: `${n(dashboards, "dashboard")}, ${n(docs, "report")}${facts.analyses ? ` · ${n(facts.analyses, "saved analysis", "saved analyses")}` : ""}`, tab: "data", count: reports.length });
  else out.push({ key: "reporting", label: "Dashboards & reports", state: "not_configured", detail: facts.analyses ? `${n(facts.analyses, "saved analysis", "saved analyses")} · no dashboard or report yet` : "No dashboard or report yet.", tab: "data", count: 0 });

  /* languages */
  const langs = def.localization?.languages ?? [];
  if (langs.length) {
    const ready = langs.filter((l) => l.status === "ready" || l.status === "live").length;
    out.push({ key: "languages", label: "Languages", state: ready === langs.length ? "configured" : "incomplete", detail: `${n(langs.length, "language")} beside ${def.localization?.sourceLanguage ?? "the source"}${ready < langs.length ? ` · ${langs.length - ready} not ready` : ""}`, tab: "localization", count: langs.length });
  } else out.push({ key: "languages", label: "Languages", state: "not_configured", detail: "Source language only.", tab: "localization", count: 0 });

  /* fieldwork: dates and sample sources */
  const c = facts.config;
  const dates = c?.fieldworkFrom || c?.fieldworkTo;
  const sources = facts.sampleSources ?? 0;
  if (dates && (c?.fieldworkFrom && c?.fieldworkTo)) out.push({ key: "fieldwork", label: "Fieldwork", state: "configured", detail: `${c.fieldworkFrom} → ${c.fieldworkTo}${sources ? ` · ${n(sources, "sample source")}` : ""}`, tab: "fieldwork" });
  else if (dates || sources) out.push({ key: "fieldwork", label: "Fieldwork", state: "incomplete", detail: dates ? "Only one fieldwork date set" : `${n(sources, "sample source")} · no fieldwork dates`, tab: "fieldwork" });
  else out.push({ key: "fieldwork", label: "Fieldwork", state: "not_configured", detail: "No fieldwork dates or sample sources.", tab: "fieldwork" });

  /* project facts */
  if (c?.clientName && (c.projectManager || c.dueDate)) out.push({ key: "project", label: "Project details", state: "configured", detail: `${c.clientName}${c.projectManager ? ` · ${c.projectManager}` : ""}${c.dueDate ? ` · due ${c.dueDate}` : ""}`, tab: "project" });
  else if (c?.clientName || c?.projectManager || c?.dueDate) out.push({ key: "project", label: "Project details", state: "incomplete", detail: [c?.clientName, c?.projectManager, c?.dueDate ? `due ${c.dueDate}` : ""].filter(Boolean).join(" · "), tab: "project" });
  else out.push({ key: "project", label: "Project details", state: "not_configured", detail: "No client, manager or due date recorded.", tab: "project" });

  return out;
}

/** the headline: how many modules are set up, and what needs attention first */
export function overviewSummary(modules: ModuleStatus[]): { configured: number; total: number; attention: ModuleStatus[] } {
  return { configured: modules.filter((m) => m.state === "configured").length, total: modules.length, attention: modules.filter((m) => m.state === "needs_attention") };
}
