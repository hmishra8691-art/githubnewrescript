import type { AgentId } from "./workspace.ts";

/**
 * HOW EACH AGENT IS STARTED FROM THE WORKSPACE (ResLens agents, 2026-11-07).
 *
 * A launcher is a small form over one REGISTERED planner. The form's fields become one plain sentence — the same kind
 * of sentence a researcher would type to the Copilot — and the request names the planner, so the workspace and the
 * Copilot start exactly the same work. The sentence is shown before it is sent: what the agent is asked is never hidden.
 */
export interface LaunchField { key: string; label: string; type?: "text" | "textarea" | "select"; placeholder?: string; required?: boolean; options?: [string, string][] }
export interface Launcher {
  id: "build" | "edit" | "translate" | "exam" | "analyse" | "report" | "decide";
  agent: AgentId;
  planner: string;
  title: string;
  blurb: string;
  fields: LaunchField[];
  message: (f: Record<string, string>) => string;
  /** structured options sent beside the sentence (read by planners that take them) */
  options?: (f: Record<string, string>) => Record<string, unknown>;
}

const t = (s: string | undefined) => (s ?? "").trim();
const DATASETS: [string, string][] = [["LIVE", "Production responses"], ["TEST", "Test responses"], ["ALL", "All responses"]];

export const LAUNCHERS: Launcher[] = [
  { id: "build", agent: "writer", planner: "generation", title: "Write a questionnaire", blurb: "From a brief: design, blocks, questions, logic, quotas, then a final check",
    fields: [
      { key: "brief", label: "What is the study about?", type: "textarea", required: true, placeholder: "Customer satisfaction with our mobile banking app: screener, usage, satisfaction grid, NPS, demographics" },
      { key: "count", label: "How many questions?", placeholder: "40" },
    ],
    message: (f) => `Write a ${t(f.count) ? `${t(f.count)} question ` : ""}survey: ${t(f.brief)}` },
  { id: "edit", agent: "writer", planner: "copilot.generic", title: "Rework questions", blurb: "Improve, shorten or restyle questions you already have, in batches",
    fields: [{ key: "goal", label: "What should change?", type: "textarea", required: true, placeholder: "Make every question in the Usage block shorter and neutral; add a Don't know option to the grids" }],
    message: (f) => t(f.goal) },
  { id: "translate", agent: "translation", planner: "translation", title: "Translate", blurb: "Into a target language, batch by batch, with a completeness check",
    fields: [
      { key: "language", label: "Language", required: true, placeholder: "French, Hindi, Arabic…" },
      { key: "scope", label: "What to translate", placeholder: "the whole survey (or: Q1–Q20, block Brand)" },
    ],
    message: (f) => `Translate ${t(f.scope) || "the whole survey"} into ${t(f.language)}` },
  { id: "exam", agent: "assessment", planner: "assessment", title: "Build a scored exam", blurb: "Questions with an answer key and a scoring rule, every key checked",
    fields: [
      { key: "topic", label: "Topic", required: true, placeholder: "Data privacy rules for customer-service staff" },
      { key: "count", label: "Number of questions", required: true, placeholder: "25" },
    ],
    message: (f) => `Create a ${t(f.count)} question exam with an answer key on ${t(f.topic)}` },
  { id: "analyse", agent: "analysis", planner: "analysis", title: "Run the analysis plan", blurb: "Check the plan, run every planned analysis on the data, verify the findings and verdicts",
    fields: [{ key: "dataset", label: "Data", type: "select", options: DATASETS }, { key: "clean", label: "Responses", type: "select", options: [["all", "All completes"], ["clean", "Clean dataset (quality removals applied)"]] }],
    message: (f) => `Run the analysis plan on the ${(DATASETS.find(([v]) => v === (f.dataset || "LIVE"))?.[1] ?? "production responses").toLowerCase()}${f.clean === "clean" ? " (clean dataset)" : ""}`,
    options: (f) => ({ environment: f.dataset || "LIVE", dataset: f.clean === "clean" ? "clean" : "all" }) },
];

export function launchMessage(l: Launcher, fields: Record<string, string>): string {
  if (l.fields.some((f) => f.required && !t(fields[f.key]))) return "";
  return l.message(fields).replace(/\s+/g, " ").trim().slice(0, 4000);
}
