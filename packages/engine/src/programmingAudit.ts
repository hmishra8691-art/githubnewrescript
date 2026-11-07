import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { lintSurveyLogic } from "./lintLogic.js";
import { validateFlowStructure } from "./flowTree.js";
import { detectLogicCycles, describeCycle, lintCalculations } from "./dependencies.js";
import { buildLogicFlow, unreachableLogicNodes } from "./logicGraph.js";
import { lintAiConversation } from "./aiConversation.js";
import { lintLocalizationSummary } from "./localization.js";

/**
 * THE PROGRAMMING AUDIT LOG (ResLens roadmap 3.6, tracker 3.1).
 *
 * One row per problem the survey's own checks find before launch — logic references, flow structure, circular
 * dependencies, questions no path reaches, calculations, the AI interviewer, translations — in the columns a
 * programming QA sheet uses: severity, category, location, object, issue, expected behaviour, actual behaviour,
 * recommended correction. It runs the same checks as the Logic panel's check list (plus reachability), so the sheet
 * a programmer downloads matches what the Studio shows.
 *
 * Expected behaviour and correction come from the issue's category (what that kind of rule is meant to do and the
 * usual fix); where the check's own message carries a fix after a dash ("… — use Carry Back"), that fix is used.
 * Nothing here invents a finding: every row is a check's own output.
 */
export type AuditSeverity = "Critical" | "High" | "Medium" | "Low";

export interface ProgrammingAuditRow {
  severity: AuditSeverity;
  category: string;
  /** question code, "Flow", a flow node, a section of settings */
  location: string;
  /** where inside it: a dotted path */
  object: string;
  issue: string;
  expected: string;
  actual: string;
  correction: string;
  /** the check that produced it */
  check: "logic" | "flow" | "cycle" | "reachability" | "calculation" | "ai_interviewer" | "localization";
}

interface Kind { category: string; expected: string; correction: string; test: (msg: string, path: string) => boolean }
const KINDS: Kind[] = [
  { category: "Invalid reference", test: (m) => /does not exist|no option coded|no row|no calculation named|no embedded data field|which does not exist/i.test(m),
    expected: "Every rule, pipe and count names a question, option, row or field that exists in the survey.", correction: "Point the reference at an existing item, or restore the item that was renamed or deleted." },
  { category: "Order dependency", test: (m) => /comes after|asked after|later question/i.test(m),
    expected: "A rule or pipe only reads answers given earlier in the flow.", correction: "Move the source question earlier, or read it after it has been asked." },
  { category: "Piping", test: (m, p) => /pip/i.test(m) || /text|label/i.test(p) && /token/i.test(m),
    expected: "Every piped token resolves to an answer, calculation or field the respondent has already produced.", correction: "Fix the token or its source so it resolves for every respondent who sees the text." },
  { category: "Operator or value", test: (m) => /operator|needs a second value|has no value set|cannot compare/i.test(m),
    expected: "Each condition uses an operator that fits the question type, with every value it needs.", correction: "Choose a compatible operator and fill in the missing value(s)." },
  { category: "Carry forward / masking", test: (m) => /carry (forward|back)|source question/i.test(m),
    expected: "Carried options come from a question that is asked before (forward) or after (back) the target.", correction: "Use the carry direction that matches the question order, and name at least one source." },
  { category: "Selection limits", test: (m) => /selections|show only|whole number/i.test(m),
    expected: "Minimum and maximum selections are whole numbers that the available options can satisfy.", correction: "Set limits within the number of options, minimum not above maximum." },
  { category: "Layout", test: (m) => /layout|column|horizontal|image/i.test(m),
    expected: "Presentation settings are ones the question type can draw.", correction: "Remove the setting or switch to a variant that supports it." },
  { category: "Complexity", test: (m) => /nests .* levels/i.test(m),
    expected: "Logic stays shallow enough to read and verify.", correction: "Split the condition into named rules or a branch." },
  { category: "Grid logic", test: (m) => /grid|row “/i.test(m),
    expected: "Grid conditions name the row and column they test.", correction: "Pick the row (and column) the condition is about." },
];

