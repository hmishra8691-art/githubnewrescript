import type { FlowNode, PlannedTest, SurveyDefinition } from "@rescript/schema";
import { AnalysisPlan, Question } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import { randomizerOrderVariable } from "./displayOrder.js";

/**
 * RESEARCH-METHOD TEMPLATES (S5c, 2026-11-01) — a complete, programmed block for a named method, with the
 * analysis-plan items that read it, inserted by one copilot action:
 *
 *   {"op":"add_method_template","template":"pricing_psm","product":"the Aurora kettle","currency":"$"}
 *
 * The SAME fragments build the starter surveys in `@rescript/templates` (the "New survey" picker), so a template
 * opened from the picker and one added by Intelligent Mode are the same questions, codes and plan items.
 *
 *   pricing_psm          Van Westendorp's four price questions (too cheap, cheap, expensive, too expensive) and,
 *                        unless nms:false, the Newton–Miller–Smith pair: purchase likelihood at the respondent's
 *                        own "cheap" and "expensive" price (piped), 5-point, calibrated in the analysis.
 *                        Plan: pricing (van_westendorp, vwCurves, nmsCheap / nmsExpensive).
 *
 *   price_ladder         an adaptive Gabor–Granger ladder (numeric.price_ladder, `prices`, `start`), the answer the
 *                        highest price accepted. Plan: pricing (gabor_granger, ladder: true, prices).
 *
 *   sequential_monadic   one block per concept (the concept, then appeal and purchase intent, 5-point), all under a
 *                        randomizer that shows every block in a Williams order (balanced for position and for which
 *                        concept follows which); ORDER_<RANDOMIZER> stores the order each respondent saw (S4c).
 *                        Plan: sequential_monadic on the appeal ratings (order, blocks) — paired tests + order effect.
 *
 * Variable names are fixed per template (PSM_TOO_CHEAP, …) so the plan can name them; a survey that already has
 * one of them is refused with the clash named — pass `prefix` ("A_" → A_PSM_TOO_CHEAP) to add a second copy.
 */

export const METHOD_TEMPLATE_KEYS = ["pricing_psm", "price_ladder", "sequential_monadic"] as const;
export type MethodTemplateKey = (typeof METHOD_TEMPLATE_KEYS)[number];

export type MethodTemplateAction = {
  op: "add_method_template";
  template: MethodTemplateKey;
  /** what is being priced / tested, used in the question texts */
  product?: string;
  /** currency symbol shown in the price questions ("$", "€", "₹") */
  currency?: string;
  /** pricing_psm: add the Newton–Miller–Smith likelihood pair (default true) */
  nms?: boolean;
  /** pricing_psm: which Van Westendorp end-point definition the plan item uses (default proxy) */
  vwCurves?: "proxy" | "textbook";
  /** price_ladder: the ladder (3–20 positive prices; default 5, 10, 15, 20, 25) */
  prices?: number[];
  /** price_ladder: where the ladder starts (default middle) */
  start?: "middle" | "lowest" | "highest" | "random";
  /** sequential_monadic: the concepts (2–8 short names; default Concept A, B, C) */
  concepts?: string[];
  /** prepended to every code and variable name — for a second copy of a template */
  prefix?: string;
  /** add the plan items (default true) */
  plan?: boolean;
};
export const METHOD_TEMPLATE_ACTION_OPS = ["add_method_template"] as const;

export interface MethodTemplateFragment {
  title: string;
  questions: Record<string, unknown>[];
  /** the template's top-level flow node: a block of pages (a randomizer of concept blocks for sequential_monadic) */
  block: FlowNode;
  tests: Omit<PlannedTest, "id">[];
  notes: string[];
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function coerceMethodTemplateAction(o: Record<string, unknown>): MethodTemplateAction | string {
  const template = str(o.template ?? o.method, 40);
  if (!template || !(METHOD_TEMPLATE_KEYS as readonly string[]).includes(template)) return `add_method_template needs template: one of ${METHOD_TEMPLATE_KEYS.join(", ")}`;
  const a: MethodTemplateAction = { op: "add_method_template", template: template as MethodTemplateKey };
  const product = str(o.product, 120); if (product) a.product = product;
  const currency = str(o.currency, 4); if (currency) a.currency = currency;
  if (typeof o.nms === "boolean") a.nms = o.nms;
  if (o.vwCurves !== undefined) { if (o.vwCurves !== "proxy" && o.vwCurves !== "textbook") return "add_method_template vwCurves must be proxy or textbook"; a.vwCurves = o.vwCurves; }
  if (o.prefix !== undefined) { const p = str(o.prefix, 12); if (!p || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p)) return "add_method_template prefix must be letters, digits and _ (start with a letter)"; a.prefix = p.toUpperCase(); }
  if (o.prices !== undefined) {
    const ps = Array.isArray(o.prices) ? o.prices.map(Number) : [];
    if (ps.length < 3 || ps.length > 20 || ps.some((p) => !(Number.isFinite(p) && p > 0)) || new Set(ps).size !== ps.length) return "add_method_template prices must be 3–20 different positive numbers";
    a.prices = [...ps].sort((x, y) => x - y);
  }
  if (o.start !== undefined) { if (!["middle", "lowest", "highest", "random"].includes(String(o.start))) return "add_method_template start must be middle, lowest, highest or random"; a.start = o.start as MethodTemplateAction["start"]; }
  if (o.concepts !== undefined) {
    const cs = Array.isArray(o.concepts) ? o.concepts.map((c) => str(c, 120)).filter((c): c is string => !!c) : [];
    if (cs.length < 2 || cs.length > 8 || new Set(cs.map((c) => c.toLowerCase())).size !== cs.length) return "add_method_template concepts must be 2–8 different names";
    a.concepts = cs;
  }
  if (o.plan === false) a.plan = false;
  return a;
}

