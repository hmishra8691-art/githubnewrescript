import type { SurveyAction, OptionSpec, ScaleSpec } from "./surveyActions.js";

/**
 * THE RESEARCH METHODOLOGY ENGINE (2026-11-09 — Rapid Studio phase 2).
 *
 * A researcher explains the business problem; the engine says what KIND of study it is, which method fits, why, what
 * else could be used and what each costs, what is missing — and warns when the method the researcher proposed does
 * not answer their question. Then it builds the study with the engines that already exist:
 *
 *   method templates     add_method_template (Van Westendorp, adaptive Gabor–Granger, sequential monadic, IAT, shelf,
 *                        brand funnel, ad test) — questions, logic, randomization and the analysis plan items
 *   designs              create_conjoint (CBC / ACBC / menu / rating-based CVA) and create_maxdiff — the real
 *                        generators (@rescript/designs through the registry), checked for feasibility and efficiency
 *   blueprints           standard question sets written here (CX, employee, U&A, segmentation, media, opinion …) as
 *                        ordinary create_block / create_question actions
 *
 * Everything it writes goes through applySurveyActions — the same gate, preview, undo and audit as Intelligent Mode —
 * and the analysis framework is the engine's own (built from what was written). Deterministic: no model invents a
 * design parameter or a sample size. Extensible: a methodology is one entry in STUDY_METHODOLOGIES.
 */

export type StudyCategory = "pricing" | "product" | "brand" | "advertising" | "employee" | "customer" | "segmentation" | "usage" | "shopper" | "healthcare" | "opinion" | "media" | "market_entry" | "innovation";
export const CATEGORY_NAMES: Record<StudyCategory, string> = {
  pricing: "Pricing & price sensitivity", product: "Product & concept testing", brand: "Brand research", advertising: "Advertising & communication",
  employee: "Employee & organisational", customer: "Customer experience (CX, CSAT, NPS)", segmentation: "Market segmentation", usage: "Usage & attitude (U&A)",
  shopper: "Shopper & retail", healthcare: "Healthcare", opinion: "Political & public opinion", media: "Media, entertainment & audience",
  market_entry: "Market entry & competitive intelligence", innovation: "Product innovation",
};

export interface MethodInput { key: string; label: string; kind: "text" | "list" | "prices" | "attributes" | "number"; required?: boolean; example?: string }
export interface MethodInputs { product?: string; currency?: string; prices?: number[]; concepts?: string[]; brands?: string[]; items?: string[]; attributes?: { name: string; levels: string[] }[]; statements?: string[]; organisation?: string; sample?: number; minutes?: number }
export interface Methodology {
  id: string;
  name: string;
  category: StudyCategory;
  fit: string;
  strengths: string[];
  tradeoffs: string[];
  /** what the objective says when this method fits (weighted) */
  signals: [RegExp, number][];
  inputs: MethodInput[];
  /** completes needed: per cell / in total, and why */
  sample: { min: number; perCell?: boolean; note: string };
  loi: string;
  analysis: string[];
  alternatives: string[];
  build(i: MethodInputs): SurveyAction[];
}

/* ------------------------------------------------------------ blueprint helpers */

const block = (title: string): SurveyAction => ({ op: "create_block", title } as SurveyAction);
const q = (b: string, type: string, text: string, extra: { options?: OptionSpec[]; rows?: string[]; scale?: ScaleSpec; code?: string; required?: boolean; randomize?: boolean; validation?: { kind: string; value?: number }[] } = {}): SurveyAction =>
  ({ op: "create_question", block: b, newPage: true, type, text, required: extra.required ?? true, ...extra } as SurveyAction);
const agree5: ScaleSpec = { points: 5, low: "Strongly disagree", high: "Strongly agree" };
const sat5: ScaleSpec = { points: 5, low: "Very dissatisfied", high: "Very satisfied" };
const likely5: ScaleSpec = { points: 5, low: "Definitely would not", high: "Definitely would" };
const imp5: ScaleSpec = { points: 5, low: "Not at all important", high: "Extremely important" };
const P = (i: MethodInputs, fallback: string) => (i.product?.trim() || fallback);
const list = (xs: string[] | undefined, fallback: string[]) => (xs?.filter((x) => x.trim()).length ? xs.filter((x) => x.trim()) : fallback);
const none = (label = "None of these"): OptionSpec => ({ label, exclusive: true, anchor: true });
const freq: OptionSpec[] = ["Daily", "Several times a week", "Weekly", "Monthly", "Less often", { label: "Never", exclusive: true }];
const brandsOf = (i: MethodInputs) => list(i.brands, ["Brand A", "Brand B", "Brand C", "Brand D"]);

/* ------------------------------------------------------------ the registry */

const tpl = (template: string, extra: Record<string, unknown>): SurveyAction[] => [{ op: "add_method_template", template, ...extra } as SurveyAction];