function classify(msg: string, path: string): Kind {
  return KINDS.find((k) => k.test(msg, path)) ?? { category: "Logic", test: () => true, expected: "The rule behaves as written for every respondent.", correction: "Review the rule named in the issue." };
}

/** "Actual — fix" → [actual, fix]: checks put their recommended fix after an em dash */
function split(msg: string): [string, string | null] {
  const i = msg.indexOf(" — ");
  if (i < 0) return [msg, null];
  const tail = msg.slice(i + 3).trim();
  /* only a tail that reads as an instruction is a fix; "— the count will be 0" is part of what happens */
  return /^(use|move|consider|set|remove|pick|choose|add|rename|split|give|point|switch|fix|make|delete|replace)\b/i.test(tail) ? [msg.slice(0, i).trim(), tail.charAt(0).toUpperCase() + tail.slice(1)] : [msg, null];
}

const SEVERITY_RANK: Record<AuditSeverity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function programmingAuditRows(def: SurveyDefinition): ProgrammingAuditRow[] {
  const rows: ProgrammingAuditRow[] = [];
  for (const i of lintSurveyLogic(def)) {
    const k = classify(i.message, i.path);
    const [actual, fix] = split(i.message);
    rows.push({
      severity: i.level === "error" ? (k.category === "Invalid reference" ? "Critical" : "High") : "Medium",
      category: k.category, location: i.questionCode ?? i.questionId ?? i.objectKey ?? "Survey", object: i.path || "—",
      issue: i.message, expected: k.expected, actual, correction: fix ?? k.correction, check: "logic",
    });
  }
  for (const i of validateFlowStructure(def.flow as FlowNode[])) {
    const [actual, fix] = split(i.message);
    rows.push({
      severity: i.level === "error" ? "High" : "Medium", category: "Flow structure", location: "Flow", object: i.nodeId ? `flow.${i.nodeId}` : "flow",
      issue: i.message, expected: "The flow is well formed: every branch, loop and end is complete and reachable.", actual, correction: fix ?? "Fix the flow element named in the issue.", check: "flow",
    });
  }
  for (const c of detectLogicCycles(def)) {
    const text = describeCycle(def, c);
    rows.push({
      severity: "Critical", category: "Circular dependency", location: "Survey", object: c.join(" → "), issue: text,
      expected: "No rule depends, directly or through others, on its own result.", actual: text, correction: "Break the loop: make one of the rules read an earlier answer or a fixed value.", check: "cycle",
    });
  }
  try {
    const graph = buildLogicFlow(def, { questions: true });
    for (const n of unreachableLogicNodes(graph)) {
      if (n.kind !== "question") continue;
      const q = def.questions.find((x) => x.id === n.ref);
      rows.push({
        severity: "High", category: "Unreachable question", location: q?.code ?? n.label ?? n.id, object: `question.${n.ref ?? n.id}`,
        issue: `${q?.code ?? n.label ?? n.id} cannot be reached by any path through the flow.`,
        expected: "Every question is shown to at least one kind of respondent.", actual: "No route through the branches and conditions arrives at it.",
        correction: "Check the conditions in front of it, or remove it if it is no longer needed.", check: "reachability",
      });
    }
  } catch { /* a flow the graph cannot be built from is already reported by the flow structure check */ }
  for (const m of lintCalculations(def)) rows.push({ severity: "High", category: "Calculation", location: "Calculations", object: "calculations", issue: m, expected: "Every calculation parses and reads variables that exist.", actual: m, correction: "Fix the expression named in the issue.", check: "calculation" });
  for (const m of lintAiConversation(def)) rows.push({ severity: "Low", category: "AI interviewer", location: "AI", object: "branding.aiConversation", issue: m, expected: "AI interviewer settings take effect as configured.", actual: m, correction: "Adjust the AI interviewer setting named in the issue.", check: "ai_interviewer" });
  for (const m of lintLocalizationSummary(def)) rows.push({ severity: "Medium", category: "Translation", location: "Languages", object: "localization", issue: m, expected: "Every language marked ready or live is complete and current.", actual: m, correction: "Finish or update the translation, or mark the language as draft.", check: "localization" });
  return rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.location.localeCompare(b.location));
}