const LIKELY_5 = [
  { code: 5, label: "Definitely would buy" }, { code: 4, label: "Probably would buy" }, { code: 3, label: "Might or might not buy" },
  { code: 2, label: "Probably would not buy" }, { code: 1, label: "Definitely would not buy" },
];

/** the template's questions, block and plan items; ids from the caller's minter */
export function methodTemplateFragment(a: Omit<MethodTemplateAction, "op">, ids: IdMinter): MethodTemplateFragment {
  const P = a.prefix ?? "";
  const product = a.product ?? "this product";
  const cur = a.currency ?? "$";
  const page = (title: string, qs: Record<string, unknown>[]): FlowNode => ({ type: "page", id: ids("p"), title, questionIds: qs.map((q) => String(q.id)) }) as FlowNode;
  const q = (code: string, type: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: ids("q"), code: `${P}${code}`, variableName: `${P}${code}`, type, text, required: true, ...extra });
  switch (a.template) {
    case "pricing_psm": {
      const price = (code: string, text: string) => q(code, "numeric", text, { settings: { minValue: 0, maxValue: 1_000_000, currencySymbol: cur } });
      const vw = [
        price("PSM_TOO_CHEAP", `At what price would you consider ${product} to be so inexpensive that you would doubt its quality?`),
        price("PSM_CHEAP", `At what price would you consider ${product} a bargain — a great buy for the money?`),
        price("PSM_EXPENSIVE", `At what price would you say ${product} is getting expensive — not out of the question, but you would have to think about buying it?`),
        price("PSM_TOO_EXPENSIVE", `At what price would ${product} be so expensive that you would not consider buying it?`),
      ];
      const nms = a.nms === false ? [] : [
        q("NMS_CHEAP", "single_select", `At ${cur}{{${P}PSM_CHEAP}}, how likely would you be to buy ${product}?`, { options: LIKELY_5 }),
        q("NMS_EXPENSIVE", "single_select", `At ${cur}{{${P}PSM_EXPENSIVE}}, how likely would you be to buy ${product}?`, { options: LIKELY_5 }),
      ];
      const pages = [page("Price perception", vw), ...(nms.length ? [page("Purchase likelihood", nms)] : [])];
      return {
        title: "Price sensitivity (Van Westendorp" + (nms.length ? " + Newton–Miller–Smith)" : ")"),
        questions: [...vw, ...nms],
        block: { type: "block", id: ids("b"), title: "Price sensitivity", children: pages } as FlowNode,
        tests: [{ method: "pricing", variables: vw.map((x) => String(x.variableName)), priority: 1, tier: "essential", hypotheses: [], reason: "Van Westendorp price sensitivity" + (nms.length ? " with the Newton–Miller–Smith trial / revenue optimum" : ""),
          options: { method: "van_westendorp", vwCurves: a.vwCurves ?? "proxy", ...(nms.length ? { nmsCheap: `${P}NMS_CHEAP`, nmsExpensive: `${P}NMS_EXPENSIVE` } : {}) } }],
        notes: [nms.length ? "NMS likelihood is calibrated 0.7 / 0.5 / 0.3 / 0.1 / 0 (top box first) unless the plan item sets calibration." : "Van Westendorp only (nms: false)."],
      };
    }
    case "price_ladder": {
      const prices = a.prices ?? [5, 10, 15, 20, 25];
      const ladder = q("PRICE_LADDER", "numeric", `Would you buy ${product} at the price shown?`, {
        variant: "numeric.price_ladder",
        settings: { minValue: 0, maxValue: prices[prices.length - 1], priceLadder: { prices, start: a.start ?? "middle", currency: cur, prompt: `Would you buy ${product} at {price}?`, yesLabel: "Yes, I would buy it", noLabel: "No" } },
        instruction: "Answer for each price shown.",
      });
      return {
        title: "Adaptive Gabor–Granger price ladder",
        questions: [ladder],
        block: { type: "block", id: ids("b"), title: "Price ladder", children: [page("Price ladder", [ladder])] } as FlowNode,
        tests: [{ method: "pricing", variables: [`${P}PRICE_LADDER`], priority: 1, tier: "essential", hypotheses: [], reason: "Gabor–Granger demand and revenue curves from the adaptive ladder", options: { method: "gabor_granger", ladder: true, prices } }],
        notes: [`Ladder ${prices.map((p) => `${cur}${p}`).join(" / ")}, starting ${a.start ?? "middle"}; the answer is the highest price accepted (0 = none), the path is kept as GG_${P}PRICE_LADDER_PATH.`],
      };
    }
    case "sequential_monadic": {
      const concepts = a.concepts ?? ["Concept A", "Concept B", "Concept C"];
      const AGREE = (lo: string, hi: string) => [{ code: 1, label: lo }, { code: 2, label: "2" }, { code: 3, label: "3" }, { code: 4, label: "4" }, { code: 5, label: hi }];
      const qs: Record<string, unknown>[] = [];
      const blocks: FlowNode[] = [];
      const appeal: string[] = [];
      concepts.forEach((c, i) => {
        const n = i + 1;
        const show = q(`C${n}_SHOW`, "html", `<p><strong>${c.replace(/[<>&]/g, "")}</strong></p><p>Please read this description carefully.</p>`, { required: false });
        const ap = q(`C${n}_APPEAL`, "single_select", `Overall, how appealing is ${c.replace(/[<>&]/g, "")} to you?`, { options: AGREE("Not at all appealing", "Extremely appealing") });
        const pi = q(`C${n}_INTENT`, "single_select", `How likely would you be to buy ${c.replace(/[<>&]/g, "")}?`, { options: AGREE("Definitely would not buy", "Definitely would buy") });
        qs.push(show, ap, pi);
        appeal.push(String(ap.variableName));
        blocks.push({ type: "block", id: ids("b"), title: c, children: [page(c, [show, ap, pi])] } as FlowNode);
      });
      const rid = ids("r");
      return {
        title: `Sequential monadic test of ${concepts.length} concepts`,
        questions: qs,
        /* the randomizer is the top-level node itself: a block holding a randomizer is a "block with non-page elements" to the quality check */
        block: { type: "randomizer", id: rid, title: "Concept rotation", order: "williams", children: blocks } as FlowNode,
        tests: [{ method: "sequential_monadic", variables: appeal, priority: 1, tier: "essential", hypotheses: [], reason: "every respondent rates every concept: within-respondent comparison and the order effect", options: { order: randomizerOrderVariable(rid, null), blocks: blocks.map((b) => (b as { id: string }).id) } }],
        notes: [`Rotation: Williams order over ${concepts.length} concept blocks; the order is stored in ${randomizerOrderVariable(rid, null)}.`],
      };
    }
  }
}

