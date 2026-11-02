/**
 * THE NATIVE CAPABILITY REGISTRY THE IMPORTER RECONSTRUCTS WITH (2026-11-02).
 *
 * For each survey-programming feature a source may carry, what Rescript has for it: the native JSON, the properties
 * it needs, what it depends on, which engine function runs it, how it is checked, and its known limits. The import
 * engine writes its reconstruction report from here (reconstruct.ts), the AI-suggestion prompt lists it, and the
 * review screen names the implementation from it — one description of the platform, not one per caller.
 *
 * ## Grounded in the code, not in documentation
 *
 * Every entry carries `sample` — the native JSON at its `at` (a question fragment, a flow node, a survey key) —
 * and `runtime` — the engine export that executes it. `nativeRegistry.test.ts` parses each sample through the
 * survey schema and fails if the schema strips any of its keys (the schema does not know the property), and fails
 * if the engine does not export the runtime function. A registry entry that describes something the platform does
 * not do cannot pass.
 */
export interface NativeCapability {
  id: string;
  feature: string;
  /** where the native JSON lives */
  at: "question" | "flow" | "survey";
  /** the native JSON, as the schema accepts it */
  sample: Record<string, unknown>;
  /** the properties without which it does nothing */
  required: string[];
  /** what it needs to exist first */
  dependsOn: string[];
  /** the @rescript/engine export that runs it */
  runtime: string;
  /** how the platform checks it */
  validation: string;
  /** what it does not do */
  limits: string;
}

const Q = "question" as const, F = "flow" as const, S = "survey" as const;

