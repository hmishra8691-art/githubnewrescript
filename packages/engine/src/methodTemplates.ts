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
 *   iat                  the four COMBINED blocks of an IAT (B3/B4 compatible, B6/B7 incompatible pairing, practice
 *                        and test), each an experimental.reaction_time question over the same stimuli with its
 *                        answer key (settings.iatBlock) — the engine scores IAT_D. targets [A, B], attributes
 *                        [good, bad] and their words; the single-category practice blocks (B1, B2, B5) and the
 *                        counterbalancing of which pairing comes first are NOT added (add them by hand).
 *                        Plan: iat_dscore.
 *
 *   shelf_test           a hotspot.shelf question on the shelf image (imageUrl, required) with one region per
 *                        product (products, laid out evenly left to right — adjust them in the regions editor),
 *                        optional second choice. Plan: shelf_share.
 *
 *   brand_funnel         unaided awareness (open end) coded by the AI classification (a calculated ai_classify over
 *                        the brand list — the runtime resolves it, fake provider in tests), then aided awareness →
 *                        consideration → purchase (carried forward stage to stage) → preference. Plan: brand_funnel
 *                        over the four stages + frequencies of the coded first mention.
 *   ad_test              forced exposure (media.video_rating: the video must play to the end, then likeability),
 *                        unaided brand recall (open end → ai_classify), aided recall, a diagnostics grid (5-point
 *                        agreement) and post-exposure purchase intent. Plan: frequencies of recall, mean
 *                        likeability, top-2 box of the diagnostics and of intent.
 *
 * Variable names are fixed per template (PSM_TOO_CHEAP, …) so the plan can name them; a survey that already has
 * one of them is refused with the clash named — pass `prefix` ("A_" → A_PSM_TOO_CHEAP) to add a second copy.
 */

