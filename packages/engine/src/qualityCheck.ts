import type { SurveyDefinition } from "@rescript/schema";
import { lintSurveyLogic, type LogicIssue } from "./lintLogic.js";
import { lintVariables } from "./variables.js";
import { validateFlowStructure } from "./flowTree.js";

/**
 * RUN QUALITY CHECK — one answer to "is this survey fit to field?".
 *
 * Every check below already existed. What did not exist was a place to ask
 * for all of them at once: the logic lint lived in one panel and ran as you
 * typed, the duplicate-variable list lived in another, the flow structure
 * check ran while dragging, and `deploy` performed none of them — so a survey
 * with a broken piping token, a question on no page and a quota that was full
 * before fielding could go live without anything objecting.
 *
 * The value is therefore not new detection. It is that a programmer can ask
 * one question before a release and get one verdict, area by area, in the
 * vocabulary they use: questions, logic, loops, flow, variables, quotas,
 * designs, deployment.
 */

export type QualityStatus = "pass" | "warn" | "fail";

export interface QualityArea {
  key: string;
  /** what a survey programmer calls this part of the job */
  label: string;
  status: QualityStatus;
  errors: number;
  warnings: number;
  issues: LogicIssue[];
  /** shown when there is nothing to report — says what was actually checked */
  note?: string;
}

export interface QualityCheckResult {
  status: QualityStatus;
  errors: number;
  warnings: number;
  areas: QualityArea[];
  /** true when nothing would stop this survey being deployed */
  deployable: boolean;
  checkedAt: string;
}

/** Which area an issue belongs to, from where it was found. */
function areaOf(issue: LogicIssue): string {
  const p = issue.path;
  if (p.startsWith("quotas")) return "quotas";
  if (p.startsWith("variables")) return "variables";
  if (p.startsWith("settings.designRef")) return "designs";
  if (p === "flow") return "structure";
  if (p === "dependencies") return "logic";
  if (p.startsWith("loop") || p.includes("loop")) return "loops";
  if (p.startsWith("options") || p.startsWith("rows") || p.startsWith("columns")) return "questions";
  if (p.includes("pip") || p.includes("text") || p.includes("customHtml")) return "piping";
  if (p.startsWith("listFill")) return "listfill";
  return "logic";
}

const AREA_LABELS: Record<string, string> = {
  questions: "Questions and options",
  logic: "Logic and conditions",
  piping: "Piping",
  loops: "Loops",
  structure: "Flow and structure",
  variables: "Variables",
  quotas: "Quotas",
  designs: "Design files",
  listfill: "List Fill",
  deployment: "Deployment readiness",
};

const AREA_NOTES: Record<string, string> = {
  questions: "Every question has something to answer, and no option is unlabelled.",
  logic: "Every condition names something that exists, with an operator its source supports, and nothing depends on itself.",
  piping: "Every token resolves to a question, calculation or embedded field that exists and is answered first.",
  loops: "Every loop has a source it can iterate, and every reference name it uses is declared.",
  structure: "Every question is on a page, and the flow nests legally.",
  variables: "No two things export the same variable name.",
  quotas: "Every quota can fill, and no cell is full before fielding starts.",
  designs: "Every conjoint or MaxDiff question points at a design this survey holds.",
  listfill: "Every List Fill has a source and somewhere to put what it allocates.",
  deployment: "The survey has an end, a deployment slug and at least one question.",
};

const ORDER = [
  "questions", "logic", "piping", "loops", "structure",
  "variables", "quotas", "designs", "listfill", "deployment",
];

/**
 * Checks that are about shipping rather than about correctness — the things
 * a programmer discovers at the worst possible moment, when the test link
 * opens on an empty survey or a respondent reaches the end and stops.
 */
function deploymentIssues(def: SurveyDefinition): LogicIssue[] {
  const out: LogicIssue[] = [];
  const push = (level: "error" | "warning", message: string) =>
    out.push({ level, path: "deployment", message });

  if ((def.questions ?? []).length === 0) push("error", "This survey has no questions.");
  if ((def.flow ?? []).length === 0) push("error", "This survey has no flow, so there is nothing to show a respondent.");

  const hasEnd = JSON.stringify(def.flow ?? []).includes('"type":"end"');
  if (!hasEnd) {
    push(
      "warning",
      "The flow has no End node. Respondents will finish on the survey's default completion message rather than one you chose.",
    );
  }
  const dep = def.deployment;
  if (!dep?.clientSlug || !dep?.studySlug) {
    push("error", "The deployment has no client or study slug, so no link can be built for it.");
  }
  return out;
}