export const STUDY_METHODOLOGIES: Methodology[] = [
  /* ---- pricing ---- */
  { id: "van_westendorp", name: "Van Westendorp Price Sensitivity Meter", category: "pricing",
    fit: "the acceptable price range for one product or concept, early in pricing", strengths: ["four short questions", "a readable acceptable range and an optimal point", "works without a competitive set"], tradeoffs: ["stated, not chosen — no competitive context", "no demand or revenue curve without the NMS purchase-likelihood pair"],
    signals: [[/\b(?:price range|acceptable price|price sensitivity|too (?:cheap|expensive)|what (?:price|should we charge)|how much (?:to|should we) charge|price point|pricing)\b/, 2], [/\bnew (?:product|service|subscription|plan)\b/, 1], [/\bhow much (?:\w+ ){0,3}?(?:would|will|do|are|might|could)\b.{0,40}\bpay\b|\bwilling(?:ness)? to pay\b|\bwhat (?:\w+ ){0,3}would pay\b/, 2], [/\bvan ?westendorp|psm\b/, 4]],
    inputs: [{ key: "product", label: "What is being priced", kind: "text", required: true, example: "the Premium plan" }, { key: "currency", label: "Currency symbol", kind: "text", example: "$" }],
    sample: { min: 200, note: "about 200 completes for a stable range; 100+ per subgroup you will compare" }, loi: "≈ 2 minutes",
    analysis: ["PSM curves: point of marginal cheapness / expensiveness, optimal and indifference price points", "NMS demand and revenue curves from the purchase-likelihood pair"],
    alternatives: ["gabor_granger", "conjoint_pricing"], build: (i) => tpl("pricing_psm", { product: P(i, "the product"), ...(i.currency ? { currency: i.currency } : {}), nms: true }) },
  { id: "gabor_granger", name: "Adaptive Gabor–Granger", category: "pricing",
    fit: "demand at set price points and the revenue-maximising price", strengths: ["a demand curve and revenue curve", "adaptive ladder: few questions per respondent"], tradeoffs: ["price only — no features or competitors", "anchoring on the first price shown (start in the middle)"],
    signals: [[/\b(?:demand curve|price elasticity|elasticity|revenue[- ]?(?:maximi[sz]|optimal)|at which price|price points?|optimal price|gabor)\b/, 3], [/\b(?:price|pricing)\b/, 1]],
    inputs: [{ key: "product", label: "What is being priced", kind: "text", required: true }, { key: "prices", label: "Price ladder (3–20 prices)", kind: "prices", required: true, example: "5, 10, 15, 20, 25" }, { key: "currency", label: "Currency symbol", kind: "text" }],
    sample: { min: 200, note: "200+ completes for a smooth demand curve" }, loi: "≈ 1–2 minutes",
    analysis: ["demand (share who would buy) and revenue at each price", "price elasticity between neighbouring prices"],
    alternatives: ["van_westendorp", "conjoint_pricing"], build: (i) => tpl("price_ladder", { product: P(i, "the product"), prices: i.prices?.length ? i.prices : [5, 10, 15, 20, 25], start: "middle", ...(i.currency ? { currency: i.currency } : {}) }) },
  { id: "conjoint_pricing", name: "Choice-based conjoint with price (CBC)", category: "pricing",
    fit: "price trade-offs against features or competitors; willingness to pay; share simulation", strengths: ["realistic choices among products", "willingness to pay per feature", "what-if market simulation"], tradeoffs: ["needs a sound attribute and level list", "longer interview", "sample 300+"],
    signals: [[/\b(?:willing(?:ness)? to pay|wtp|price.{0,30}(?:feature|attribute|bundle|package|configuration|competitor)|(?:feature|bundle|package|tier).{0,30}price|trade[- ]?offs?)\b/, 3], [/\bpay for (?:each|every|the|different) (?:features?|options?|attributes?)\b|\bfeatures?\b.{0,60}\bcompetitors?\b/, 3], [/\bconjoint|cbc\b/, 4]],
    inputs: [{ key: "attributes", label: "Attributes and levels (include Price)", kind: "attributes", required: true, example: "Price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat" }],
    sample: { min: 300, note: "≈ 300+ completes (the design advice computes the minimum for your attributes and tasks)" }, loi: "≈ 6–10 minutes (10–12 choice tasks)",
    analysis: ["part-worth utilities (logit; HB at the individual level)", "attribute importance", "willingness to pay from the price coefficient", "market share simulator"],
    alternatives: ["van_westendorp", "gabor_granger", "acbc"], build: (i) => [{ op: "create_conjoint", method: "cbc", attributes: i.attributes ?? [], none: true, design: "efficient" } as SurveyAction] },
  { id: "direct_wtp", name: "Direct willingness to pay", category: "pricing",
    fit: "a quick read of the maximum price people state, with reasons", strengths: ["one question", "open, unprompted"], tradeoffs: ["stated maxima are inflated", "no demand curve"],
    signals: [[/\b(?:maximum (?:price|they would pay)|most (?:they|people) would pay)\b/, 3]],
    inputs: [{ key: "product", label: "What is being priced", kind: "text", required: true }, { key: "currency", label: "Currency symbol", kind: "text" }],
    sample: { min: 150, note: "150+ completes" }, loi: "≈ 1 minute", analysis: ["distribution of stated maximum price (median, quartiles)", "reasons, coded"],
    alternatives: ["van_westendorp", "gabor_granger"],
    build: (i) => { const b = "Willingness to pay"; return [block(b), q(b, "numeric", `What is the most you would pay for ${P(i, "this")}${i.currency ? ` (in ${i.currency})` : ""}?`, { validation: [{ kind: "min_value", value: 0 }] }), q(b, "long_text", "Why that amount?", { required: false })]; } },
  { id: "price_benchmark", name: "Competitive price benchmarking", category: "pricing",
    fit: "how your price is perceived against competitors", strengths: ["value-for-money map", "simple"], tradeoffs: ["perception, not demand"],
    signals: [[/\b(?:competitive|competitor'?s?) pric|price (?:perception|benchmark)|value for money\b/, 3]],
    inputs: [{ key: "brands", label: "Brands to compare", kind: "list", required: true }],
    sample: { min: 200, note: "200+ completes; 100+ per brand rated" }, loi: "≈ 3 minutes", analysis: ["price and value perception by brand", "value map (price vs quality perception)"],
    alternatives: ["conjoint_pricing"],
    build: (i) => { const b = "Price perception"; const br = brandsOf(i); return [block(b), q(b, "multi_select", "Which of these brands are you familiar with?", { options: [...br, none()] }), q(b, "matrix_single", "How would you rate each brand on price?", { rows: br, scale: { points: 5, low: "Very inexpensive", high: "Very expensive" } }), q(b, "matrix_single", "How would you rate each brand on value for money?", { rows: br, scale: { points: 5, low: "Very poor value", high: "Excellent value" } })]; } },

  /* ---- product & concept ---- */
  { id: "sequential_monadic", name: "Sequential monadic concept test", category: "product",
    fit: "several concepts, each rated in turn by every respondent", strengths: ["smaller sample than monadic", "within-person comparison", "order rotated and recorded"], tradeoffs: ["order and contrast effects (rotation controls them)", "fatigue past ~5 concepts"],
    signals: [[/\b(?:concepts?|ideas?|propositions?|designs?|variants?|packaging|flavou?rs?)\b.{0,40}\b(?:test|compare|evaluate|which (?:one|is best)|best)\b|\b(?:test|compare|evaluate)\b.{0,40}\b(?:concepts?|ideas?|propositions?|packaging|designs?)\b/, 3], [/\b(?:several|multiple|two|three|four|five|\d)\s+(?:concepts?|ideas?|designs?|variants?)\b/, 2], [/\bsequential monadic\b/, 4]],
    inputs: [{ key: "concepts", label: "Concepts (2–8 short names)", kind: "list", required: true }],
    sample: { min: 150, note: "≈ 150+ completes (every respondent sees every concept)" }, loi: "≈ 2 minutes per concept",
    analysis: ["mean and top-2-box per KPI by concept", "paired comparisons (within respondent)", "order effects check (the recorded order)"],
    alternatives: ["monadic", "comparative_concept"], build: (i) => tpl("sequential_monadic", { concepts: list(i.concepts, ["Concept A", "Concept B", "Concept C"]).slice(0, 8) }) },
  { id: "monadic", name: "Monadic concept test", category: "product",
    fit: "a clean read of each concept on its own, no contrast effects", strengths: ["no order or contrast bias", "each concept read as it would be met in market"], tradeoffs: ["one cell per concept — the sample multiplies", "between-person comparison only"],
    signals: [[/\bmonadic\b/, 4], [/\b(?:clean|unbiased|in isolation|on its own)\b.{0,30}\b(?:concept|read)\b/, 3]],
    inputs: [{ key: "concepts", label: "Concepts (each gets its own cell)", kind: "list", required: true }],
    sample: { min: 150, perCell: true, note: "≈ 150 completes PER concept cell" }, loi: "≈ 3 minutes",
    analysis: ["KPIs by cell (between groups; t / z tests)", "cell balance check"],
    alternatives: ["sequential_monadic"],
    build: (i) => { const cs = list(i.concepts, ["Concept A", "Concept B"]).slice(0, 8); const out: SurveyAction[] = []; for (const c of cs) { out.push(block(c), q(c, "single_select", `How appealing is ${c} to you?`, { scale: { points: 5, low: "Not at all appealing", high: "Extremely appealing" } }), q(c, "single_select", `How likely would you be to buy ${c}?`, { scale: likely5 }), q(c, "long_text", `What, if anything, do you like or dislike about ${c}?`, { required: false })); } out.push({ op: "create_randomizer", blocks: cs, show: 1, exact: true } as SurveyAction); return out; } },
  { id: "comparative_concept", name: "Comparative concept test / product preference", category: "product",
    fit: "which concept or product people prefer when they see them side by side", strengths: ["direct preference", "short"], tradeoffs: ["preference without absolute appeal", "position effects (options randomized)"],
    signals: [[/\b(?:prefer|preference)\b.{0,30}\b(?:product|concept|version|design|option)s?\b|\bside[- ]by[- ]side\b|\bhead[- ]to[- ]head\b/, 3]],
    inputs: [{ key: "concepts", label: "Concepts or products", kind: "list", required: true }],
    sample: { min: 200, note: "200+ completes" }, loi: "≈ 2 minutes", analysis: ["preference shares with confidence intervals", "reasons for preference, coded"], alternatives: ["sequential_monadic", "maxdiff"],
    build: (i) => { const b = "Preference"; const cs = list(i.concepts, ["Option A", "Option B"]); return [block(b), q(b, "single_select", "Which of these do you prefer?", { options: cs, randomize: true }), q(b, "long_text", "Why do you prefer it?", { required: false }), q(b, "ranking", "Please rank them from most to least preferred.", { options: cs })]; } },
  { id: "maxdiff", name: "MaxDiff (best–worst scaling)", category: "product",
    fit: "the relative importance or appeal of 8–30 features, benefits, claims or messages", strengths: ["strong discrimination — no 'everything is important'", "ratio-scaled scores comparable across markets", "individual-level scores"], tradeoffs: ["importance only — not traded against price", "needs a design"],
    signals: [[/\b(?:prioriti[sz]|most important|what matters most|rank|which (?:features?|benefits?|claims?|messages?))\b/, 2], [/\b(?:features?|benefits?|claims?|attributes?|messages?|statements?)\b.{0,40}\b(?:important|prioriti|value|matter|appeal)\b/, 3], [/\bmax ?diff|best[- ]worst\b/, 4]],
    inputs: [{ key: "items", label: "Items (8–30)", kind: "list", required: true }],
    sample: { min: 200, note: "≈ 200+ completes; 300+ for segment-level scores" }, loi: "≈ 4–6 minutes",
    analysis: ["best–worst scores and HB utilities (rescaled to probability)", "item ranking with confidence intervals", "TURF on top items (optional)"],
    alternatives: ["attribute_evaluation", "conjoint_pricing"], build: (i) => [{ op: "create_maxdiff", items: list(i.items, []) } as SurveyAction] },
  { id: "acbc", name: "Adaptive choice-based conjoint (ACBC)", category: "product",
    fit: "complex products with many attributes (7+), configurators, B2B purchases", strengths: ["handles many attributes", "engaging, adaptive to the respondent", "good with small samples"], tradeoffs: ["longest interview", "needs HB estimation"],
    signals: [[/\b(?:configur|build your own|many (?:features|attributes)|complex (?:product|purchase))\b/, 3], [/\bacbc|adaptive (?:choice|conjoint)\b/, 4]],
    inputs: [{ key: "attributes", label: "Attributes and levels", kind: "attributes", required: true }],
    sample: { min: 150, note: "≈ 150–300 completes (adaptive designs need fewer)" }, loi: "≈ 10–15 minutes", analysis: ["HB utilities", "attribute importance", "market simulator"],
    alternatives: ["conjoint_pricing", "menu_conjoint"], build: (i) => [{ op: "create_conjoint", method: "acbc", attributes: i.attributes ?? [] } as SurveyAction] },
  { id: "menu_conjoint", name: "Menu-based conjoint", category: "product",
    fit: "à-la-carte or bundle choices: which options people add, at which prices", strengths: ["mirrors a real configurator or menu", "bundle take rates"], tradeoffs: ["complex analysis", "sample 300+"],
    signals: [[/\b(?:menu|add[- ]?ons?|bundles?|à[- ]la[- ]carte|a la carte|options? (?:people|customers) (?:add|choose))\b/, 3]],
    inputs: [{ key: "attributes", label: "Menu items and their price levels (Item: price, price)", kind: "attributes", required: true }],
    sample: { min: 300, note: "300+ completes" }, loi: "≈ 8–12 minutes", analysis: ["take rate per item and price", "bundle simulation"],
    alternatives: ["conjoint_pricing"], build: (i) => [{ op: "create_conjoint", method: "menu", items: (i.attributes ?? []).map((a) => ({ name: a.name, prices: a.levels })) } as SurveyAction] },
  { id: "rating_conjoint", name: "Rating-based conjoint (CVA)", category: "product",
    fit: "few attributes with a small or specialist sample (doctors, B2B buyers)", strengths: ["works at n ≈ 50–100", "individual-level part-worths by regression"], tradeoffs: ["ratings, not choices — less realistic", "6 attributes at most"],
    signals: [[/\b(?:rating[- ]based conjoint|cva|small (?:sample|b2b)|specialists?|physicians?|doctors?)\b/, 2]],
    inputs: [{ key: "attributes", label: "Attributes and levels (≤ 6)", kind: "attributes", required: true }],
    sample: { min: 60, note: "≈ 60–100 completes" }, loi: "≈ 6–8 minutes", analysis: ["individual OLS part-worths", "attribute importance"],
    alternatives: ["acbc", "conjoint_pricing"], build: (i) => [{ op: "create_conjoint", method: "cva", attributes: i.attributes ?? [] } as SurveyAction] },
  /* Design Generators phase 2 (2026-11-09) */
  { id: "kano", name: "Kano model (feature classification)", category: "product",
    fit: "which features are expected, which add satisfaction in proportion and which delight — to prioritise a roadmap", strengths: ["separates must-haves from delighters", "Better / Worse coefficients for prioritising", "two short grids"], tradeoffs: ["classification, not a trade-off against price (pair with conjoint for that)", "the paired questions feel repetitive past ~15 features"],
    signals: [[/\bkano\b/, 5], [/\b(?:must[- ]haves?|must[- ]be|delighters?|delight|basic expectations?|nice[- ]to[- ]haves?)\b/, 3], [/\b(?:feature|roadmap|backlog)\b.{0,40}\b(?:prioriti[sz]|classif|categori[sz])/, 2]],
    inputs: [{ key: "items", label: "Features (2–20)", kind: "list", required: true }, { key: "product", label: "Product", kind: "text" }],
    sample: { min: 100, note: "≈ 100+ completes; 200+ to compare segments" }, loi: "≈ 1 minute per 3 features",
    analysis: ["Kano category per feature (Berger's evaluation table)", "category shares and strength", "Better / Worse coefficients (satisfaction gain / loss)"],
    alternatives: ["maxdiff", "attribute_evaluation"], build: (i) => tpl("kano", { features: list(i.items, ["Feature 1", "Feature 2", "Feature 3"]).slice(0, 20), importance: true, ...(i.product?.trim() ? { product: i.product.trim() } : {}) }) },
  { id: "attribute_evaluation", name: "Product attribute evaluation (importance × performance)", category: "product",
    fit: "how a product performs on what matters, to find fixes and strengths", strengths: ["importance–performance quadrant", "simple"], tradeoffs: ["stated importance discriminates poorly (use derived importance or MaxDiff)"],
    signals: [[/\b(?:attribute (?:evaluation|rating)|how (?:does|do) (?:our|the) product perform|strengths and weaknesses|importance.{0,20}performance)\b/, 3]],
    inputs: [{ key: "items", label: "Attributes", kind: "list", required: true }, { key: "product", label: "Product", kind: "text" }],
    sample: { min: 200, note: "200+ completes" }, loi: "≈ 4 minutes", analysis: ["importance–performance quadrant", "derived importance (key drivers) against overall satisfaction"], alternatives: ["maxdiff"],
    build: (i) => { const b = "Attributes"; const it = list(i.items, ["Quality", "Price", "Ease of use", "Design", "Support"]); return [block(b), q(b, "matrix_single", "How important is each of these to you?", { rows: it, scale: imp5 }), q(b, "matrix_single", `How well does ${P(i, "the product")} perform on each?`, { rows: it, scale: { points: 5, low: "Very poorly", high: "Very well" } }), q(b, "single_select", `Overall, how satisfied are you with ${P(i, "the product")}?`, { scale: sat5 })]; } },

  /* ---- brand ---- */
  { id: "brand_funnel", name: "Brand funnel (awareness → consideration → usage → preference)", category: "brand",
    fit: "where brands win and lose people from awareness to preference", strengths: ["stage conversions", "benchmarkable over time"], tradeoffs: ["describes, does not explain — add image attributes for the why"],
    signals: [[/\b(?:awareness|consideration|funnel|brand health|preference|brand usage|aided|unaided)\b/, 2], [/\bbrand\b/, 1]],
    inputs: [{ key: "brands", label: "Brands (2–15, yours first)", kind: "list", required: true }],
    sample: { min: 300, note: "≈ 300+ completes; 100+ aware of a brand to read its lower funnel" }, loi: "≈ 4 minutes",
    analysis: ["funnel by brand, conversion ratios", "significance vs competitors"], alternatives: ["brand_equity", "brand_tracking"], build: (i) => tpl("brand_funnel", { brands: brandsOf(i).slice(0, 15) }) },
  { id: "brand_equity", name: "Brand equity & positioning", category: "brand",
    fit: "what the brand stands for, against competitors, and how much that is worth", strengths: ["image association map", "equity index from funnel + image + advocacy"], tradeoffs: ["longer battery", "attribute list needs care"],
    signals: [[/\b(?:brand (?:equity|image|positioning|perception|associations?)|what (?:does )?(?:our|the) brand stand for|positioning)\b/, 3]],
    inputs: [{ key: "brands", label: "Brands", kind: "list", required: true }, { key: "statements", label: "Image attributes", kind: "list", example: "Trustworthy\nInnovative\nGood value" }],
    sample: { min: 300, note: "300+ completes" }, loi: "≈ 6 minutes", analysis: ["brand × attribute association (correspondence map)", "equity index", "NPS by brand"], alternatives: ["brand_funnel"],
    build: (i) => { const br = brandsOf(i); const st = list(i.statements, ["Trustworthy", "Innovative", "Good value for money", "High quality", "For people like me"]); return [...tpl("brand_funnel", { brands: br.slice(0, 15) }), block("Brand image"), ...st.map((s) => q("Brand image", "multi_select", `Which of these brands do you associate with “${s}”?`, { options: [...br, none("None of them")] })), q("Brand image", "nps", `How likely are you to recommend ${br[0]} to a friend or colleague?`)]; } },
  { id: "brand_tracking", name: "Brand tracker (multi-wave)", category: "brand",
    fit: "the same brand KPIs measured wave after wave, to see what moved", strengths: ["trend and significance between waves", "early warning"], tradeoffs: ["questions must stay identical between waves", "sample composition must be matched (quotas)"],
    signals: [[/\b(?:track(?:er|ing)?|waves?|over time|quarterly|monthly|every (?:month|quarter|year)|continuous)\b/, 3], [/\bbrand\b/, 1]],
    inputs: [{ key: "brands", label: "Brands", kind: "list", required: true }],
    sample: { min: 300, note: "300+ per wave, the same quotas every wave" }, loi: "≈ 6 minutes",
    analysis: ["KPIs per wave with wave-on-wave significance", "sample-composition check between waves"], alternatives: ["brand_funnel", "brand_equity"],
    build: (i) => [...tpl("brand_funnel", { brands: brandsOf(i).slice(0, 15) }), { op: "create_embedded", name: "WAVE", source: "url", value: "wave" } as SurveyAction] },

  /* ---- advertising ---- */
  { id: "ad_test", name: "Ad / creative pre-test", category: "advertising",
    fit: "whether an ad is noticed, branded, liked and persuasive before it runs", strengths: ["forced exposure, recall, diagnostics, intent"], tradeoffs: ["forced exposure overstates attention"],
    signals: [[/\b(?:ad|advert|advertisement|commercial|creative|tv spot|video ad|campaign creative)s?\b.{0,40}\b(?:test|work|effective|perform|before)\b|\bpre[- ]?test\b|\bcopy test\b/, 3]],
    inputs: [{ key: "brands", label: "Brands (advertised brand first)", kind: "list", required: true }],
    sample: { min: 150, perCell: true, note: "≈ 150 per ad cell" }, loi: "≈ 5 minutes", analysis: ["recall, brand linkage, likeability, diagnostics top-2-box, purchase intent"], alternatives: ["creative_comparison", "brand_lift"],
    build: (i) => tpl("ad_test", { brands: brandsOf(i).slice(0, 15) }) },
  { id: "creative_comparison", name: "Creative / message comparison", category: "advertising",
    fit: "which of several ads, messages or claims works best", strengths: ["each respondent rates several, rotated"], tradeoffs: ["contrast effects — rotation controls them"],
    signals: [[/\b(?:which|compare|several|multiple)\b.{0,30}\b(?:ads?|creatives?|messages?|executions?|taglines?|claims?)\b|\bmessage testing\b/, 3]],
    inputs: [{ key: "concepts", label: "Ads or messages", kind: "list", required: true }],
    sample: { min: 150, note: "150+ completes" }, loi: "≈ 2 minutes per creative", analysis: ["KPIs by creative, paired tests", "MaxDiff on messages when there are 8+"], alternatives: ["maxdiff", "ad_test"],
    build: (i) => tpl("sequential_monadic", { concepts: list(i.concepts, ["Ad A", "Ad B"]).slice(0, 8) }) },
  { id: "brand_lift", name: "Brand lift (exposed vs control)", category: "advertising",
    fit: "what a campaign changed: awareness, consideration, intent among exposed vs unexposed", strengths: ["causal read when cells are matched"], tradeoffs: ["needs a control group (exposure from the media partner or a randomized cell)"],
    signals: [[/\b(?:brand lift|campaign effectiveness|exposed|control group|did (?:the|our) campaign work|post[- ]?test|ad recall)\b/, 3]],
    inputs: [{ key: "brands", label: "Brands", kind: "list", required: true }],
    sample: { min: 200, perCell: true, note: "200+ exposed and 200+ control" }, loi: "≈ 4 minutes", analysis: ["lift in each funnel KPI exposed vs control, with significance", "recall"], alternatives: ["ad_test"],
    build: (i) => [{ op: "create_embedded", name: "EXPOSED", source: "url", value: "exposed" } as SurveyAction, ...tpl("brand_funnel", { brands: brandsOf(i).slice(0, 15) }), block("Recall"), q("Recall", "single_select", "Do you recall seeing any advertising for these brands recently?", { options: ["Yes", "No", { label: "Not sure", exclusive: true }] })] },

  /* ---- employee ---- */
  { id: "employee_engagement", name: "Employee engagement & eNPS", category: "employee",
    fit: "how engaged employees are, what drives it, and where to act", strengths: ["engagement index + eNPS", "drivers by department"], tradeoffs: ["anonymity must be guaranteed (minimum group sizes in reporting)"],
    signals: [[/\b(?:employees?|staff|workforce|engagement|enps|e-?nps|retention|morale|culture|leadership|internal communication|workplace)\b/, 3]],
    inputs: [{ key: "organisation", label: "Organisation name", kind: "text" }],
    sample: { min: 50, note: "a census where possible; report groups of 5+ only" }, loi: "≈ 8 minutes",
    analysis: ["engagement index and eNPS", "key drivers of engagement", "results by department (minimum 5 per group)"], alternatives: ["culture_survey"],
    build: (i) => { const org = i.organisation?.trim() || "the organisation"; const b = "Engagement", d = "Drivers"; return [block(b), q(b, "nps", `How likely are you to recommend ${org} as a place to work?`), q(b, "matrix_single", "How much do you agree with each statement?", { rows: ["I am proud to work here", "I would like to be working here in two years", "I am motivated to go beyond what is expected", "I feel valued for the work I do"], scale: agree5 }), block(d), q(d, "matrix_single", "How much do you agree with each statement?", { rows: ["My manager supports my development", "I have the tools I need to do my job well", "Communication from leadership is clear", "My workload is manageable", "I see a future for my career here"], scale: agree5 }), q(d, "long_text", "What one thing would most improve your experience at work?", { required: false })]; } },
  { id: "culture_survey", name: "Organisational culture & leadership", category: "employee",
    fit: "how the culture and leadership are experienced", strengths: ["values in practice, leadership effectiveness"], tradeoffs: ["statement lists need tailoring to your values"],
    signals: [[/\b(?:culture|values|leadership effectiveness|managers?|inclusion|belonging)\b/, 2]],
    inputs: [{ key: "statements", label: "Your values or culture statements", kind: "list" }],
    sample: { min: 50, note: "a census where possible" }, loi: "≈ 6 minutes", analysis: ["agreement by statement and group", "gap between stated and experienced values"], alternatives: ["employee_engagement"],
    build: (i) => { const b = "Culture"; const st = list(i.statements, ["People here are treated with respect", "Leaders act in line with our values", "I can speak up without fear", "Different perspectives are valued"]); return [block(b), q(b, "matrix_single", "How much do you agree with each statement?", { rows: st, scale: agree5 }), q(b, "matrix_single", "How would you rate your direct manager on…", { rows: ["Giving clear direction", "Recognising good work", "Supporting wellbeing", "Developing people"], scale: { points: 5, low: "Very poor", high: "Excellent" } })]; } },

  /* ---- customer ---- */
  { id: "nps_cx", name: "NPS with drivers (relationship CX)", category: "customer",
    fit: "loyalty and what drives it", strengths: ["benchmarkable KPI", "drivers and verbatims by NPS group"], tradeoffs: ["coarse on its own — the why questions matter"],
    signals: [[/\b(?:nps|net promoter|recommend|loyalty|customer experience|cx|churn)\b/, 3]],
    inputs: [{ key: "product", label: "Company or product", kind: "text", required: true }],
    sample: { min: 300, note: "300+ for a ±5-point NPS" }, loi: "≈ 4 minutes", analysis: ["NPS with margin of error", "key drivers of the score", "coded reasons by group"], alternatives: ["csat_ces"],
    build: (i) => { const b = "Loyalty"; const p = P(i, "us"); return [block(b), q(b, "nps", `How likely are you to recommend ${p} to a friend or colleague?`), q(b, "long_text", "What is the main reason for your score?", { required: false }), q(b, "matrix_single", `How satisfied are you with ${p} on…`, { rows: ["Product quality", "Price / value", "Customer service", "Ease of doing business", "Reliability"], scale: sat5 })]; } },
  { id: "csat_ces", name: "Transactional CSAT & customer effort", category: "customer",
    fit: "satisfaction and effort right after an interaction (support, purchase, onboarding)", strengths: ["actionable at the touchpoint"], tradeoffs: ["one interaction, not the relationship"],
    signals: [[/\b(?:csat|satisfaction|customer effort|ces|support|service (?:quality|experience)|touchpoint|after (?:a|the) (?:call|visit|purchase))\b/, 3]],
    inputs: [{ key: "product", label: "The interaction", kind: "text", example: "your support call" }],
    sample: { min: 200, note: "200+ per touchpoint" }, loi: "≈ 2 minutes", analysis: ["CSAT and CES top-2-box", "resolution rate", "drivers of dissatisfaction"], alternatives: ["nps_cx"],
    build: (i) => { const b = "Experience"; const p = P(i, "your recent experience"); return [block(b), q(b, "single_select", `Overall, how satisfied were you with ${p}?`, { scale: sat5 }), q(b, "single_select", "How easy was it to get what you needed?", { scale: { points: 7, low: "Very difficult", high: "Very easy" } }), q(b, "single_select", "Was your issue resolved?", { options: ["Yes", "Partly", "No"] }), q(b, "long_text", "What could we have done better?", { required: false })]; } },

  /* ---- segmentation, U&A, shopper ---- */
  { id: "segmentation", name: "Needs-based segmentation", category: "segmentation",
    fit: "groups of customers with different needs, attitudes or behaviour", strengths: ["targets the strategy", "a typing tool to classify new respondents"], tradeoffs: ["needs a 15–30 statement basis battery", "sample 600+", "segments must be validated"],
    signals: [[/\b(?:segment(?:ation|s)?|personas?|clusters?|types of (?:customers|users|buyers)|target groups?)\b/, 4]],
    inputs: [{ key: "statements", label: "Needs / attitude statements (15–30)", kind: "list", required: true }],
    sample: { min: 600, note: "≈ 600+ completes (≈ 100+ per expected segment)" }, loi: "≈ 10 minutes", analysis: ["factor analysis of the basis battery", "k-means / latent class clusters", "profiling and a typing tool"], alternatives: ["usage_attitude"],
    build: (i) => { const st = list(i.statements, ["I like to try new products", "Price is the most important thing", "I research a lot before I buy", "I stay loyal to brands I trust", "I want the best quality whatever the price"]); const chunks: string[][] = []; for (let k = 0; k < st.length; k += 8) chunks.push(st.slice(k, k + 8)); return [block("Needs and attitudes"), ...chunks.map((c, k) => q("Needs and attitudes", "matrix_single", `How much do you agree with each statement?${chunks.length > 1 ? ` (${k + 1} of ${chunks.length})` : ""}`, { rows: c, scale: agree5, randomize: true }))]; } },
  { id: "usage_attitude", name: "Usage & attitude (U&A)", category: "usage",
    fit: "how a category is used, by whom, when and why; attitudes and brands used", strengths: ["the category map", "sizing and occasions"], tradeoffs: ["broad — keep it to decisions you will make"],
    signals: [[/\b(?:usage|u&a|u and a|habits|how (?:people|consumers) use|occasions?|category (?:understanding|landscape)|consumption)\b/, 3]],
    inputs: [{ key: "product", label: "The category", kind: "text", required: true }, { key: "brands", label: "Brands in the category", kind: "list" }],
    sample: { min: 400, note: "400+ completes for subgroup reads" }, loi: "≈ 10 minutes", analysis: ["incidence and frequency", "occasions and repertoire", "attitudes by user type", "brand used most often"], alternatives: ["segmentation", "shopper_journey"],
    build: (i) => { const b = "Usage", a = "Attitudes"; const cat = P(i, "this category"); return [block(b), q(b, "single_select", `How often do you use ${cat}?`, { options: freq }), q(b, "multi_select", `On which occasions do you use ${cat}?`, { options: ["At home", "At work", "Travelling", "With friends", "Special occasions", { label: "Other", other: true }] }), q(b, "multi_select", "Which of these brands have you used in the past 3 months?", { options: [...brandsOf(i), none()] }), block(a), q(a, "matrix_single", `How much do you agree with each statement about ${cat}?`, { rows: ["It is an important part of my routine", "I enjoy trying new options", "I am happy with what is available today", "Price matters more than brand"], scale: agree5 })]; } },
  { id: "shopper_journey", name: "Shopper journey / path to purchase", category: "shopper",
    fit: "how people decide and buy: triggers, channels, in-store decisions", strengths: ["the decision journey", "channel and point-of-sale levers"], tradeoffs: ["recall of past purchase"],
    signals: [[/\b(?:shopper|path to purchase|purchase journey|in[- ]store|retail|aisle|shelf|point of sale|checkout|e-?commerce|channel)\b/, 3]],
    inputs: [{ key: "product", label: "Category", kind: "text", required: true }],
    sample: { min: 300, note: "300+ recent buyers" }, loi: "≈ 6 minutes", analysis: ["channel shares", "decision timing (planned vs in-store)", "triggers and barriers"], alternatives: ["usage_attitude"],
    build: (i) => { const b = "Last purchase"; const cat = P(i, "this category"); return [block(b), q(b, "single_select", `When did you last buy ${cat}?`, { options: ["In the past week", "In the past month", "1–3 months ago", "Longer ago"] }), q(b, "single_select", "Where did you buy it?", { options: ["Supermarket", "Convenience store", "Specialist store", "Online", { label: "Other", other: true }] }), q(b, "single_select", "When did you decide which product to buy?", { options: ["Before going shopping", "In the store / on the site", "Not sure"] }), q(b, "multi_select", "What influenced your choice?", { options: ["Price / promotion", "Brand I know", "Recommendation", "Packaging", "Reviews", { label: "Other", other: true }] })]; } },

  /* ---- healthcare, opinion, media, market entry, innovation ---- */
  { id: "patient_experience", name: "Patient / HCP experience", category: "healthcare",
    fit: "experience of care, treatment or a medical product among patients or professionals", strengths: ["validated-style experience domains"], tradeoffs: ["ethics, consent and adverse-event reporting rules apply"],
    signals: [[/\b(?:patients?|hcps?|physicians?|doctors?|nurses?|clinic|hospital|treatment|therapy|medic(?:al|ine)|pharma|healthcare)\b/, 3]],
    inputs: [{ key: "product", label: "Treatment, service or product", kind: "text" }],
    sample: { min: 100, note: "100+ (HCP studies are often 50–150)" }, loi: "≈ 8 minutes", analysis: ["experience domains top-2-box", "unmet needs"], alternatives: ["rating_conjoint"],
    build: (i) => { const b = "Experience"; const p = P(i, "your treatment"); return [block(b), q(b, "matrix_single", `Thinking about ${p}, how much do you agree…`, { rows: ["I understood the information I was given", "My concerns were listened to", "I was involved in decisions", "I knew what to do next"], scale: agree5 }), q(b, "single_select", `Overall, how would you rate ${p}?`, { scale: { points: 5, low: "Very poor", high: "Excellent" } }), q(b, "long_text", "What, if anything, could be improved?", { required: false })]; } },
  { id: "public_opinion", name: "Political & public opinion poll", category: "opinion",
    fit: "voting intention, issue salience and attitudes in a population", strengths: ["weighted to population targets"], tradeoffs: ["representative sample and weighting are essential", "question order effects"],
    signals: [[/\b(?:vote|voting|election|poll|public opinion|policy|government|party|candidate|referendum|citizens?)\b/, 4]],
    inputs: [{ key: "items", label: "Parties / candidates", kind: "list" }, { key: "statements", label: "Issues", kind: "list" }],
    sample: { min: 1000, note: "≈ 1,000 completes (±3 points), weighted to population" }, loi: "≈ 5 minutes", analysis: ["weighted vote intention with margins of error", "issue importance", "crosstabs by demographics"], alternatives: ["segmentation"],
    build: (i) => { const b = "Opinion"; return [block(b), q(b, "single_select", "If an election were held tomorrow, who would you vote for?", { options: [...list(i.items, ["Party A", "Party B", "Party C"]), { label: "Would not vote", exclusive: true }, { label: "Don't know", exclusive: true }], randomize: true }), q(b, "multi_select", "Which of these issues matter most to you? (up to 3)", { options: list(i.statements, ["Economy", "Health", "Education", "Environment", "Security"]) }), q(b, "single_select", "Is the country heading in the right direction or the wrong direction?", { options: ["Right direction", "Wrong direction", { label: "Don't know", exclusive: true }] })]; } },
  { id: "audience_media", name: "Media & audience research", category: "media",
    fit: "what people watch, read and listen to, where, and what they think of it", strengths: ["platform reach and frequency", "content appeal"], tradeoffs: ["self-reported consumption"],
    signals: [[/\b(?:audience|viewers?|listeners?|readers?|media|streaming|tv|radio|podcast|content|subscribers?|platforms?|entertainment)\b/, 3]],
    inputs: [{ key: "brands", label: "Platforms / channels / titles", kind: "list", required: true }],
    sample: { min: 400, note: "400+ completes" }, loi: "≈ 6 minutes", analysis: ["reach and frequency by platform", "duplication (TURF)", "content appeal"], alternatives: ["usage_attitude"],
    build: (i) => { const b = "Media"; const pl = brandsOf(i); return [block(b), q(b, "multi_select", "Which of these have you used in the past week?", { options: [...pl, none()] }), q(b, "matrix_single", "How often do you use each?", { rows: pl, scale: { points: 5, low: "Rarely", high: "Every day" } }), q(b, "single_select", "Which one would you miss most?", { options: pl })]; } },
  { id: "market_entry", name: "Market entry & competitive landscape", category: "market_entry",
    fit: "whether a market is worth entering: needs, competitors, barriers, interest and price", strengths: ["demand, barriers and competition in one study"], tradeoffs: ["interest overstates adoption — calibrate purchase intent"],
    signals: [[/\b(?:market entry|enter (?:a|the) (?:new )?market|new market|launch in|expansion|competitive (?:landscape|intelligence)|competitors?|market (?:size|opportunity))\b/, 3]],
    inputs: [{ key: "product", label: "The offer", kind: "text", required: true }, { key: "brands", label: "Competitors", kind: "list" }],
    sample: { min: 400, note: "400+ in the target market" }, loi: "≈ 8 minutes", analysis: ["incidence and current solutions", "competitor share and satisfaction", "interest and barriers", "price acceptance"], alternatives: ["van_westendorp", "usage_attitude"],
    build: (i) => { const b = "Market"; const p = P(i, "the offer"); return [block(b), q(b, "multi_select", "Which of these do you currently use?", { options: [...brandsOf(i), none()] }), q(b, "single_select", "How satisfied are you with what you use today?", { scale: sat5 }), q(b, "single_select", `How interested would you be in ${p}?`, { scale: { points: 5, low: "Not at all interested", high: "Extremely interested" } }), q(b, "multi_select", `What, if anything, would stop you from using ${p}?`, { options: ["Price", "Switching effort", "Trust in a new provider", "Happy with current option", { label: "Nothing", exclusive: true }, { label: "Other", other: true }] }), ...tpl("pricing_psm", { product: p, nms: true })]; } },
  { id: "innovation_screen", name: "Innovation screening (idea MaxDiff + purchase intent)", category: "innovation",
    fit: "which of many early ideas to take forward", strengths: ["screens 10–30 ideas efficiently", "intent on the winners"], tradeoffs: ["early ideas are described briefly — appeal, not demand"],
    signals: [[/\b(?:innovation|new ideas?|idea screening|pipeline|which ideas|ideation|nd(?:p)?|new product development)\b/, 3]],
    inputs: [{ key: "items", label: "Ideas (8–30)", kind: "list", required: true }],
    sample: { min: 300, note: "300+ completes" }, loi: "≈ 6 minutes", analysis: ["MaxDiff scores per idea", "purchase intent on the top ideas", "TURF for a portfolio"], alternatives: ["sequential_monadic", "maxdiff"],
    build: (i) => [{ op: "create_maxdiff", items: list(i.items, []) } as SurveyAction] },
];

const byId = new Map(STUDY_METHODOLOGIES.map((m) => [m.id, m]));


/* ------------------------------------------------------------ the recommendation */

/** a method named in the researcher's words — what they proposed */
const NAMED: [RegExp, string][] = [
  [/\bvan ?westendorp|\bpsm\b|price sensitivity meter/, "van_westendorp"], [/gabor|price ladder/, "gabor_granger"], [/\bacbc\b|adaptive (?:choice|conjoint)/, "acbc"],
  [/menu[- ]based/, "menu_conjoint"], [/rating[- ]based conjoint|\bcva\b/, "rating_conjoint"], [/\bconjoint\b|\bcbc\b/, "conjoint_pricing"], [/max ?diff|best[- ]worst/, "maxdiff"], [/\bkano\b/, "kano"],
  [/sequential monadic/, "sequential_monadic"], [/\bmonadic\b/, "monadic"], [/\bnps\b|net promoter/, "nps_cx"], [/\bcsat\b|\bces\b/, "csat_ces"], [/\bsegmentation\b/, "segmentation"],
  [/brand funnel/, "brand_funnel"], [/brand lift/, "brand_lift"], [/\bu ?& ?a\b|usage (?:and|&) attitude/, "usage_attitude"], [/\btracker\b/, "brand_tracking"],
];

/** why a proposed method does not answer the objective — the reasons a methodologist would give */
function misfit(proposed: Methodology, best: Methodology, text: string): string | null {
  if (proposed.id === best.id || best.alternatives.includes(proposed.id) || proposed.alternatives.includes(best.id) && proposed.category === best.category) return null;
  const t = text;
  if (proposed.id === "maxdiff" && best.category === "pricing") return "MaxDiff ranks items against each other; it cannot measure price sensitivity or willingness to pay. Price has to be traded off (conjoint) or asked directly (Van Westendorp / Gabor–Granger).";
  if (proposed.id === "nps_cx" && /\b(?:why|driver|improve|what (?:to|should we) fix)\b/.test(t)) return "NPS alone gives a score, not the reasons or the drivers — add driver ratings and the open why (the NPS-with-drivers design), or a key-driver analysis.";
  if (proposed.id === "van_westendorp" && /\b(?:feature|bundle|competitor|configuration)\b/.test(t)) return "Van Westendorp prices one concept in isolation; with features or competitors in the decision, price has to be traded off against them (conjoint).";
  if (proposed.category === "product" && best.category === "pricing") return `${proposed.name} measures appeal or preference, not what people will pay — the objective is about price.`;
  if (proposed.category !== best.category) return `${proposed.name} answers a different question (${CATEGORY_NAMES[proposed.category].toLowerCase()}) from the one in your objective (${CATEGORY_NAMES[best.category].toLowerCase()}).`;
  return null;
}

export interface MethodologyRecommendation {
  objective: string;
  category: StudyCategory;
  categoryName: string;
  recommended: Methodology;
  why: string[];
  alternatives: { method: Methodology; when: string }[];
  /** the method the researcher named, and why it does not fit (null when it does, or none was named) */
  proposed: { method: Methodology; fits: boolean; problem: string | null } | null;
  /** what the engine still needs to know */
  missing: string[];
  confidence: "high" | "medium" | "low";
}

export function recommendMethodology(objective: string): MethodologyRecommendation | null {
  const t = String(objective ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (t.length < 8) return null;
  const scored = STUDY_METHODOLOGIES.map((m) => ({ m, s: m.signals.reduce((a, [re, w]) => a + (re.test(t) ? w : 0), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const namedId = NAMED.find(([re]) => re.test(t))?.[1];
  const named = namedId ? byId.get(namedId) ?? null : null;
  /* the objective, without the method's own name, decides the best method (so naming a method cannot make it fit) */
  const stripped = NAMED.reduce((x, [re]) => x.replace(new RegExp(re.source, "g"), " "), t);
  const objScored = STUDY_METHODOLOGIES.map((m) => ({ m, s: m.signals.reduce((a, [re, w]) => a + (re.test(stripped) ? w : 0), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const top = objScored[0] ?? scored[0];
  if (!top) return named ? { objective, category: named.category, categoryName: CATEGORY_NAMES[named.category], recommended: named, why: [`You asked for ${named.name}: ${named.fit}.`], alternatives: named.alternatives.map((id) => byId.get(id)!).filter(Boolean).map((m) => ({ method: m, when: m.fit })), proposed: { method: named, fits: true, problem: null }, missing: missingFor(named, t), confidence: "low" } : null;
  /* a named method that fits the objective wins over an equally good unnamed one */
  let best = top.m;
  if (named && (named.id === top.m.id || top.m.alternatives.includes(named.id) || named.category === top.m.category)) best = named;
  const problem = named ? misfit(named, best, t) : null;
  if (named && problem === null && named.id !== best.id && named.category === best.category) best = named;
  const second = objScored[1];
  const confidence: MethodologyRecommendation["confidence"] = top.s >= 4 && (!second || top.s - second.s >= 2) ? "high" : top.s >= 3 ? "medium" : "low";
  const alternatives = [...new Set([...best.alternatives, ...objScored.slice(1, 4).map((x) => x.m.id)])].filter((id) => id !== best.id).map((id) => byId.get(id)!).filter(Boolean).slice(0, 3).map((m) => ({ method: m, when: m.fit }));
  return {
    objective, category: best.category, categoryName: CATEGORY_NAMES[best.category], recommended: best,
    why: [`It fits ${best.fit}.`, ...best.strengths.slice(0, 2).map((x) => `Strength: ${x}.`), `Trade-off to plan for: ${best.tradeoffs[0]}.`, `Sample: ${best.sample.note}. Interview: ${best.loi}.`],
    alternatives, proposed: named ? { method: named, fits: problem === null, problem } : null, missing: missingFor(best, t), confidence,
  };
}

function missingFor(m: Methodology, t: string): string[] {
  const out: string[] = [];
  for (const i of m.inputs.filter((x) => x.required)) out.push(`${i.label}${i.example ? ` (e.g. ${i.example.split("\n")[0]})` : ""}`);
  if (!/\b(?:customers?|users?|consumers?|people|respondents?|patients?|employees?|buyers?|aged|adults?|households?|b2b|decision makers?)\b/.test(t)) out.push("Who the respondents are (and any quotas)");
  if (!/\b\d{2,5}\s*(?:respondents?|completes|people|interviews|n\b)|\bn\s*=\s*\d+/.test(t)) out.push(`The sample you can afford (this method needs ${m.sample.note})`);
  return out;
}

/* ------------------------------------------------------------ design advice for conjoint / MaxDiff */

export interface DesignAdvice {
  method: "cbc" | "acbc" | "menu" | "cva" | "maxdiff";
  why: string;
  tasks: number;
  alternatives?: number;
  perTask?: number;
  versions: number;
  minSample: number;
  minutes: number;
  warnings: string[];
}

/**
 * The design that fits the attributes (or items) and the practical limits — with the minimum sample from the standard
 * rule of thumb for CBC main effects (Johnson & Orme: n ≥ 500·c / (t·a), c = the most levels of any attribute,
 * t = tasks, a = alternatives per task) and for MaxDiff (every item seen ≥ 3 times per respondent). The generators
 * themselves then build and check the design (feasibility, level balance, D-efficiency).
 */
export function designAdvice(x: { attributes?: { name: string; levels: string[] }[]; items?: string[]; menu?: boolean; sample?: number; maxMinutes?: number; specialist?: boolean }): DesignAdvice | null {
  const warnings: string[] = [];
  if (x.items?.length && !x.attributes?.length) {
    const n = x.items.length;
    if (n < 4) return null;
    const perTask = n <= 8 ? 3 : n <= 15 ? 4 : 5;
    const tasks = Math.min(30, Math.ceil((3 * n) / perTask));
    if (n > 30) warnings.push(`${n} items is a lot: use sparse MaxDiff (fewer appearances per respondent, more versions) or split into two exercises.`);
    const minutes = Math.round(tasks * 0.3 * 10) / 10;
    if (x.maxMinutes && minutes > x.maxMinutes) warnings.push(`≈ ${minutes} min of tasks exceeds your ${x.maxMinutes}-minute budget: fewer items or best-only answers.`);
    const minSample = n > 20 ? 300 : 200;
    if (x.sample && x.sample < minSample) warnings.push(`${x.sample} completes is below the ≈ ${minSample} a stable MaxDiff of ${n} items needs.`);
    return { method: "maxdiff", why: `${n} items: MaxDiff, ${perTask} per task, ${tasks} tasks so every item is seen about 3 times.`, tasks, perTask, versions: Math.min(300, Math.max(10, Math.ceil(n * 5))), minSample, minutes, warnings };
  }
  const attrs = (x.attributes ?? []).filter((a) => a.name.trim() && a.levels.filter((l) => l.trim()).length);
  if (!attrs.length) return null;
  const A = attrs.length, c = Math.max(...attrs.map((a) => a.levels.length));
  const bad = attrs.filter((a) => a.levels.length < 2);
  if (bad.length) warnings.push(`Every attribute needs at least two levels: ${bad.map((a) => a.name).join(", ")}.`);
  if (c > 7) warnings.push(`An attribute with ${c} levels inflates the sample needed and the number-of-levels effect — 2–7 levels is the usual range.`);
  const spread = Math.max(...attrs.map((a) => a.levels.length)) - Math.min(...attrs.map((a) => a.levels.length));
  if (spread >= 4) warnings.push("Very unequal level counts bias importance towards attributes with more levels; balance them where you can.");
  if (x.menu) return { method: "menu", why: "Items chosen à la carte with prices: menu-based conjoint.", tasks: 8, versions: 300, minSample: 300, minutes: 8, warnings };
  if (x.specialist || (x.sample && x.sample < 150 && A <= 6)) {
    const profiles = Math.max(12, Math.ceil(attrs.reduce((a, b) => a + b.levels.length - 1, 0) * 1.5) + 1);
    return { method: "cva", why: `A small or specialist sample (${x.sample ?? "specialists"}) with ${A} attributes: rating-based conjoint (CVA) estimates individual part-worths from ${profiles} rated profiles.`, tasks: profiles, versions: 1, minSample: 60, minutes: Math.round(profiles * 0.25), warnings };
  }
  if (A >= 7) {
    warnings.push(`${A} attributes in full profile overloads respondents; ACBC screens the levels each respondent cares about first.`);
    return { method: "acbc", why: `${A} attributes: adaptive CBC (ACBC) — build-your-own, screening and a choice tournament keep it manageable.`, tasks: 18, versions: 1, minSample: Math.max(150, x.sample ? 0 : 150), minutes: 12, warnings };
  }
  const alternatives = A >= 5 ? 3 : c >= 5 ? 4 : 3;
  let tasks = 12;
  const budget = x.maxMinutes ? Math.max(4, Math.floor((x.maxMinutes * 60 - 60) / 25)) : null;
  if (budget && budget < tasks) { tasks = Math.max(6, budget); warnings.push(`Your time budget allows about ${tasks} choice tasks (≈ 25 s each); fewer tasks raise the sample needed.`); }
  const minSample = Math.max(300, Math.ceil((500 * c) / (tasks * alternatives) / 10) * 10);
  if (x.sample && x.sample < minSample) warnings.push(`${x.sample} completes is below the ≈ ${minSample} this design needs for main effects (n ≥ 500·${c} / (${tasks}·${alternatives}), and 300 in practice) — add tasks, cut levels, or plan HB with caution.`);
  return { method: "cbc", why: `${A} attributes with up to ${c} levels: CBC, ${alternatives} concepts per task plus a None option, ${tasks} tasks.`, tasks, alternatives, versions: 300, minSample, minutes: Math.round(tasks * 25 / 60), warnings };
}

/* ------------------------------------------------------------ worked samples (2026-11-09) */

/**
 * A WORKED SAMPLE FOR EVERY METHODOLOGY: realistic inputs per category, so the method opens with a study the real
 * builder produces (questions, logic, design files, analysis plan) before the researcher types anything.
 */
const SAMPLE_BY_CATEGORY: Partial<Record<StudyCategory, MethodInputs>> = {
  pricing: { product: "the Premium plan", currency: "$", prices: [8, 10, 12, 14, 16, 18], brands: ["Our brand", "Competitor A", "Competitor B"] },
  product: { product: "the new snack bar", concepts: ["Oat & honey", "Dark chocolate", "Berry crunch"], items: ["Natural ingredients", "High protein", "Low sugar", "Recyclable pack", "Made locally", "Long shelf life", "Gluten free", "Kid-friendly taste", "Sharing size", "Under $2"] },
  brand: { product: "coffee shops", brands: ["Our brand", "Bean Co", "Daily Grind", "Roast House"] },
  advertising: { product: "the spring campaign", concepts: ["Ad A — family", "Ad B — humour", "Ad C — product demo"], brands: ["Our brand", "Competitor A"] },
  employee: { organisation: "Acme Ltd", statements: ["I am proud to work here", "My manager supports my development", "I see myself here in two years", "My workload is manageable"] },
  customer: { product: "our online store", brands: ["Our store"] },
  segmentation: { product: "home fitness", statements: ["I exercise to manage stress", "I prefer working out at home", "I follow fitness influencers", "Price matters more than brand", "I track everything with apps", "I work out with friends"] },
  usage: { product: "plant-based milk", brands: ["Oatly", "Alpro", "Store brand"] },
  shopper: { product: "breakfast cereal", brands: ["Brand A", "Brand B", "Brand C", "Store brand"] },
  healthcare: { product: "a once-weekly treatment", brands: ["Current standard", "New treatment"] },
  opinion: { product: "the city's transport plan" },
  media: { product: "the streaming service", brands: ["Show A", "Show B", "Show C"] },
  market_entry: { product: "electric scooters", brands: ["Lime", "Bird", "Tier"] },
  innovation: { product: "smart kitchen ideas", concepts: ["Fridge that orders groceries", "Self-cleaning oven", "Voice-guided recipes", "Waste tracker"], items: ["Saves time", "Saves money", "Healthier eating", "Less waste", "Easy to use", "Works with my phone", "Looks good", "Quiet", "Energy efficient", "Safe for kids"] },
};
const SAMPLE_ATTRIBUTES = parseAttributesLines("Monthly price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat\nDevices: 1, 3, Unlimited");
const SAMPLE_MENU = parseAttributesLines("Extra storage: $2, $4\nPriority support: $5, $9\nFamily sharing: $3, $6");
function parseAttributesLines(t: string) { return t.split("\n").map((l) => { const [n, r] = l.split(/:(.*)/s); return { name: n.trim(), levels: r.split(",").map((x) => x.trim()) }; }); }

export function sampleInputsFor(m: Methodology): MethodInputs {
  const base = SAMPLE_BY_CATEGORY[m.category] ?? {};
  const out: MethodInputs = { product: "the new product", currency: "$", prices: [5, 10, 15, 20, 25], concepts: ["Concept A", "Concept B", "Concept C"], brands: ["Our brand", "Competitor A", "Competitor B"], items: Array.from({ length: 10 }, (_, i) => `Feature ${i + 1}`), statements: ["Statement 1", "Statement 2", "Statement 3", "Statement 4"], organisation: "Acme", ...base };
  out.attributes = m.id === "menu_conjoint" ? SAMPLE_MENU : SAMPLE_ATTRIBUTES;
  for (const i of m.inputs) if (i.example && i.kind === "text") (out as Record<string, unknown>)[i.key] = i.example;
  return out;
}

/* ------------------------------------------------------------ reading the researcher's lists */

/** "Price: $9, $14, $19" per line → attributes */
export function parseAttributes(text: string): { name: string; levels: string[] }[] {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, rest] = l.split(/:(.*)/s);
    return { name: (name ?? "").trim(), levels: String(rest ?? "").split(/[,;|]/).map((x) => x.trim()).filter(Boolean) };
  }).filter((a) => a.name && a.levels.length);
}
export function parseList(text: string): string[] { return String(text ?? "").split(/\n|;/).map((x) => x.trim()).filter(Boolean); }
export function parsePrices(text: string): number[] { return String(text ?? "").split(/[,;\s]+/).map((x) => Number(x.replace(/[^\d.]/g, ""))).filter((n) => Number.isFinite(n) && n > 0); }