export const METHOD_TEMPLATE_KEYS = ["pricing_psm", "price_ladder", "sequential_monadic", "iat", "shelf_test", "brand_funnel", "ad_test"] as const;
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
  /** iat: the two target categories and the two attribute categories (good first), each with 2–8 stimulus words */
  targets?: [string, string];
  attributes?: [string, string];
  targetWords?: [string[], string[]];
  attributeWords?: [string[], string[]];
  /** shelf_test: the shelf image (https or the media library) and the products on it (2–12) */
  imageUrl?: string;
  products?: string[];
  secondPick?: boolean;
  /** brand_funnel / ad_test: the brand list (2–15; the advertised brand first for ad_test) */
  brands?: string[];
  /** ad_test: the ad (https or the media library) — the guide asks for it; absent, set it in the editor */
  videoUrl?: string;
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
  const pair = (v: unknown, what: string): [string, string] | string | undefined => {
    if (v === undefined) return undefined;
    const xs = Array.isArray(v) ? v.map((x) => str(x, 60)).filter((x): x is string => !!x) : [];
    return xs.length === 2 && xs[0].toLowerCase() !== xs[1].toLowerCase() ? [xs[0], xs[1]] : `add_method_template ${what} must be two different names`;
  };
  const words = (v: unknown, what: string): [string[], string[]] | string | undefined => {
    if (v === undefined) return undefined;
    const xs = Array.isArray(v) && v.length === 2 ? v.map((l) => (Array.isArray(l) ? l.map((x) => str(x, 60)).filter((x): x is string => !!x) : [])) : [];
    return xs.length === 2 && xs.every((l) => l.length >= 2 && l.length <= 8) ? [xs[0], xs[1]] : `add_method_template ${what} must be two lists of 2–8 words`;
  };
  for (const [k, f] of [["targets", pair], ["attributes", pair], ["targetWords", words], ["attributeWords", words]] as const) {
    const r = (f as (v: unknown, w: string) => unknown)(o[k], k);
    if (typeof r === "string") return r;
    if (r !== undefined) (a as Record<string, unknown>)[k] = r;
  }
  if (o.imageUrl !== undefined) { const u = str(o.imageUrl, 2000); if (!u || !/^(?:https:\/\/|\/api\/media\/)/.test(u)) return "add_method_template imageUrl must be https or the survey's media library (/api/media/…)"; a.imageUrl = u; }
  if (o.products !== undefined) {
    const ps = Array.isArray(o.products) ? o.products.map((x) => str(x, 80)).filter((x): x is string => !!x) : [];
    if (ps.length < 2 || ps.length > 12 || new Set(ps.map((x) => x.toLowerCase())).size !== ps.length) return "add_method_template products must be 2–12 different names";
    a.products = ps;
  }
  if (typeof o.secondPick === "boolean") a.secondPick = o.secondPick;
  if (o.brands !== undefined) {
    const bs = Array.isArray(o.brands) ? o.brands.map((x) => str(x, 80)).filter((x): x is string => !!x && !/[|"]/.test(x)) : [];
    if (bs.length < 2 || bs.length > 15 || new Set(bs.map((x) => x.toLowerCase())).size !== bs.length) return "add_method_template brands must be 2–15 different names (no | or \")";
    a.brands = bs;
  }
  if (o.videoUrl !== undefined) { const u = str(o.videoUrl, 2000); if (!u || !/^(?:https:\/\/|\/api\/media\/)/.test(u)) return "add_method_template videoUrl must be https or the survey's media library (/api/media/…)"; a.videoUrl = u; }
  if (a.template === "shelf_test" && !a.imageUrl) return "add_method_template shelf_test needs imageUrl — the shelf photo (ask for it; never invent one)";
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
    case "iat": {
      const [tA, tB] = a.targets ?? ["Flowers", "Insects"];
      const [good, bad] = a.attributes ?? ["Pleasant", "Unpleasant"];
      const [wA, wB] = a.targetWords ?? [["Rose", "Tulip", "Daisy", "Lily"], ["Wasp", "Moth", "Flea", "Gnat"]];
      const [wG, wX] = a.attributeWords ?? [["Joy", "Love", "Peace", "Gift"], ["Pain", "Hate", "War", "Filth"]];
      const stim: { code: string; label: string; group: "A" | "B" | "G" | "X" }[] = [
        ...wA.map((w, i) => ({ code: `a${i + 1}`, label: w, group: "A" as const })), ...wB.map((w, i) => ({ code: `b${i + 1}`, label: w, group: "B" as const })),
        ...wG.map((w, i) => ({ code: `g${i + 1}`, label: w, group: "G" as const })), ...wX.map((w, i) => ({ code: `x${i + 1}`, label: w, group: "X" as const })),
      ];
      /* compatible: left = A or good, right = B or bad;  incompatible: left = B or good, right = A or bad */
      const keyFor = (compatible: boolean) => Object.fromEntries(stim.map((x) => [x.code, x.group === "G" ? 1 : x.group === "X" ? 2 : (x.group === "A") === compatible ? 1 : 2]));
      const block = (code: string, role: string, compatible: boolean, stage: string) => q(code, "matrix_single", `${stage}: sort each word into the left or right category.`, {
        variant: "experimental.reaction_time", required: true,
        rows: stim.map((x) => ({ code: x.code, label: x.label })),
        options: [{ code: 1, label: `${compatible ? tA : tB} or ${good}` }, { code: 2, label: `${compatible ? tB : tA} or ${bad}` }],
        settings: { iatBlock: { role, key: keyFor(compatible) } },
      });
      const qs = [block("IAT_B3", "compatible_practice", true, "Practice"), block("IAT_B4", "compatible_test", true, "Test"), block("IAT_B6", "incompatible_practice", false, "Practice"), block("IAT_B7", "incompatible_test", false, "Test")];
      return {
        title: `IAT (${tA} / ${tB} × ${good} / ${bad})`,
        questions: qs,
        block: { type: "block", id: ids("b"), title: "Implicit association", children: qs.map((x, i) => page(["Combined practice", "Combined test", "Reversed practice", "Reversed test"][i], [x])) } as FlowNode,
        tests: [{ method: "iat_dscore", variables: ["IAT_D"], priority: 1, tier: "essential", hypotheses: [], reason: "the implicit association: mean D-score against 0 and its strength", options: { variable: "IAT_D", excluded: "IAT_EXCLUDED" } }],
        notes: ["The four combined blocks are scored (IAT_D, D600); the single-category practice blocks and pairing-order counterbalancing are not added."],
      };
    }
    case "shelf_test": {
      const products = a.products ?? ["Product 1", "Product 2", "Product 3"];
      const w = 96 / products.length;
      const shelfQ = q("SHELF", "image_select", `Imagine you are shopping for ${product}. Which one would you buy?`, {
        variant: "hotspot.shelf",
        options: products.map((name, i) => ({ code: `p${i + 1}`, label: name, meta: { region: { x: Math.round((2 + i * w + w * 0.05) * 10) / 10, y: 10, w: Math.round(w * 0.9 * 10) / 10, h: 80 } } })),
        settings: { imageUrl: a.imageUrl, maxSelections: 1, shelf: { secondPick: !!a.secondPick } },
        instruction: "Look at the shelf and click the product you would buy.",
      });
      return {
        title: `Shelf test of ${products.length} products`,
        questions: [shelfQ],
        block: { type: "block", id: ids("b"), title: "Shelf", children: [page("Shelf", [shelfQ])] } as FlowNode,
        tests: [{ method: "shelf_share", variables: [`${P}SHELF`], priority: 1, tier: "essential", hypotheses: [], reason: "share of choice and time to find per product" }],
        notes: ["The product regions are laid out evenly left to right — move them onto the products in the regions editor."],
      };
    }
    case "brand_funnel": {
      const brands = a.brands ?? ["Brand A", "Brand B", "Brand C", "Brand D"];
      const opts = brands.map((b, i) => ({ code: i + 1, label: b }));
      const cat = `${product === "this product" ? "this category" : product}`;
      const unaided = q("UNAIDED", "open_text", `When you think of ${cat}, which brand comes to mind first?`);
      const coded = q("UNAIDED_CODED", "calculated", "Unaided first mention, coded", { required: false, settings: { expression: `ai_classify(${P}UNAIDED, "${[...brands, "Other", "None"].join("|")}")` } });
      const answered = (x: Record<string, unknown>) => ({ type: "rule", source: { kind: "question", ref: String(x.id) }, operator: "answered" });
      const cf = (x: Record<string, unknown>) => ({ sourceQuestionId: String(x.id), filter: "selected", into: "options" });
      const aware = q("AWARE", "multi_select", `Which of these brands of ${cat} have you heard of?`, { options: [...opts, { code: 98, label: "None of these", flags: ["exclusive", "anchor_bottom"] }] });
      const consider = q("CONSIDER", "multi_select", "Which of them would you consider buying?", { carryForward: cf(aware), displayLogic: answered(aware) });
      const bought = q("PURCHASED", "multi_select", "Which of them have you bought in the last 3 months?", { carryForward: cf(consider), displayLogic: answered(consider) });
      const prefer = q("PREFER", "single_select", "And which one do you prefer most?", { carryForward: cf(aware), displayLogic: answered(aware) });
      return {
        title: `Brand funnel over ${brands.length} brands`,
        questions: [unaided, coded, aware, consider, bought, prefer],
        block: { type: "block", id: ids("b"), title: "Brand funnel", children: [page("Unaided awareness", [unaided, coded]), page("Aided awareness", [aware]), page("Consideration", [consider]), page("Purchase", [bought]), page("Preference", [prefer])] } as FlowNode,
        tests: [
          { method: "brand_funnel", variables: [`${P}AWARE`, `${P}CONSIDER`, `${P}PURCHASED`, `${P}PREFER`], priority: 1, tier: "essential", hypotheses: [], reason: "aided awareness → consideration → purchase → preference, and the conversion between stages, by brand" },
          { method: "frequencies", variables: [`${P}UNAIDED_CODED`], priority: 2, tier: "recommended", hypotheses: [], reason: "unaided first mention (top of mind), coded by the AI classification" },
        ],
        notes: ["UNAIDED_CODED is resolved by the AI classification at runtime (needs the AI service); every other stage is plain data."],
      };
    }
    case "ad_test": {
      const brands = a.brands ?? ["Our brand", "Competitor 1", "Competitor 2"];
      const ad = q("AD_LIKE", "numeric", "Please watch this ad to the end. How much did you like it?", { variant: "media.video_rating", settings: { minValue: 1, maxValue: 5, requireComplete: true, ratingType: "stars", ...(a.videoUrl ? { mediaUrl: a.videoUrl } : {}) } });
      const recallOpen = q("RECALL_OPEN", "open_text", "Which brand was the ad for?");
      const recallCoded = q("RECALL_CODED", "calculated", "Unaided brand recall, coded", { required: false, settings: { expression: `ai_classify(${P}RECALL_OPEN, "${[...brands, "Other", "Don't know"].join("|")}")` } });
      const recallAided = q("RECALL_AIDED", "single_select", "And which of these brands was it?", { options: [...brands.map((b, i) => ({ code: i + 1, label: b })), { code: 99, label: "Don't know" }] });
      const diag = q("AD_DIAG", "matrix_single", "How much do you agree with each statement about the ad?", {
        rows: [["relevant", "It is relevant to me"], ["believable", "It is believable"], ["different", "It is different from other ads"], ["clear", "Its message is clear"], ["brand_fit", "It fits the brand"]].map(([code, label]) => ({ code, label })),
        options: [{ code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" }, { code: 3, label: "Neither" }, { code: 4, label: "Agree" }, { code: 5, label: "Strongly agree" }],
      });
      const intent = q("AD_INTENT", "single_select", `After seeing the ad, how likely are you to buy ${brands[0]}?`, { options: LIKELY_5 });
      return {
        title: "Ad test (forced exposure, recall, likeability, diagnostics)",
        questions: [ad, recallOpen, recallCoded, recallAided, diag, intent],
        block: { type: "block", id: ids("b"), title: "Ad test", children: [page("The ad", [ad]), page("Recall", [recallOpen, recallCoded]), page("Aided recall", [recallAided]), page("Diagnostics", [diag, intent])] } as FlowNode,
        tests: [
          { method: "frequencies", variables: [`${P}RECALL_CODED`, `${P}RECALL_AIDED`], priority: 1, tier: "essential", hypotheses: [], reason: "correct brand recall, unaided (AI-coded) and aided" },
          { method: "mean", variables: [`${P}AD_LIKE`], priority: 1, tier: "essential", hypotheses: [], reason: "likeability" },
          { method: "top_box", variables: [`${P}AD_DIAG`, `${P}AD_INTENT`], priority: 1, tier: "essential", hypotheses: [], reason: "top-2 box of the diagnostics and of purchase intent" },
        ],
        notes: [a.videoUrl ? "The ad must play to the end before the rating (requireComplete)." : "Set the ad video on AD_LIKE (Properties → media) — it must play to the end before the rating."],
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