export function runQualityCheck(def: SurveyDefinition): QualityCheckResult {
  const collected: LogicIssue[] = [];

  /* the logic lint, which now also carries the structural checks */
  try {
    collected.push(...lintSurveyLogic(def));
  } catch (e) {
    collected.push({
      level: "error", path: "logic",
      message: `The logic could not be analysed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  /* duplicate variable names, in the same shape as everything else */
  for (const problem of lintVariables(def)) {
    collected.push({ level: "error", path: "variables", message: problem });
  }

  /*
   * Flow containment, nesting and duplicate ids — with one refinement.
   *
   * `validateFlowStructure` walks the flow in order, so a node after an End
   * is unreachable by falling through and it says so. That is right for a
   * page, and wrong for the End nodes a survey keeps at the bottom on
   * purpose: a screen-out and a quota-full End are reached by JUMPING to
   * them, from a skip rule or a quota's onFull, never by walking. Reporting
   * those is how a panel earns being ignored, so a node something jumps to is
   * not reported as unreachable.
   */
  const jumpTargets = new Set<string>();
  /** the end STATUSES something can send a respondent to, by name */
  const jumpStatuses = new Set<string>();
  for (const q of def.questions ?? []) {
    for (const rule of q.skipLogic ?? []) {
      const t = (rule as any).target;
      if (t?.ref) jumpTargets.add(String(t.ref));
      // `{ kind: "terminate", status: "screened" }` reaches the End that
      // carries that status — by status, not by id, which is why matching
      // ids alone still reported a survey's screen-out End as unreachable
      if (t?.kind === "terminate") jumpStatuses.add(String(t.status ?? "terminated"));
      if (t?.kind === "end") jumpStatuses.add("complete");
    }
  }
  for (const quota of def.quotas ?? []) {
    if ((quota.onFull as any)?.kind === "terminate") jumpStatuses.add("quota_full");
  }
  const nodeById = (id: string): any => {
    let found: any = null;
    const walk = (nodes: any[]) => {
      for (const n of nodes ?? []) {
        if (found) return;
        if (n?.id === id) { found = n; return; }
        if (n?.children) walk(n.children);
        if (n?.branches) for (const b of n.branches) walk(b.children);
        if (n?.otherwise) walk(n.otherwise);
      }
    };
    walk(def.flow as any[]);
    return found;
  };
  try {
    for (const f of validateFlowStructure(def.flow as never)) {
      if (/no respondent reaches it/i.test(f.message) && f.nodeId) {
        if (jumpTargets.has(f.nodeId)) continue;
        const node = nodeById(f.nodeId);
        if (node?.type === "end" && jumpStatuses.has(String(node.status ?? "complete"))) continue;
      }
      collected.push({ level: f.level, path: "flow", message: f.message });
    }
  } catch { /* already reported per question */ }

  collected.push(...deploymentIssues(def));

  const byArea = new Map<string, LogicIssue[]>();
  for (const key of ORDER) byArea.set(key, []);
  for (const issue of collected) {
    const key = issue.path === "deployment" ? "deployment" : areaOf(issue);
    (byArea.get(key) ?? byArea.set(key, []).get(key)!).push(issue);
  }

  const areas: QualityArea[] = ORDER.map((key) => {
    const issues = byArea.get(key) ?? [];
    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.length - errors;
    return {
      key,
      label: AREA_LABELS[key] ?? key,
      status: errors ? "fail" : warnings ? "warn" : "pass",
      errors,
      warnings,
      issues,
      note: issues.length === 0 ? AREA_NOTES[key] : undefined,
    };
  });

  const errors = areas.reduce((a, x) => a + x.errors, 0);
  const warnings = areas.reduce((a, x) => a + x.warnings, 0);
  return {
    status: errors ? "fail" : warnings ? "warn" : "pass",
    errors,
    warnings,
    areas,
    deployable: errors === 0,
    checkedAt: new Date().toISOString(),
  };
}

/** A one-line summary, for a toast or a commit message. */
export function describeQualityCheck(r: QualityCheckResult): string {
  if (r.status === "pass") return `All ${r.areas.length} checks passed.`;
  const bits: string[] = [];
  if (r.errors) bits.push(`${r.errors} problem${r.errors === 1 ? "" : "s"}`);
  if (r.warnings) bits.push(`${r.warnings} warning${r.warnings === 1 ? "" : "s"}`);
  return `${bits.join(" and ")} across ${r.areas.filter((a) => a.status !== "pass").length} area${r.areas.filter((a) => a.status !== "pass").length === 1 ? "" : "s"}.`;
}