export const NATIVE_CAPABILITIES: NativeCapability[] = [
  { id: "options", feature: "Answer options (codes, labels, flags)", at: Q, sample: { options: [{ code: 10, label: "Alpha", flags: ["anchor_bottom"] }] }, required: ["options[].code", "options[].label"], dependsOn: [], runtime: "effectiveQuestion", validation: "unique codes; a choice question needs options or a carried list", limits: "a code is a number or a string; recodes are the codes themselves" },
  { id: "display_logic", feature: "Display logic", at: Q, sample: { displayLogic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 } }, required: ["displayLogic"], dependsOn: ["the questions it reads, asked earlier"], runtime: "visibleQuestions", validation: "lintLogic: unknown references, forward references, impossible rules", limits: "reads answers, embedded data, quotas, loop fields and behaviour; not the device's geolocation" },
  { id: "nested_conditions", feature: "Nested AND / OR / NOT conditions", at: Q, sample: { displayLogic: { type: "group", op: "or", children: [{ type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 }, { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 2 }, { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 3 }] }] } }, required: ["type", "op", "children"], dependsOn: [], runtime: "evaluateCondition", validation: "any depth; empty groups are vacuous", limits: "—" },
  { id: "skip_logic", feature: "Skip logic", at: Q, sample: { skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 2 }, target: { kind: "end", status: "screened" } }] }, required: ["when", "target"], dependsOn: ["a later target"], runtime: "advance", validation: "the target must exist and come later", limits: "—" },
  { id: "branch", feature: "Branch (survey flow)", at: F, sample: { type: "branch", id: "br1", branches: [{ id: "a1", when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 }, children: [] }], otherwise: [] }, required: ["branches[].when"], dependsOn: [], runtime: "compileFlow", validation: "lintLogic", limits: "—" },
  { id: "piping", feature: "Piping ({{Q1}}, {{Q1.count}}, {{ed.field}}, {{loop.label}})", at: Q, sample: { text: "You chose {{Q1}} ({{Q1.count}} brands) — panel {{ed.panel}}", instruction: "About {{Q1}}" }, required: ["a token naming an earlier question, a field or the loop"], dependsOn: ["the source asked earlier"], runtime: "resolvePiping", validation: "lintLogic: unknown tokens; a forward reference is empty", limits: "question text, options, rows, instructions, descriptions, validation messages and redirect URLs" },
  { id: "carry_forward", feature: "Carry forward (selected / not selected / displayed / all)", at: Q, sample: { carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options", keepOwn: false } }, required: ["sourceQuestionId", "filter"], dependsOn: ["a choice question asked earlier"], runtime: "effectiveQuestion", validation: "the source must exist and have a list", limits: "the carried options keep the source's codes and labels; a chain of carries is resolved at runtime" },
  { id: "mask", feature: "Masking by a set expression", at: Q, sample: { mask: { expr: { kind: "ref", questionId: "q1", selection: "selected" }, action: "display" } }, required: ["expr"], dependsOn: ["the source question"], runtime: "effectiveQuestion", validation: "the set expression's questions must exist", limits: "display / remove / preselect / disable" },
  { id: "loop", feature: "Loop over a question's answers (or a list)", at: F, sample: { type: "loop", id: "lp1", loopVar: "BRAND", source: { kind: "question", questionId: "q1", filter: "selected" }, children: [] }, required: ["loopVar", "source"], dependsOn: ["the source asked before the loop"], runtime: "resolveLoopItems", validation: "lintLogic: the source exists and has a list", limits: "answers are stored per iteration (<id>@<code>); {{loop.label}} pipes the current item" },
  { id: "randomization", feature: "Option randomization", at: Q, sample: { randomization: { enabled: true, scope: "options", method: "shuffle" } }, required: ["enabled"], dependsOn: [], runtime: "effectiveQuestion", validation: "anchored options stay in place", limits: "—" },
  { id: "randomizer", feature: "Block / question randomizer", at: F, sample: { type: "randomizer", id: "rz1", show: 1, evenPresentation: true, children: [] }, required: ["children"], dependsOn: [], runtime: "recordDisplayOrders", validation: "—", limits: "the order shown is recorded as ORDER_<id>" },
  { id: "embedded_data", feature: "Embedded data", at: F, sample: { type: "embedded_data", id: "ed1", fields: [{ name: "panel", source: "url" }] }, required: ["fields[].name", "fields[].source"], dependsOn: [], runtime: "compileFlow", validation: "names unique", limits: "url / panel / static / expression" },
  { id: "calculation", feature: "Calculations", at: S, sample: { calculations: [{ id: "c1", targetVariable: "TOTAL", expression: "Q1 + Q2" }] }, required: ["targetVariable", "expression"], dependsOn: ["the variables it reads"], runtime: "runCalculations", validation: "the expression parses", limits: "—" },
  { id: "auto_punch", feature: "Auto-punch (code an answer from criteria)", at: Q, sample: { punches: [{ id: "p1", source: { kind: "ref", questionId: "q1", selection: "selected" }, action: "select" }] }, required: ["source"], dependsOn: ["the source question"], runtime: "applyPunches", validation: "—", limits: "—" },
  { id: "validation", feature: "Validation rules", at: Q, sample: { validation: [{ kind: "min_value", value: 0 }, { kind: "integer" }] }, required: ["kind"], dependsOn: [], runtime: "validateQuestion", validation: "the server replays them", limits: "a custom script rule runs in the browser only" },
  { id: "blocks_pages", feature: "Blocks and page breaks", at: F, sample: { type: "block", id: "b1", title: "Funnel", children: [{ type: "page", id: "p1", questionIds: ["q1"] }] }, required: ["children"], dependsOn: [], runtime: "compileFlow", validation: "every question placed once", limits: "—" },
  { id: "quota", feature: "Quotas", at: S, sample: { quotas: [{ id: "qt1", name: "Women", cells: [{ id: "c1", label: "Women", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 2 }, limit: 100 }] }] }, required: ["cells[].when", "cells[].limit"], dependsOn: [], runtime: "checkQuotas", validation: "—", limits: "—" },
  { id: "end", feature: "Ends, termination and screen-outs", at: F, sample: { type: "end", id: "e1", status: "screened", message: "Thank you" }, required: ["status"], dependsOn: [], runtime: "compileFlow", validation: "—", limits: "complete / screened / quota_full / terminated" },
  { id: "redirect", feature: "Redirects (with piped values)", at: F, sample: { type: "end", id: "e2", status: "complete", redirectUrl: "https://panel.example.com/done?pid={{ed.panel}}" }, required: ["redirectUrl"], dependsOn: ["the fields it pipes"], runtime: "resolveUrlTemplate", validation: "values are percent-encoded", limits: "—" },
  { id: "other_specify", feature: "Other — specify", at: Q, sample: { options: [{ code: 97, label: "Other (please specify)", flags: ["other_specify"] }] }, required: ["flags: other_specify"], dependsOn: [], runtime: "validateQuestion", validation: "the text is required unless settings.otherSpecifyOptional", limits: "—" },
  { id: "dont_know", feature: "“I don't know” beside a text or number", at: Q, sample: { type: "numeric", settings: { dontKnow: true, dontKnowLabel: "Not sure" } }, required: ["settings.dontKnow"], dependsOn: [], runtime: "dontKnowEnabled", validation: "exclusive with an answer", limits: "open text, long text and numbers" },
  { id: "custom_js", feature: "Custom JavaScript", at: Q, sample: { customJs: "rs.onChange(() => {})" }, required: ["customJs"], dependsOn: [], runtime: "runScript", validation: "the code gate (S0) — never run on import", limits: "imported scripts are reported for review, not executed" },
  { id: "custom_css", feature: "Custom CSS", at: Q, sample: { customCss: ".rs-card { color: #333 }" }, required: ["customCss"], dependsOn: [], runtime: "sanitizeCss", validation: "sanitised and scoped", limits: "—" },
];

export const nativeCapability = (id: string): NativeCapability | undefined => NATIVE_CAPABILITIES.find((c) => c.id === id);

/** the registry in a few lines, for a model's prompt: what the platform can build */
export const nativeCapabilityListing = (): string => NATIVE_CAPABILITIES.map((c) => `- ${c.feature}: ${JSON.stringify(c.sample)}`).join("\n");