/* ------------------------------------------------------------ apply */

class TemplateError extends Error {}

/** add the template's block before the survey's end screens, its questions and (unless plan:false) its plan items */
export function applyMethodTemplateAction(def: SurveyDefinition, a: MethodTemplateAction, env: { ids: IdMinter }): { description: string; warnings: string[]; touched: string[] } {
  const frag = methodTemplateFragment(a, env.ids);
  const taken = new Set(def.questions.flatMap((x) => [x.code, x.variableName].filter(Boolean).map((s) => String(s).toUpperCase())));
  const clash = frag.questions.map((x) => String(x.variableName)).filter((v) => taken.has(v.toUpperCase()));
  if (clash.length) throw new TemplateError(`the survey already has ${clash.join(", ")} — pass a prefix (e.g. "prefix":"B_") to add a second ${a.template} block`);
  for (const x of frag.questions) def.questions.push(Question.parse(x));
  const endAt = def.flow.findIndex((n) => n.type === "end");
  def.flow.splice(endAt < 0 ? def.flow.length : endAt, 0, frag.block);
  const warnings = [...frag.notes];
  if (a.plan !== false && frag.tests.length) {
    if (!def.research) def.research = { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] } as never;
    const plan = def.research!.analysisPlan ?? AnalysisPlan.parse({});
    for (const t of frag.tests) plan.tests.push({ id: env.ids("t"), ...t } as PlannedTest);
    def.research!.analysisPlan = plan;
  }
  return { description: `${frag.title}: ${frag.questions.length} question${frag.questions.length === 1 ? "" : "s"} (${frag.questions.map((x) => x.code).join(", ")})${a.plan !== false && frag.tests.length ? ` and ${frag.tests.length} analysis-plan item${frag.tests.length === 1 ? "" : "s"}` : ""}`, warnings, touched: frag.questions.map((x) => String(x.id)) };
}
export function isMethodTemplateError(e: unknown): e is Error { return e instanceof TemplateError; }

export function describeMethodTemplateAction(a: MethodTemplateAction): string {
  return `Add a ${a.template.replace(/_/g, " ")} template${a.product ? ` for ${a.product}` : ""}`;
}
