/**
 * MASTER DEMO / CAPABILITY SHOWCASE SURVEY
 * "2026 Consumer Technology, Finance & Digital Lifestyle Study"
 *
 * A complete, intentionally programmed reference survey. Every question exists
 * to demonstrate one platform capability AND to feed a later one: the brands a
 * respondent selects drive carry-forward, list operations, List Fill, four
 * loops (selected / not-selected / invalid / count) with loop-scoped reference
 * tables, a nested loop, auto-punch, calculations, quotas, Conjoint, MaxDiff
 * and a custom design, and every one of those reaches the variable dictionary
 * and the exports.
 *
 * The programmer-facing commentary lives in each question's `notes` field
 * (`[DEMO: …]`), in block titles (`06_Loop_Demo`, …) and in `docs/MASTER-DEMO.md`.
 * Respondent-facing text stays clean; block titles are hidden from respondents
 * via `branding.layout.showBlockTitles = false`.
 *
 * Build: `buildMasterDemoSurvey(id)` → a parsed `SurveyDefinition`. The result
 * is deterministic (fixed design seeds), so two builds are byte-identical.
 */
import { SurveyDefinition, designGeneratorRegistry } from "@rescript/schema";
import type { FlowNode, LoopReferences } from "@rescript/schema";
import { registerBuiltinDesignGenerators } from "@rescript/designs";
import {
  AGREE_5, FREQ_6, LIKELY_5, SAT_5, YES_NO, and, block, calcRule, embeddedRule, loopRule, not, opts, or, page, rule,
  section, svgTile,
} from "./builders.js";
import type { OptSpec } from "./builders.js";

registerBuiltinDesignGenerators();

/* ============================================================ shared lists */

/** The brand list every later feature hangs off. Codes are stable identifiers. */
export const BRANDS: OptSpec[] = [
  { code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" },
  { code: 4, label: "Xiaomi" }, { code: 5, label: "OnePlus" }, { code: 6, label: "Sony" },
  { code: 7, label: "Microsoft" }, { code: 8, label: "Amazon" }, { code: 9, label: "Huawei" },
  { code: 10, label: "Lenovo" }, { code: 11, label: "Dell" }, { code: 12, label: "LG" },
];
const NONE_BRAND: OptSpec = { code: 98, label: "None of these", flags: ["exclusive", "none_of_above", "anchor_bottom"] };

/**
 * LOOP_001's reference table. It is written ONLY into the loop node
 * (`references`), never onto the brand question — see the §17 rule in the
 * loop engine. LOOP_003 / LOOP_004 / LOOP_LF carry their own, different tables.
 */
const LOOP_001_REFS: LoopReferences = {
  columns: [
    { name: "Brand_Nickname", dataType: "text", required: true, description: "Short internal name used in reports" },
    { name: "Product_ID", dataType: "text", required: true, description: "Client product master id" },
    { name: "Client_Code", dataType: "text", required: true },
    { name: "Category", dataType: "text", required: true, description: "Drives the category-specific question" },
    { name: "Internal_Name", dataType: "text" },
    { name: "Region", dataType: "text", description: "HQ region" },
    { name: "Product_Type", dataType: "text" },
  ],
  values: {
    "1": { Brand_Nickname: "APPLE", Product_ID: "PROD_001", Client_Code: "C001", Category: "Smartphone", Internal_Name: "BRAND_APPLE", Region: "North America", Product_Type: "Hardware" },
    "2": { Brand_Nickname: "SAMSUNG", Product_ID: "PROD_002", Client_Code: "C002", Category: "Smartphone", Internal_Name: "BRAND_SAMSUNG", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "3": { Brand_Nickname: "GOOGLE", Product_ID: "PROD_003", Client_Code: "C003", Category: "Smartphone", Internal_Name: "BRAND_GOOGLE", Region: "North America", Product_Type: "Software & Services" },
    "4": { Brand_Nickname: "XIAOMI", Product_ID: "PROD_004", Client_Code: "C004", Category: "Smartphone", Internal_Name: "BRAND_XIAOMI", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "5": { Brand_Nickname: "ONEPLUS", Product_ID: "PROD_005", Client_Code: "C005", Category: "Smartphone", Internal_Name: "BRAND_ONEPLUS", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "6": { Brand_Nickname: "SONY", Product_ID: "PROD_006", Client_Code: "C006", Category: "Audio & Entertainment", Internal_Name: "BRAND_SONY", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "7": { Brand_Nickname: "MICROSOFT", Product_ID: "PROD_007", Client_Code: "C007", Category: "Computing", Internal_Name: "BRAND_MICROSOFT", Region: "North America", Product_Type: "Software & Services" },
    "8": { Brand_Nickname: "AMAZON", Product_ID: "PROD_008", Client_Code: "C008", Category: "Smart Home", Internal_Name: "BRAND_AMAZON", Region: "North America", Product_Type: "Services" },
    "9": { Brand_Nickname: "HUAWEI", Product_ID: "PROD_009", Client_Code: "C009", Category: "Smartphone", Internal_Name: "BRAND_HUAWEI", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "10": { Brand_Nickname: "LENOVO", Product_ID: "PROD_010", Client_Code: "C010", Category: "Computing", Internal_Name: "BRAND_LENOVO", Region: "Asia-Pacific", Product_Type: "Hardware" },
    "11": { Brand_Nickname: "DELL", Product_ID: "PROD_011", Client_Code: "C011", Category: "Computing", Internal_Name: "BRAND_DELL", Region: "North America", Product_Type: "Hardware" },
    "12": { Brand_Nickname: "LG", Product_ID: "PROD_012", Client_Code: "C012", Category: "Home Appliances", Internal_Name: "BRAND_LG", Region: "Asia-Pacific", Product_Type: "Hardware" },
  },
};

const FEATURES = [
  { code: "battery", label: "Battery life" }, { code: "camera", label: "Camera" }, { code: "price", label: "Price" },
  { code: "design", label: "Design" }, { code: "support", label: "Customer support" },
];

const MAXDIFF_ITEMS = [
  "Battery life", "Camera quality", "Price", "Screen quality", "Brand reputation", "5G / connectivity",
  "Software updates", "Privacy & security", "Repairability", "Ecosystem integration", "Customer support", "Resale value",
];

const COUNTRIES = opts([
  "United States", "United Kingdom", "Germany", "France", "Spain", "Italy", "Netherlands", "Canada", "Australia",
  "India", "Japan", "Brazil", "Mexico", "South Africa", { code: 99, label: "Other country", flags: ["other_specify", "anchor_bottom"] },
]);

/* ============================================================ the builder */

export function buildMasterDemoSurvey(surveyId = "master-demo"): SurveyDefinition {
  const questions: Record<string, unknown>[] = [];
  /** Add a question. Notes carry the programmer-facing `[DEMO: …]` comment. */
  const Q = (q: Record<string, unknown>) => { questions.push(q); return q.id as string; };
  const single = (id: string, variableName: string, text: string, options: OptSpec[], extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "single_select", text, options, required: true, ...extra });
  const multi = (id: string, variableName: string, text: string, options: OptSpec[], extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "multi_select", text, options, required: true, ...extra });
  const numeric = (id: string, variableName: string, text: string, min: number, max: number, extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "numeric", text, required: true, settings: { minValue: min, maxValue: max, ...(extra.settings as object ?? {}) }, ...extra, });
  const open = (id: string, variableName: string, text: string, extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "long_text", text, ...extra });
  const info = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    Q({ id, variableName: id.toUpperCase(), type: "html", text, customHtml: text, ...extra });
  const hidden = (id: string, variableName: string, text: string, extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "hidden", text, ...extra });
  const calculated = (id: string, variableName: string, text: string, expression: string, extra: Record<string, unknown> = {}) =>
    Q({ id, variableName, type: "calculated", text, settings: { expression, hidden: true }, ...extra });

  /* ---------------------------------------------------------- designs */

  const conjointConfig = {
    attributes: [
      { name: "Brand tier", levels: ["Premium brand", "Mainstream brand", "Value brand"] },
      { name: "Price", levels: ["$399", "$599", "$799", "$999"] },
      { name: "Battery life", levels: ["1 day", "2 days", "3 days"] },
      { name: "Warranty", levels: ["1 year", "2 years", "3 years + accidental damage"] },
    ],
    tasks: 8, alternativesPerTask: 3, noneOption: true, holdoutTasks: 1, versions: 2,
  };
  const conjoint = designGeneratorRegistry.get("conjoint")!.generate(conjointConfig, 20260901);

  const maxdiffConfig = { items: MAXDIFF_ITEMS, itemsPerTask: 5, tasks: 9, versions: 2 };
  const maxdiff = designGeneratorRegistry.get("maxdiff")!.generate(maxdiffConfig, 20260902);

  const STATEMENTS = [
    "Technology makes my daily life easier",
    "I worry about how companies use my data",
    "I prefer to pay for products outright rather than subscribe",
    "I trust digital banks as much as traditional banks",
    "I upgrade my devices as soon as a new model is released",
    "Sustainability influences which brands I buy",
  ];
  const customConfig = {
    rows: 6,
    columnsSpec: [
      { name: "statement", kind: "random_level", levels: STATEMENTS },
      { name: "component", kind: "random_level", levels: ["Convenience", "Trust", "Value"] },
      { name: "level", kind: "random_int", min: 1, max: 3 },
      { name: "block", kind: "block", blockSize: 2 },
      { name: "stimulus", kind: "constant", value: "text" },
    ],
    versions: 1,
  };
  const custom = designGeneratorRegistry.get("custom")!.generate(customConfig, 20260903);

  const designs = [
    {
      id: "design_conjoint_phone", kind: "conjoint", name: "Smartphone CBC 2026", version: 1, seed: 20260901,
      config: conjointConfig,
      file: { format: "json", columns: conjoint.columns, rows: conjoint.rows, generatedAt: "2026-09-01T00:00:00.000Z" },
    },
    {
      id: "design_maxdiff_features", kind: "maxdiff", name: "Feature importance MaxDiff", version: 1, seed: 20260902,
      config: maxdiffConfig,
      file: { format: "json", columns: maxdiff.columns, rows: maxdiff.rows, generatedAt: "2026-09-01T00:00:00.000Z" },
    },
    {
      id: "design_custom_statements", kind: "custom", name: "Attitude statement rotation", version: 1, seed: 20260903,
      config: customConfig,
      file: { format: "json", columns: custom.columns, rows: custom.rows, generatedAt: "2026-09-01T00:00:00.000Z" },
    },
  ];

  /* ====================================================== 01 Introduction */

  info("info_welcome",
    "<h2>2026 Consumer Technology, Finance &amp; Digital Lifestyle Study</h2>" +
    "<p>Thank you for taking part. This study asks about the technology you own, the brands you know, how you pay for " +
    "things and how you feel about digital life. It takes about 20 minutes. Your answers are confidential and reported " +
    "only in aggregate.</p><p>Panel reference: <strong>{{ed.PANEL_ID}}</strong> · Source: {{ed.SOURCE}}</p>",
    { notes: "[DEMO: Embedded data piping] PANEL_ID and SOURCE are captured from the URL by the embedded_data flow node and piped with {{ed.X}}." });

  single("q_consent", "CONSENT", "Do you agree to participate in this research study?", opts(["Yes, I agree", "No, I do not agree"]), {
    notes: "[DEMO: Termination logic] Skip rule → terminate with status 'screened' when 2 is chosen.",
    skipLogic: [{ id: "skip_no_consent", label: "No consent → screened", when: rule("q_consent", "eq", 2), target: { kind: "terminate", status: "screened" } }],
  });
  single("q_confirm", "PARTICIPATION_OK", "Please confirm that you are completing this survey yourself and will answer honestly.", opts(["I confirm", "I cannot confirm"]), {
    notes: "[DEMO: Participation confirmation] Second gate; also demonstrates two terminating rules on one page.",
    skipLogic: [{ id: "skip_no_confirm", when: rule("q_confirm", "eq", 2), target: { kind: "terminate", status: "screened" } }],
  });
  numeric("q_age", "AGE", "How old are you?", 18, 100, {
    instruction: "Please enter your age in whole years (18–100).",
    validation: [{ kind: "integer", message: "Please enter a whole number of years." }],
    notes: "[DEMO: Numeric range validation + termination] minValue/maxValue 18–100, integer rule; under-18 is handled by the schema bound. AGE feeds the AGE_GROUP calculation and the age quotas.",
  });
  Q({
    id: "q_country", variableName: "COUNTRY", type: "dropdown", text: "Which country do you live in?", required: true, options: COUNTRIES,
    notes: "[DEMO: Dropdown + other-specify] 'Other country' opens a text field (COUNTRY_other). Drives option-level visibility of REGION.",
  });
  Q({
    id: "q_region", variableName: "REGION", type: "dropdown", text: "Which region do you live in?", required: true,
    displayLogic: rule("q_country", "in", [1, 2, 3, 8]),
    options: [
      { code: "us_ne", label: "Northeast", visibleIf: rule("q_country", "eq", 1) }, { code: "us_mw", label: "Midwest", visibleIf: rule("q_country", "eq", 1) },
      { code: "us_s", label: "South", visibleIf: rule("q_country", "eq", 1) }, { code: "us_w", label: "West", visibleIf: rule("q_country", "eq", 1) },
      { code: "uk_eng", label: "England", visibleIf: rule("q_country", "eq", 2) }, { code: "uk_sco", label: "Scotland", visibleIf: rule("q_country", "eq", 2) },
      { code: "uk_wal", label: "Wales", visibleIf: rule("q_country", "eq", 2) }, { code: "uk_ni", label: "Northern Ireland", visibleIf: rule("q_country", "eq", 2) },
      { code: "de_n", label: "Northern Germany", visibleIf: rule("q_country", "eq", 3) }, { code: "de_s", label: "Southern Germany", visibleIf: rule("q_country", "eq", 3) },
      { code: "de_e", label: "Eastern Germany", visibleIf: rule("q_country", "eq", 3) }, { code: "de_w", label: "Western Germany", visibleIf: rule("q_country", "eq", 3) },
      { code: "ca_e", label: "Eastern Canada", visibleIf: rule("q_country", "eq", 8) }, { code: "ca_w", label: "Western Canada", visibleIf: rule("q_country", "eq", 8) },
    ],
    notes: "[DEMO: Display logic + option-level visibility] Shown only for 4 countries; each option is visible only for its own country (option.visibleIf).",
  });
  Q({ id: "q_city", variableName: "CITY", type: "open_text", text: "Which city or town do you live in?", required: true,
    validation: [{ kind: "min_length", value: 2, message: "Please enter at least 2 characters." }, { kind: "max_length", value: 60 }],
    notes: "[DEMO: Text validation] min_length / max_length." });
  Q({
    id: "q_email", variableName: "EMAIL", type: "open_text", variant: "text.email", text: "What is your email address?",
    instruction: "Used only to send your incentive.", required: true,
    validation: [{ kind: "email", message: "Please enter a valid email address (name@example.com)." }],
    notes: "[DEMO: Email validation] kind 'email' + the text.email variant.",
  });
  single("q_contact_ok", "CONTACT_OK", "May we contact you about follow-up studies?", YES_NO, { notes: "[DEMO: Conditional required] Drives PHONE's visibility and its conditional required rule." });
  Q({
    id: "q_phone", variableName: "PHONE", type: "open_text", variant: "text.phone", text: "What phone number may we reach you on?",
    displayLogic: rule("q_contact_ok", "eq", 1),
    validation: [
      { kind: "required", when: rule("q_contact_ok", "eq", 1), message: "A phone number is required when you agree to be contacted." },
      { kind: "pattern", value: "^\\+?[0-9 ()-]{7,20}$", message: "Please enter digits, spaces, brackets or dashes only." },
    ],
    notes: "[DEMO: Display logic + conditional required + regex] Required only when CONTACT_OK = Yes; pattern validation.",
  });

  /* ====================================================== 02 Screening */

  const EMPLOYMENT = opts(["Employed full-time", "Employed part-time", "Self-employed / freelance", "Student", "Retired", "Unemployed / looking for work", { code: 99, label: "Other", flags: ["other_specify", "anchor_bottom"] }]);
  single("q_employment", "EMPLOYMENT", "Which of these best describes your current employment status?", EMPLOYMENT, {
    notes: "[DEMO: Skip logic → page] Retired / unemployed / student skip the work-profile page (industry, job level, company size) entirely.",
    skipLogic: [{ id: "skip_not_working", label: "Not working → skip work profile", when: rule("q_employment", "in", [4, 5, 6]), target: { kind: "page", ref: "p_demo_household" } }],
  });
  const DEVICES = opts(["Smartphone", "Laptop", "Desktop computer", "Tablet", "Smartwatch / fitness tracker", "Smart speaker", "Smart TV", "Games console", "E-reader", "VR / AR headset", "Home security camera", "Connected car", NONE_BRAND]);
  multi("q_devices", "DEVICES", "Which of the following devices do you personally own or use at least weekly?", DEVICES, {
    settings: { columnsLayout: 2 },
    notes: "[DEMO: Multi-select with 12 options + exclusive 'None' + termination] None terminates (no product ownership). Selected devices drive later display logic (wearables, smart home).",
    skipLogic: [{ id: "skip_no_devices", label: "No devices → screened", when: rule("q_devices", "selected", 98), target: { kind: "terminate", status: "screened" } }],
  });
  single("q_purchase_role", "PURCHASE_ROLE", "When technology is bought in your household, what is your role?", opts(["I make the decision alone", "I share the decision", "Someone else decides — I have no say"]), {
    notes: "[DEMO: Screening] No-say respondents are not terminated but are excluded from the pricing block by display logic.",
  });
  single("q_use_type", "USE_TYPE", "Do you use these devices mainly for personal purposes, for work, or both?", opts(["Personal use only", "Work / business use only", "Both personal and work"]), {
    notes: "[DEMO: Branching driver] The BRANCH node after screening routes Consumer / Business / Both to different blocks using this and EMPLOYMENT together.",
  });
  single("q_attention", "ATTENTION_CHECK", "This is an attention check. Please select “Agree” to continue.", AGREE_5, {
    settings: { expectedCodes: [4], onFail: "flag" },
    attentionCheck: { expected: [4] },
    notes: "[DEMO: Attention check] Graded by the quality engine; a miss becomes an explained flag, not a termination.",
  });

  /* ====================================================== 03 Demographics */

  single("q_gender", "GENDER", "How do you describe your gender?", opts(["Male", "Female", "Non-binary", { code: 99, label: "Prefer not to say", flags: ["anchor_bottom"] }]), {
    notes: "[DEMO: Quota driver] GENDER feeds quota_gender and the Gender × Age combined quota.",
  });
  numeric("q_hh_size", "HH_SIZE", "Including yourself, how many people live in your household?", 1, 20, { validation: [{ kind: "integer" }] });
  numeric("q_hh_children", "HH_CHILDREN", "How many of them are children under 18?", 0, 19, {
    validation: [
      { kind: "integer" },
      { kind: "custom_expression", value: "value < HH_SIZE", message: "Children must be fewer than the total household size." },
    ],
    notes: "[DEMO: Cross-question validation] custom_expression compares this answer (`value`) with HH_SIZE.",
  });
  Q({
    id: "q_income", variableName: "INCOME", type: "dropdown", text: "What is your total annual household income before tax?", required: true,
    options: opts(["Under $25,000", "$25,000 – $49,999", "$50,000 – $74,999", "$75,000 – $99,999", "$100,000 – $149,999", "$150,000 – $199,999", "$200,000 – $299,999", "$300,000 or more", { code: 98, label: "Don't know", flags: ["dont_know", "anchor_bottom"] }, { code: 99, label: "Prefer not to say", flags: ["refused", "anchor_bottom"] }]),
    notes: "[DEMO: Display-logic driver] Income ≥ $100k (codes 5–8) unlocks the investment questions in the finance page.",
  });
  single("q_education", "EDUCATION", "What is the highest level of education you have completed?", opts(["Some high school", "High school diploma", "Some college / vocational", "Associate degree", "Bachelor's degree", "Master's degree", "Doctorate / professional degree", { code: 99, label: "Prefer not to say", flags: ["anchor_bottom"] }]));
  Q({
    id: "q_industry", variableName: "INDUSTRY", type: "dropdown", text: "Which industry do you work in?", required: true,
    displayLogic: rule("q_employment", "in", [1, 2, 3]),
    options: opts(["Technology / software", "Financial services", "Healthcare", "Education", "Retail", "Manufacturing", "Government / public sector", "Media / entertainment", "Professional services", "Construction", "Transport / logistics", "Hospitality", "Energy / utilities", "Agriculture", { code: 99, label: "Other", flags: ["other_specify", "anchor_bottom"] }]),
    notes: "[DEMO: Display logic] Shown to employed respondents only (EMPLOYMENT in 1–3).",
  });
  single("q_job_level", "JOB_LEVEL", "Which best describes your level in your organisation?", opts(["Owner / C-level", "Senior management", "Middle management", "Team lead / supervisor", "Professional / specialist", "Administrative / support", "Entry level"]), {
    displayLogic: rule("q_employment", "in", [1, 2, 3]),
  });
  single("q_company_size", "COMPANY_SIZE", "Roughly how many people work at your organisation?", opts(["Just me", "2–9", "10–49", "50–249", "250–999", "1,000–4,999", "5,000 or more"]), {
    displayLogic: and(rule("q_employment", "in", [1, 2, 3]), rule("q_use_type", "in", [2, 3])),
    notes: "[DEMO: AND display logic] Employed AND uses devices for work.",
  });
  Q({
    id: "q_last_purchase", variableName: "LAST_PURCHASE_DATE", type: "date", text: "When did you buy your most recent technology device?", required: true,
    settings: { minDate: "2015-01-01", maxDate: "2026-12-31" },
    notes: "[DEMO: Date question + date bounds] minDate/maxDate; cross-checked against WARRANTY_END by a custom script.",
  });
  Q({
    id: "q_warranty_end", variableName: "WARRANTY_END", type: "date", text: "When does its warranty end (your best estimate)?",
    settings: { minDate: "2015-01-01", maxDate: "2032-12-31" },
    notes: "[DEMO: Cross-question date validation via custom JavaScript] The on_submit script blocks the page when this is before LAST_PURCHASE_DATE.",
  });
  Q({ id: "q_shop_time", variableName: "SHOP_TIME", type: "time", text: "At what time of day do you usually shop online?", notes: "[DEMO: Time question]" });
  multi("q_fin_products", "FIN_PRODUCTS", "Which of these financial products or services do you currently use?", opts(["Current / checking account", "Savings account", "Credit card", "Debit card", "Buy-now-pay-later", "Mobile wallet (Apple Pay, Google Pay…)", "Peer-to-peer payments", "Digital-only bank", "Investment / brokerage app", "Cryptocurrency exchange", "Personal loan", "Mortgage", "Insurance app", { code: 98, label: "None of these", flags: ["exclusive", "anchor_bottom"] }]), {
    settings: { columnsLayout: 2 },
    notes: "[DEMO: Multi-select with 13 options] Feeds N_FIN_PRODUCTS calculation and the finance display logic.",
  });

  /* --------------------------------------------- hidden demographics logic */
  calculated("h_age_group", "AGE_GROUP", "Derived age group",
    "if(AGE < 25, '18-24', if(AGE < 35, '25-34', if(AGE < 45, '35-44', '45+')))",
    { notes: "[DEMO: Hidden derived variable] Text calculation used by the age quotas and the Gender × Age cells." });
  calculated("h_eligible", "ELIGIBLE_FLAG", "Hidden eligibility flag",
    "if(CONSENT == 1 and PARTICIPATION_OK == 1 and AGE >= 18 and DEVICES_98 == 0, 1, 0)",
    { notes: "[DEMO: Hidden eligibility flag] Executes although never displayed — visibility ≠ execution." });

  /* ====================================================== 04 Technology usage + branches */

  Q({ id: "q_hours_online", variableName: "HOURS_ONLINE", type: "slider", text: "On a typical day, how many hours do you spend online (excluding work)?", required: true,
    settings: { minValue: 0, maxValue: 16, step: 0.5, sliderLeftLabel: "0 h", sliderRightLabel: "16 h" }, notes: "[DEMO: Slider with step and end labels]" });
  Q({
    id: "q_activities", variableName: "ACTIVITY", type: "matrix_single", text: "How often do you do each of the following?", required: true,
    rows: opts(["Stream video", "Stream music", "Online shopping", "Mobile banking", "Video calls", "Gaming", "Social media", "Smart-home control"]).map((o) => ({ code: `a${o.code}`, label: o.label })),
    options: FREQ_6,
    randomization: { enabled: true, scope: "rows", method: "shuffle" },
    notes: "[DEMO: Matrix single-select + row randomization] 8 rows × 6-point frequency scale; rows shuffled per respondent (seeded).",
  });
  Q({
    id: "q_apps", variableName: "APPS", type: "multi_dropdown", text: "Which of these app categories have you used in the past month?", required: true,
    options: opts(["Banking", "Payments", "Shopping", "Food delivery", "Ride hailing", "Fitness", "Meditation", "Streaming video", "Music", "Podcasts", "News", "Dating", "Travel", "Productivity", "Cloud storage"]),
    settings: { minSelections: 1, maxSelections: 8 },
    notes: "[DEMO: Multi-select dropdown + max selections]",
  });
  Q({
    id: "q_form_factor", variableName: "FORM_FACTOR", type: "image_select", text: "Which phone form factor appeals to you most?", required: true,
    settings: { maxSelections: 1 },
    options: [
      { code: "slab", label: "Classic slab", imageUrl: svgTile("Classic", "#2563eb") }, { code: "fold", label: "Foldable", imageUrl: svgTile("Foldable", "#7c3aed") },
      { code: "flip", label: "Flip", imageUrl: svgTile("Flip", "#db2777") }, { code: "compact", label: "Compact", imageUrl: svgTile("Compact", "#059669") },
    ],
    notes: "[DEMO: Image-based single choice] Inline SVG data URIs so the demo has no external assets.",
  });
  Q({
    id: "q_priority_rank", variableName: "PRIORITY_RANK", type: "ranking", text: "Rank your top 3 priorities when choosing a new device.", required: true,
    settings: { rankMode: "top_n", maxSelections: 3 },
    options: opts(["Price", "Battery life", "Camera", "Performance", "Design", "Brand", "Sustainability", "Privacy"]),
    randomization: { enabled: true, scope: "options", method: "shuffle" },
    notes: "[DEMO: Ranking (top-N) + randomized options] Ranked-first condition drives a follow-up open end.",
  });
  Q({ id: "q_nps_device", variableName: "NPS_DEVICE", type: "nps", text: "How likely are you to recommend your main device to a friend or colleague?", required: true,
    settings: { minValue: 0, maxValue: 10, npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely" }, notes: "[DEMO: NPS] Feeds the NPS_SEGMENT calculation and a conditional open end." });
  numeric("q_monthly_spend", "MONTHLY_SPEND", "Roughly how much do you spend per month on technology (devices, apps, subscriptions)?", 0, 5000, {
    instruction: "Enter a whole amount in your local currency.", validation: [{ kind: "integer" }],
    notes: "[DEMO: Numeric currency + piping source] MONTHLY_SPEND is piped inside the brand loop together with loop references (§41).",
  });
  numeric("q_sub_spend", "SUB_SPEND", "Of that, how much goes on subscriptions (streaming, cloud, software)?", 0, 5000, {
    validation: [{ kind: "custom_expression", value: "value <= MONTHLY_SPEND", message: "Subscriptions cannot exceed your total monthly spend." }],
    notes: "[DEMO: Cross-question validation] value ≤ MONTHLY_SPEND.",
  });
  numeric("q_hw_spend", "HW_SPEND", "And how much goes on hardware (averaged per month)?", 0, 5000, {
    validation: [{ kind: "custom_expression", value: "value + SUB_SPEND <= MONTHLY_SPEND", message: "Subscriptions plus hardware cannot exceed your total monthly spend." }],
    notes: "[DEMO: Cross-question validation] SUB_SPEND + HW_SPEND ≤ MONTHLY_SPEND (the §43 pattern).",
  });
  Q({
    id: "q_spend_split", variableName: "SPEND_SPLIT", type: "allocation", text: "What percentage of your technology spend goes to each category? (must total 100%)", required: true,
    settings: { sumTarget: 100, sumUnit: "%" },
    options: opts(["Devices", "Apps & software", "Streaming & media", "Cloud & storage", "Accessories"]),
    notes: "[DEMO: Allocation / constant sum] sumTarget 100.",
  });
  numeric("q_pct_online", "PCT_ONLINE", "What percentage of your technology purchases do you make online?", 0, 100, { validation: [{ kind: "integer" }], notes: "[DEMO: Percentage]" });
  Q({
    id: "q_spend_by_type", variableName: "SPEND_12M", type: "numeric_list", text: "Over the past 12 months, roughly how much did you spend on each of the following?",
    rows: [
      { code: "phone", label: "Phones", fieldType: "currency" }, { code: "computer", label: "Laptops / computers", fieldType: "currency" },
      { code: "wearable", label: "Wearables", fieldType: "currency" }, { code: "accessory", label: "Accessories", fieldType: "currency" },
    ],
    notes: "[DEMO: Numeric list] One currency field per row; summed by the TOTAL_SPEND_12M calculation.",
  });
  numeric("q_budget_next", "BUDGET_NEXT", "What is your total technology budget for the next 12 months?", 0, 50000, {
    validation: [{ kind: "custom_expression", value: "value >= SUB_SPEND * 12", message: "Your budget cannot be lower than a year of your current subscriptions." }],
    notes: "[DEMO: Logical validation] Compares against a derived value (12 × SUB_SPEND).",
  });
  single("q_smartwatch_sat", "WATCH_SAT", "How satisfied are you with your smartwatch or fitness tracker?", SAT_5, {
    displayLogic: rule("q_devices", "selected", 5),
    notes: "[DEMO: Skip pattern 'no product → skip satisfaction'] Shown only to wearable owners.",
  });
  single("q_smarthome_sat", "SMARTHOME_SAT", "How satisfied are you with your smart-home setup overall?", SAT_5, {
    displayLogic: or(rule("q_devices", "selected", 6), rule("q_devices", "selected", 11)),
    notes: "[DEMO: OR display logic] Smart speaker OR security camera owners.",
  });
  multi("q_invest", "INVEST_TYPES", "Which of these investments do you hold?", opts(["Stocks / shares", "ETFs / index funds", "Bonds", "Cryptocurrency", "Property", "Pension / retirement account", "Savings bonds", { code: 98, label: "None", flags: ["exclusive", "anchor_bottom"] }]), {
    displayLogic: and(rule("q_income", "in", [5, 6, 7, 8]), or(rule("q_fin_products", "selected", 9), rule("q_fin_products", "selected", 10))),
    notes: "[DEMO: Nested AND/OR display logic] income ≥ $100k AND (uses investment app OR crypto exchange).",
  });

  /* branch blocks (§26) */
  single("q_consumer_focus", "CONSUMER_FOCUS", "Which personal activity matters most to you when choosing technology?", opts(["Entertainment", "Staying in touch", "Health & fitness", "Learning", "Creativity", "Managing money"]), { notes: "[DEMO: Branch — Consumer path]" });
  single("q_business_function", "BUSINESS_FUNCTION", "Which business function do you mainly use technology for?", opts(["Communication", "Data & analytics", "Sales & CRM", "Design & content", "Operations", "Finance", "IT / engineering"]), { notes: "[DEMO: Branch — Business path]" });
  numeric("q_company_devices", "COMPANY_DEVICES", "How many devices does your employer provide to you?", 0, 20, { validation: [{ kind: "integer" }] });
  single("q_blend", "WORK_LIFE_BLEND", "How well do your personal and work technology fit together?", opts(["Very well — one seamless setup", "Reasonably well", "Poorly — I juggle separate tools", "I keep them deliberately separate"]), { notes: "[DEMO: Branch — Both path (combined section)]" });

  /* ====================================================== 05 Brand awareness & selection */

  Q({
    id: "q_unaided", variableName: "UNAIDED", type: "text_list", text: "Which technology brands come to mind first? List up to five.",
    rows: [1, 2, 3, 4, 5].map((n) => ({ code: `b${n}`, label: `Brand ${n}`, fieldType: "text" })),
    settings: { listCount: 5 },
    notes: "[DEMO: Text list] Unaided awareness; UNAIDED_b1…b5.",
  });
  multi("q_aware", "BRANDS_AWARE", "Which of these technology brands have you heard of?", [...BRANDS, NONE_BRAND], {
    settings: { columnsLayout: 2 },
    randomization: { enabled: true, scope: "options", method: "shuffle" },
    notes: "[DEMO: Multi-select, 12 brands, randomized, exclusive None] The awareness universe for every later brand list.",
  });
  multi("q_used", "BRANDS_USED", "Which of these brands have you personally used in the past 12 months?", BRANDS, {
    mask: { label: "show only the brands selected in BRANDS_AWARE", expr: { kind: "ref", questionId: "q_aware", selection: "selected" }, action: "display" },
    settings: { columnsLayout: 2 },
    displayLogic: not(rule("q_aware", "selected", 98)),
    notes: "[DEMO: Option masking (display only aware brands)] The full brand list is programmed here and masked to the BRANDS_AWARE selection, so the loops over this question know every code they can meet. THIS IS THE LOOP SOURCE for LOOP_001 (selected), LOOP_003 (not selected) and the List Fill.",
  });
  multi("q_trusted", "BRANDS_TRUSTED", "Which 2 to 5 of these brands do you trust the most?", [], {
    carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "options" },
    settings: { minSelections: 2, maxSelections: 5 },
    displayLogic: calcRule("N_AWARE", "gte", 2),
    notes: "[DEMO: Min/max selection validation + display logic on a calculation] Select 2–5; shown only when N_AWARE ≥ 2.",
  });
  single("q_fav_brand", "FAV_BRAND", "You said you have used {{BRANDS_USED.labels|and}}. Which is your favourite?", [], {
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "options" },
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Multi-select piping with a format modifier] {{BRANDS_USED.labels|and}} → 'Apple, Google and Samsung'.",
  });
  open("q_fav_why", "FAV_WHY", "Why is {{FAV_BRAND}} your favourite?", {
    required: true, displayLogic: rule("q_fav_brand", "answered"),
    validation: [{ kind: "min_length", value: 5, message: "Please tell us a little more (at least 5 characters)." }],
    notes: "[DEMO: Basic piping + open end] {{FAV_BRAND}} pipes the selected label.",
  });
  Q({
    id: "q_brand_agree", variableName: "BRAND_AGREE", type: "matrix_single", text: "How much do you agree that each brand offers good value for money?", required: true,
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "rows" }, options: AGREE_5,
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Carry-forward into matrix rows] Rows = used brands, 5-point agreement scale. BRAND_AGREE_<code>.",
  });
  Q({
    id: "q_brand_assoc", variableName: "BRAND_ASSOC", type: "matrix_multi", text: "Which of these words do you associate with each brand? (select all that apply)",
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "rows" },
    options: opts(["Innovative", "Reliable", "Expensive", "Good value", "Stylish", "Secure", "Sustainable"]),
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Matrix multi-select] BRAND_ASSOC_<brand>_<attr> 0/1 flags.",
  });
  Q({
    id: "q_years_used", variableName: "YEARS_USED", type: "matrix_numeric", text: "For how many years have you used each brand?", required: true,
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "rows" },
    columns: [{ id: "c_years", label: "Years", responseType: "numeric", variableStem: "YEARS_USED", min: 0, max: 80 }],
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Matrix numeric + custom-logic 'invalid' detection] A script flags any brand whose years exceed the respondent's AGE — those brands feed LOOP_005 (invalid-item loop).",
  });
  Q({
    id: "q_channel", variableName: "CHANNEL", type: "matrix_dropdown", text: "Where did you most recently buy from each brand?", required: true,
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "rows" },
    options: opts(["Brand's own store", "Brand website", "Carrier / operator", "Online marketplace", "Electronics retailer", "Second-hand"]),
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Matrix dropdown]",
  });
  Q({
    id: "q_one_word", variableName: "ONE_WORD", type: "matrix_text", text: "In one word, how would you describe each brand?",
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "rows" },
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Matrix text]",
  });
  single("q_detail_interest", "DETAIL_INTEREST", "Would you be willing to answer a few more detailed questions about the brands you use?", opts(["Yes", "No, take me to the shorter version"]), {
    notes: "[DEMO: Skip logic → section] 'No' skips the List Fill, list-operation and loop groups and lands on 11_Loop_Count.",
    skipLogic: [{ id: "skip_detail", label: "Not interested → skip detailed evaluation", when: rule("q_detail_interest", "eq", 2), target: { kind: "section", ref: "sec_11_loop_count" } }],
  });

  /* hidden list source built by a script (§31) */
  hidden("h_lf_source", "LF_SOURCE_LIST", "Hidden List Fill candidate list (trusted ∩ used, written by script)", {
    options: BRANDS,
    notes: "[DEMO: Hidden List Fill source] A hidden multi-code question whose answer is set by the 'Build hidden list source' script (used ∩ trusted). LF_TRUST reads it as its candidate list.",
  });

  /* ====================================================== 06 List Fill */

  hidden("h_lf_brand_1", "LF_BRAND_1", "List Fill destination 1 (allocated brand code)", { options: BRANDS, notes: "[DEMO: List Fill destination] Receives position 1 of LF_BRAND_EVAL as its answer." });
  hidden("h_lf_brand_2", "LF_BRAND_2", "List Fill destination 2 (allocated brand code)", { options: BRANDS, notes: "[DEMO: List Fill destination] Position 2; blank when only one item was allocated." });
  hidden("h_lf_topic", "LF_TOPIC", "Randomly assigned deep-dive topic", {
    options: [{ code: "privacy", label: "privacy" }, { code: "sustainability", label: "sustainability" }, { code: "repairability", label: "repairability" }, { code: "pricing", label: "pricing" }, { code: "customer_service", label: "customer service" }, { code: "innovation", label: "innovation" }],
    notes: "[DEMO: Random List Fill destination] LF_TOPIC assigns one of six topics at random (no sample tracking).",
  });
  single("q_lf_sat_1", "LF_SAT_1", "Thinking about {{LISTFILL_BRAND_EVAL_1}}, how satisfied are you overall?", SAT_5, {
    displayLogic: calcRule("LISTFILL_BRAND_EVAL_COUNT", "gte", 1),
    notes: "[DEMO: List Fill piping] {{LISTFILL_BRAND_EVAL_1}} is the label allocated to position 1 (priority → cap → quota → random fallback).",
  });
  single("q_lf_sat_2", "LF_SAT_2", "And {{LISTFILL_BRAND_EVAL_2}} — how satisfied are you overall?", SAT_5, {
    displayLogic: calcRule("LISTFILL_BRAND_EVAL_COUNT", "gte", 2),
    notes: "[DEMO: List Fill count-aware display] Only when two items were allocated (count = min(2, N_BRANDS_USED)).",
  });
  open("q_lf_topic_open", "TOPIC_OPEN", "You have been assigned the topic “{{LISTFILL_TOPIC_1}}”. What is the one thing technology brands should improve about {{LISTFILL_TOPIC_1}}?", {
    required: true, displayLogic: calcRule("LISTFILL_TOPIC_COUNT", "gte", 1),
    notes: "[DEMO: Randomized List Fill piping] The topic is allocated from a static list with method 'random'.",
  });
  single("q_lf_trust_pick", "TRUST_PICK", "Of the brands you both use and trust, {{LISTFILL_TRUST_1}} was chosen for you. Would you buy from {{LISTFILL_TRUST_1}} again?", LIKELY_5, {
    displayLogic: calcRule("LISTFILL_TRUST_COUNT", "gte", 1),
    notes: "[DEMO: List Fill from a hidden source] LF_TRUST's candidates come from the hidden LF_SOURCE_LIST question a script filled.",
  });
  /* the List-Fill-driven loop (LOOP_LF) — its own reference structure */
  Q({ id: "q_lf_loop_nps", variableName: "LF_NPS", type: "nps", text: "How likely are you to recommend {{loop.label}} ({{loop.Tier}} tier, {{loop.Segment}} segment)?", required: true,
    settings: { minValue: 0, maxValue: 10 },
    notes: "[DEMO: Loop over List Fill items + loop-scoped references] LOOP_LF iterates the allocated brands; Tier/Segment exist ONLY in LOOP_LF's table — LOOP_001 has different columns for the same brands." });
  open("q_lf_loop_why", "LF_WHY", "What is the main reason for your score for {{loop.label}}?", { notes: "[DEMO: Open end inside a List Fill loop]" });

  /* ====================================================== 07 List operations */

  single("q_curious", "CURIOUS_BRAND", "Of the brands you know but have not used, which are you most curious about?", BRANDS,
    {
      optionPipeline: [
        { id: "lo_aware_minus_used", kind: "difference", label: "aware(selected) − used(selected)", sources: [{ questionId: "q_aware", which: "selected" }, { questionId: "q_used", which: "selected" }] },
      ],
      displayLogic: calcRule("N_AWARE_NOT_USED", "gte", 1),
      notes: "[DEMO: List operation — DIFFERENCE] The full brand universe is programmed, then the pipeline keeps aware(selected) − used(selected). Shown only when the result is non-empty (N_AWARE_NOT_USED ≥ 1).",
    });
  multi("q_consider", "CONSIDER", "Which of these brands would you consider for your next purchase?", [],
    {
      optionPipeline: [
        { id: "lo_used", kind: "carry_forward", label: "start from used(selected)", sources: [{ questionId: "q_used", which: "selected" }] },
        { id: "lo_union_trusted", kind: "union", label: "∪ trusted(selected)", sources: [{ questionId: "q_trusted", which: "selected" }] },
        { id: "lo_dedupe", kind: "dedupe", label: "drop repeats", sources: [] },
      ],
      required: false, displayLogic: rule("q_used", "answered"),
      notes: "[DEMO: List operation — UNION + DEDUPE] used ∪ trusted, duplicates removed.",
    });
  single("q_core_brand", "CORE_BRAND", "Which of the brands you both use and trust would you call your core brand?", BRANDS,
    {
      optionPipeline: [
        { id: "lo_used_x_trusted", kind: "intersect", label: "used(selected) ∩ trusted(selected)", sources: [{ questionId: "q_used", which: "selected" }, { questionId: "q_trusted", which: "selected" }] },
      ],
      displayLogic: and(rule("q_used", "answered"), rule("q_trusted", "answered")),
      notes: "[DEMO: List operation — INTERSECT] used ∩ trusted.",
    });
  multi("q_never_seen", "NEVER_SEEN", "Which of these brands had you never heard of before today?", BRANDS,
    {
      optionPipeline: [
        { id: "lo_rem", kind: "remaining", label: "not in aware(selected)", sources: [{ questionId: "q_aware", which: "selected" }] },
      ],
      required: false, displayLogic: calcRule("N_AWARE", "lt", 12),
      notes: "[DEMO: List operation — REMAINING] Keeps the brands that appear in no source list — here, everything the respondent did not tick in BRANDS_AWARE.",
    });
  single("q_sorted_pick", "SORTED_PICK", "From this alphabetical list of the brands you use, which has the best customer service?", [], {
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "options" }, settings: { optionOrder: "az" },
    displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Ordered list] settings.optionOrder = 'az' sorts the carried list; the programmed order is never modified.",
  });
  single("q_random_three", "RANDOM_THREE", "Of these three brands (chosen at random from those you know), which would you research first?", [], {
    carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "options" },
    randomization: { enabled: true, scope: "options", method: "shuffle", pick: 3 },
    displayLogic: calcRule("N_AWARE", "gte", 3),
    notes: "[DEMO: Randomized list — pick N] Shuffle and present only 3 of the aware brands.",
  });
  multi("q_masked", "MASKED_SET", "Which of these brands would you recommend to a friend?", BRANDS, {
    mask: {
      label: "(used ∪ consider) ∩ aware",
      expr: {
        kind: "op", operator: "intersection",
        left: { kind: "op", operator: "union", left: { kind: "ref", questionId: "q_used", selection: "selected" }, right: { kind: "ref", questionId: "q_consider", selection: "selected" } },
        right: { kind: "ref", questionId: "q_aware", selection: "selected" },
      },
      action: "display",
    },
    required: false, displayLogic: rule("q_used", "answered"),
    notes: "[DEMO: Nested set expression (mask)] (used ∪ consider) ∩ aware — brackets the sequential pipeline cannot express.",
  });
  single("q_prioritized", "PRIORITIZED_PICK", "Which brand would you buy from tomorrow?", [], {
    carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "options" },
    listLogic: [{ id: "ll_fav_first", sourceQuestionId: "q_fav_brand", action: "prioritize", which: "selected" }],
    displayLogic: rule("q_fav_brand", "answered"),
    notes: "[DEMO: List logic — PRIORITIZE] The favourite brand floats to the top of the carried list.",
  });

  /* ====================================================== 08 LOOP_001 — selected brands (Block 2) */

  single("q_l1_familiar", "L1_FAMILIAR", "How familiar are you with {{CURRENT_ITEM}}?", opts(["Very familiar", "Somewhat familiar", "Heard of it only", "Not familiar"]), {
    notes: "[DEMO: LOOP_001 — CURRENT_ITEM piping] Repeats once per brand selected in BRANDS_USED; answers export as L1_FAMILIAR_1…N with LOOP_BRAND_ITEM_n_CODE as the join key.",
  });
  single("q_l1_freq", "L1_FREQ", "How frequently do you use {{CURRENT_ITEM}} products or services? (brand {{LOOP_INDEX}} of {{LOOP_COUNT}})", FREQ_6, {
    notes: "[DEMO: LOOP_INDEX / LOOP_COUNT piping]",
  });
  Q({ id: "q_l1_sat", variableName: "L1_SAT", type: "slider", text: "Please rate {{CURRENT_ITEM.Brand_Nickname}}, product {{CURRENT_ITEM.Product_ID}}, in the {{CURRENT_ITEM.Category}} category.", required: true,
    settings: { minValue: 0, maxValue: 100, sliderLeftLabel: "Poor", sliderRightLabel: "Excellent" },
    notes: "[DEMO: LOOP REFERENCES — several columns in one sentence] Brand_Nickname, Product_ID and Category are read from LOOP_001's own reference table." });
  open("q_l1_why", "L1_WHY", "Why do you use {{CURRENT_ITEM}}?", { required: true, notes: "[DEMO: Open end inside a loop] Exported per iteration." });
  Q({ id: "q_l1_nps", variableName: "L1_NPS", type: "nps", text: "How likely are you to buy from {{CURRENT_ITEM}} again?", required: true, settings: { minValue: 0, maxValue: 10 } });
  Q({
    id: "q_l1_attrs", variableName: "L1_ATTR", type: "matrix_single", text: "As a {{CURRENT_ITEM.Product_Type}} company headquartered in {{CURRENT_ITEM.Region}}, how does {{CURRENT_ITEM}} perform on…", required: true,
    rows: [{ code: "quality", label: "Product quality" }, { code: "value", label: "Value for money" }, { code: "innovation", label: "Innovation" }, { code: "trust", label: "Trustworthiness" }],
    options: opts(["Poor", "Fair", "Good", "Very good", "Excellent"]),
    notes: "[DEMO: References Product_Type + Region in question text; matrix inside a loop]",
  });
  single("q_l1_smartphone", "L1_PHONE_OS_SAT", "How satisfied are you with the software updates on your {{CURRENT_ITEM}} smartphone?", SAT_5, {
    displayLogic: loopRule("Category", "eq", "Smartphone"),
    notes: "[DEMO: Display logic on a loop reference] loop.Category = 'Smartphone' — only smartphone brands see this iteration question.",
  });
  Q({ id: "q_l1_spend_rate", variableName: "L1_SPEND_RATE", type: "slider", text: "Earlier you said you spend about {{MONTHLY_SPEND}} per month on technology. Given that, how good value is {{CURRENT_ITEM.Brand_Nickname}} (product {{CURRENT_ITEM.Product_ID}}) — and how does it compare with your favourite, {{FAV_BRAND}}?", required: true,
    settings: { minValue: 1, maxValue: 10, sliderLeftLabel: "Much worse value", sliderRightLabel: "Much better value" },
    notes: "[DEMO §41: Question piping + loop piping + calculated/previous answer in one text] MONTHLY_SPEND (earlier answer), CURRENT_ITEM.* (loop references), FAV_BRAND (earlier answer)." });
  single("q_l1_recommend", "L1_RECOMMEND", "Would you recommend {{CURRENT_ITEM}} to a friend?", YES_NO);
  single("q_l1_category_auto", "L1_CATEGORY", "Category classification for {{CURRENT_ITEM}} (auto-populated from the loop's reference data — read only)", opts([{ code: "phone", label: "Smartphone maker" }, { code: "computing", label: "Computing" }, { code: "other", label: "Other technology" }]), {
    settings: { readOnly: true }, required: false,
    punches: [
      { id: "punch_phone", label: "Category = Smartphone → phone", source: { kind: "codes", codes: ["phone"] }, action: "select", recompute: "always", when: loopRule("Category", "eq", "Smartphone") },
      { id: "punch_computing", label: "Category = Computing → computing", source: { kind: "codes", codes: ["computing"] }, action: "select", recompute: "always", when: loopRule("Category", "eq", "Computing") },
      { id: "punch_other", label: "otherwise → other", source: { kind: "codes", codes: ["other"] }, action: "select", recompute: "always", when: and(loopRule("Category", "ne", "Smartphone"), loopRule("Category", "ne", "Computing")) },
    ],
    notes: "[DEMO: Auto-punch from loop context / reference values + read-only field] Three punch rules keyed on loop.Category; the respondent sees the result but cannot change it.",
  });
  /* nested loop (§19) — inner = features, its own references */
  Q({ id: "q_l2_feature_rate", variableName: "L2_FEATURE", type: "slider", text: "Rate {{brand.label}} on {{feature.label}} ({{feature.Feature_Group}} group).", required: true,
    settings: { minValue: 1, maxValue: 7, sliderLeftLabel: "Weak", sliderRightLabel: "Strong" },
    notes: "[DEMO: NESTED LOOP piping] {{brand.label}} = outer item, {{feature.label}} = inner item, {{feature.Feature_Group}} = inner loop's reference. Exports as L2_FEATURE_<outer>_<inner>." });
  single("q_l2_feature_reason", "L2_REASON", "Is {{loop.label}} a reason you chose {{brand.Brand_Nickname}}?", YES_NO, {
    notes: "[DEMO: Nested loop — innermost via {{loop.*}}, outer via its loopVar] References of the outer loop (Brand_Nickname) and inner loop do not collide.",
  });

  /* ====================================================== 09 LOOP_003 — not-selected brands (Block 3) */

  multi("q_l3_why_not", "L3_WHY_NOT", "Why haven't you used {{CURRENT_ITEM}} in the past year?", opts(["Too expensive", "Don't trust the brand", "Not available where I live", "Happy with my current brand", "Poor past experience", "Don't know enough about it", "Not compatible with my other devices", "Ethical / political reasons", { code: 99, label: "Other reason", flags: ["other_specify", "anchor_bottom"] }]), {
    notes: "[DEMO: LOOP_003 — FOR EACH NOT-SELECTED brand] Source filter 'notSelected' on BRANDS_USED (aware but not used); at most 3 iterations in random order.",
  });
  single("q_l3_try", "L3_TRY", "How likely are you to try {{CURRENT_ITEM}} in the next 12 months?", LIKELY_5);
  open("q_l3_convince", "L3_CONVINCE", "{{loop.Reason_Prompt}}", { notes: "[DEMO: A whole question text from a reference column] LOOP_003's table carries a per-brand prompt (Reason_Prompt)." });

  /* ====================================================== 10 LOOP_004 (invalid filter) + LOOP_005 (invalid via script) */

  single("q_l4_aware_exit", "L4_EXIT_AWARE", "{{CURRENT_ITEM}} has stopped selling consumer devices in several markets since {{loop.Exit_Year}}. Were you aware of this?", opts(["Yes, I knew", "I had heard something", "No, I didn't know"]), {
    notes: "[DEMO: LOOP_004 — filter 'invalid'] Items are invalid when LOOP_004's invalidIf holds: loop.Market_Status = 'exited' (its own reference column). Here that marks Huawei and LG.",
  });
  single("q_l4_effect", "L4_EXIT_EFFECT", "Does that change how you feel about {{CURRENT_ITEM}}?", opts(["Much more negative", "Somewhat more negative", "No change", "More positive"]));

  numeric("q_l5_fix_years", "L5_FIX_YEARS", "You entered {{loop.label}} years for {{loop.Brand}}, which is more than your age ({{AGE}}). Please re-enter the number of years you have used {{loop.Brand}}.", 0, 100, {
    validation: [{ kind: "integer" }, { kind: "custom_expression", value: "value <= AGE", message: "Years cannot exceed your age." }],
    notes: "[DEMO: LOOP_005 — invalid items defined by custom logic] The years-used script writes INVALID_BRANDS as [{code, label: years}]; the loop source is that variable ({{loop.label}} = years entered) and the loop's own reference table supplies the Brand name.",
  });

  /* ====================================================== 11 LOOP_006 — count-based */

  numeric("q_n_products", "N_PRODUCTS", "How many individual technology products would you like to tell us about in detail? (1–5)", 1, 5, {
    validation: [{ kind: "integer" }],
    notes: "[DEMO: LOOP_006 — FOR i = 1 TO N_PRODUCTS] The loop's source is {kind:'count', count:{kind:'question', ref:'q_n_products'}}: answering 5 runs the block five times.",
  });
  Q({
    id: "q_l6_type", variableName: "L6_TYPE", type: "dropdown", text: "Product {{LOOP_INDEX}} of {{LOOP_COUNT}}: what type of product is it?", required: true,
    options: opts(["Smartphone", "Laptop", "Tablet", "Smartwatch", "Headphones", "Smart speaker", "TV", "Games console", "Camera", "Other"]),
    notes: "[DEMO: LOOP_INDEX in a count loop]",
  });
  Q({ id: "q_l6_name", variableName: "L6_NAME", type: "open_text", text: "What is the brand and model of product {{LOOP_INDEX}}?", required: true });
  numeric("q_l6_price", "L6_PRICE", "Roughly how much did product {{LOOP_INDEX}} cost?", 0, 20000);
  Q({ id: "q_l6_sat", variableName: "L6_SAT", type: "slider", text: "How satisfied are you with product {{LOOP_INDEX}}?", required: true, settings: { minValue: 0, maxValue: 10 } });

  /* ====================================================== 12 Randomization */

  multi("q_rand_anchor", "RAND_ANCHOR", "Which of these features do you use on your phone at least weekly?", opts(["Mobile payments", "Voice assistant", "Navigation", "Camera", "Health tracking", "Banking app", "Smart-home control", "Translation", "Screen sharing", "Password manager", { code: 98, label: "None of these", flags: ["exclusive", "anchor_bottom"] }, { code: 99, label: "Other", flags: ["other_specify", "anchor_bottom"] }]), {
    randomization: { enabled: true, scope: "options", method: "shuffle" },
    notes: "[DEMO: Randomized options with anchors] 10 shuffled options; None/Other anchored to the bottom.",
  });
  single("q_rand_rotate", "RAND_ROTATE", "Which of these payment methods do you use most often?", opts(["Cash", "Debit card", "Credit card", "Mobile wallet", "Bank transfer", "Buy-now-pay-later", "Cryptocurrency", "Prepaid card"]), {
    randomization: { enabled: true, scope: "options", method: "rotate" },
    notes: "[DEMO: Rotation] method 'rotate' — order preserved, start point varies per respondent.",
  });
  Q({
    id: "q_rand_half", variableName: "RAND_HALF", type: "matrix_single", text: "How much do you agree with each statement?", required: true,
    rows: STATEMENTS.map((s, i) => ({ code: `s${i + 1}`, label: s })), options: AGREE_5,
    randomization: { enabled: true, scope: "rows", method: "reverse_half" },
    notes: "[DEMO: reverse_half] Half the sample sees the statements in reverse order.",
  });
  multi("q_rand_pick", "RAND_PICK", "Which of these five features would you pay extra for?", opts(["Longer battery", "Better camera", "Faster charging", "More storage", "Water resistance", "Satellite messaging", "Foldable screen", "Stylus support", "Wireless charging", "Better speakers", "Under-display camera", "Titanium frame"]), {
    randomization: { enabled: true, scope: "options", method: "shuffle", pick: 5 }, required: false,
    notes: "[DEMO: Randomize N from a list] pick 5 of 12.",
  });
  single("q_rand_conditional", "RAND_COND", "Which streaming service would you keep if you could keep only one?", opts(["Netflix", "Disney+", "Prime Video", "YouTube Premium", "Apple TV+", "Spotify", "HBO Max", "Paramount+"]), {
    randomization: { enabled: true, scope: "options", method: "none", rules: [{ id: "rr_young", label: "Under 35 → shuffle", when: rule("q_age", "lt", 35), method: "shuffle" }] },
    notes: "[DEMO: Conditional randomization] Options shuffle only for respondents under 35; everyone else sees the programmed order.",
  });
  single("q_rand_groups", "RAND_GROUPS", "Which of these best describes your attitude to new technology?", opts(["I buy it first", "I buy it early", "I wait for reviews", "I buy when it's mainstream", "I buy when there's no choice", "I avoid it"]), {
    randomization: { enabled: true, scope: "options", method: "shuffle", groups: [[1, 2], [3, 4], [5, 6]] },
    notes: "[DEMO: Grouped randomization] Shuffle within groups; groups stay in place.",
  });
  Q({
    id: "q_experiment", variableName: "MESSAGE_ARM", type: "experiment", text: "Please read the following message.", required: false,
    settings: {
      arms: [
        { code: "A", label: "Rational message", html: "<p><strong>Save $240 a year</strong> by switching to a mid-range phone with three years of guaranteed updates.</p>" },
        { code: "B", label: "Emotional message", html: "<p><strong>Keep the phone you love, longer.</strong> Three years of updates means three years of feeling at home.</p>" },
      ],
    },
    notes: "[DEMO: Randomized experiment arms] Each respondent is assigned A or B (seeded); MESSAGE_ARM stores the arm and drives the next question's piping and display.",
  });
  single("q_experiment_react", "MESSAGE_REACT", "How convincing did you find the message you just read?", opts(["Not at all convincing", "Slightly", "Moderately", "Very", "Extremely convincing"]), {
    displayLogic: rule("q_experiment", "answered"),
  });

  /* randomized blocks (flow randomizer): three attitude pages, show 2 */
  single("q_attitude_privacy", "ATT_PRIVACY", "How concerned are you about how technology companies use your personal data?", opts(["Not at all concerned", "Slightly", "Moderately", "Very", "Extremely concerned"]), { notes: "[DEMO: Randomized block A] One of three blocks shown in random order (2 of 3)." });
  single("q_attitude_sustain", "ATT_SUSTAIN", "How important is a brand's environmental record when you buy technology?", opts(["Not at all important", "Slightly", "Moderately", "Very", "Extremely important"]), { notes: "[DEMO: Randomized block B]" });
  single("q_attitude_ai", "ATT_AI", "How comfortable are you with AI features in your everyday devices?", opts(["Very uncomfortable", "Uncomfortable", "Neutral", "Comfortable", "Very comfortable"]), { notes: "[DEMO: Randomized block C]" });

  /* ====================================================== 13 Calculations & read-only */

  Q({
    id: "q_calc_summary", variableName: "CALC_SUMMARY", type: "composite", text: "Here is a summary of what you told us (calculated, read only).",
    rows: [{ code: "you", label: "Your answers" }],
    columns: [
      { id: "c_total", label: "Monthly spend", responseType: "numeric", variableStem: "SUM_MONTHLY", expression: "MONTHLY_SPEND", readOnly: true },
      { id: "c_annual", label: "Annualised (×12)", responseType: "numeric", variableStem: "SUM_ANNUAL", expression: "MONTHLY_SPEND * 12", readOnly: true },
      { id: "c_12m", label: "12-month spend (sum of categories)", responseType: "numeric", variableStem: "SUM_12M", expression: "sum(SPEND_12M_*)", readOnly: true },
      { id: "c_pct_sub", label: "% on subscriptions", responseType: "numeric", variableStem: "SUM_PCT_SUB", expression: "round(pct(SUB_SPEND, MONTHLY_SPEND), 1)", readOnly: true },
      { id: "c_nbrands", label: "Brands used", responseType: "numeric", variableStem: "SUM_NBRANDS", expression: "count(BRANDS_USED)", readOnly: true },
    ],
    required: false,
    notes: "[DEMO: Read-only calculated fields] Every column has an `expression`; the cells are computed live and are never editable.",
  });
  single("q_calc_confirm", "CALC_CONFIRM", "Your total technology spend over the last 12 months works out to about {{calc.TOTAL_SPEND_12M}}, and your average brand rating is {{calc.AVG_BRAND_RATING}} out of 100. Does that look right?", YES_NO, {
    notes: "[DEMO: Calculated-variable piping] {{calc.TOTAL_SPEND_12M}} and {{calc.AVG_BRAND_RATING}} come from the calculations list.",
  });
  numeric("q_calc_correct", "CORRECTED_TOTAL", "What should the 12-month total be?", 0, 100000, {
    displayLogic: rule("q_calc_confirm", "eq", 2),
    validation: [{ kind: "required", when: rule("q_calc_confirm", "eq", 2), message: "Please enter the corrected total." }],
    notes: "[DEMO: Conditional required] Required only when the respondent disagreed with the calculation.",
  });
  single("q_score_band", "SCORE_BAND", "Based on your answers we would describe you as a “{{calc.TECH_SEGMENT}}” (engagement score {{calc.ENGAGEMENT_SCORE}}/100). Does that feel accurate?", opts(["Yes, very accurate", "Somewhat accurate", "Not accurate"]), {
    notes: "[DEMO: Weighted score + text segment] ENGAGEMENT_SCORE is a weighted() calculation; TECH_SEGMENT is an if() chain over it.",
  });
  single("q_auto_segment", "AUTO_SEGMENT", "Spend segment (auto-populated, read only)", opts([{ code: "low", label: "Light spender (< 50 / month)" }, { code: "mid", label: "Moderate spender (50–199 / month)" }, { code: "high", label: "Heavy spender (200+ / month)" }]), {
    settings: { readOnly: true }, required: false,
    punches: [
      { id: "punch_low", source: { kind: "codes", codes: ["low"] }, action: "select", recompute: "always", when: rule("q_monthly_spend", "lt", 50) },
      { id: "punch_mid", source: { kind: "codes", codes: ["mid"] }, action: "select", recompute: "always", when: rule("q_monthly_spend", "between", 50, 199) },
      { id: "punch_high", source: { kind: "codes", codes: ["high"] }, action: "select", recompute: "always", when: rule("q_monthly_spend", "gte", 200) },
    ],
    notes: "[DEMO: Auto-punch from a previous numeric answer] Three punch rules with `when` conditions on MONTHLY_SPEND.",
  });
  single("q_auto_fav_mirror", "FAV_BRAND_MIRROR", "Favourite brand (auto-populated from your earlier answer)", BRANDS, {
    settings: { readOnly: true }, required: false, displayLogic: rule("q_fav_brand", "answered"),
    punches: [{ id: "punch_mirror", label: "copy FAV_BRAND", source: { kind: "ref", questionId: "q_fav_brand", selection: "selected" }, action: "select", recompute: "always" }],
    notes: "[DEMO: Auto-punch by reference] The favourite brand's code is copied into this question (same codes, no mapping).",
  });
  single("q_auto_os_family", "OS_FAMILY", "Ecosystem (auto-populated with a mapped value)", opts([{ code: "ios", label: "Apple ecosystem" }, { code: "android", label: "Android ecosystem" }, { code: "windows", label: "Windows / PC ecosystem" }, { code: "mixed", label: "Mixed" }]), {
    settings: { readOnly: true }, required: false, displayLogic: rule("q_fav_brand", "answered"),
    punches: [{
      id: "punch_map", label: "map brand → ecosystem", source: { kind: "ref", questionId: "q_fav_brand", selection: "selected" }, action: "select", recompute: "always",
      mapping: [
        { from: 1, to: "ios" }, { from: 2, to: "android" }, { from: 3, to: "android" }, { from: 4, to: "android" }, { from: 5, to: "android" }, { from: 9, to: "android" },
        { from: 7, to: "windows" }, { from: 10, to: "windows" }, { from: 11, to: "windows" }, { from: 6, to: "mixed" }, { from: 8, to: "mixed" }, { from: 12, to: "mixed" },
      ],
    }],
    notes: "[DEMO: Auto-punch with a mapping] FAV_BRAND code → ecosystem code (Apple → ios, Samsung → android, …).",
  });
  single("q_auto_lf_mirror", "LF_BRAND_MIRROR", "Allocated evaluation brand (auto-populated from List Fill)", BRANDS, {
    settings: { readOnly: true }, required: false, displayLogic: calcRule("LISTFILL_BRAND_EVAL_COUNT", "gte", 1),
    punches: [{ id: "punch_lf", label: "copy LF_BRAND_1", source: { kind: "ref", questionId: "h_lf_brand_1", selection: "selected" }, action: "select", recompute: "always" }],
    notes: "[DEMO: Auto-punch from a List Fill result] Reads the hidden destination LF_BRAND_1.",
  });
  single("q_auto_calc_flag", "HEAVY_USER_FLAG", "Heavy digital user (auto-populated from a calculation)", opts([{ code: "yes", label: "Heavy user" }, { code: "no", label: "Regular user" }]), {
    settings: { readOnly: true }, required: false,
    punches: [
      { id: "punch_heavy", source: { kind: "codes", codes: ["yes"] }, action: "select", recompute: "always", when: calcRule("ENGAGEMENT_SCORE", "gte", 60) },
      { id: "punch_regular", source: { kind: "codes", codes: ["no"] }, action: "select", recompute: "always", when: calcRule("ENGAGEMENT_SCORE", "lt", 60) },
    ],
    notes: "[DEMO: Auto-punch from a calculation] when ENGAGEMENT_SCORE ≥ 60.",
  });

  /* ====================================================== 14 Validation showcase */

  multi("q_exact_three", "TOP3_CONCERNS", "Select exactly three concerns you have about technology.", opts(["Privacy", "Cost", "Security", "Screen time", "Misinformation", "Job displacement", "Environmental impact", "Accessibility", "Children's safety", "Addiction"]), {
    settings: { minSelections: 3, maxSelections: 3 },
    notes: "[DEMO: Exact selection count] minSelections = maxSelections = 3.",
  });
  Q({ id: "q_postcode", variableName: "POSTCODE", type: "open_text", variant: "text.zip", text: "What is your postal / ZIP code?", required: true,
    validation: [{ kind: "pattern", value: "^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$", message: "Please enter a valid postal code (3–10 letters/digits)." }],
    notes: "[DEMO: Regex validation]" });
  numeric("q_devices_count", "DEVICES_COUNT", "How many connected devices are in your home in total?", 1, 200, {
    validation: [{ kind: "integer" }, { kind: "custom_expression", value: "value >= count(DEVICES)", message: "This cannot be lower than the number of device types you selected earlier." }],
    notes: "[DEMO: Logical validation against a count()] value ≥ count(DEVICES).",
  });
  Q({ id: "q_feedback_short", variableName: "FEEDBACK_SHORT", type: "open_text", text: "In a few words, what is the best thing about your main device?", required: true,
    validation: [{ kind: "min_length", value: 3 }, { kind: "max_length", value: 120, message: "Please keep it under 120 characters." }],
    notes: "[DEMO: Text length validation]" });
  Q({
    id: "q_upgrade_dates", variableName: "UPGRADE_WINDOW", type: "composite", text: "When do you plan your next upgrade window?",
    rows: [{ code: "w", label: "Planned window" }],
    columns: [
      { id: "c_from", label: "From", responseType: "date", variableStem: "UPGRADE_FROM", validation: [{ kind: "required" }] },
      { id: "c_to", label: "To", responseType: "date", variableStem: "UPGRADE_TO", validation: [{ kind: "required" }] },
      { id: "c_budget", label: "Budget", responseType: "numeric", variableStem: "UPGRADE_BUDGET", min: 0, max: 20000 },
    ],
    notes: "[DEMO: Multi-column date pair + custom JavaScript validation] The on_submit script rejects To < From.",
  });

  /* ====================================================== 15 Quota / allocation demo */

  single("q_quota_cell", "QUOTA_CELL", "Sample cell (auto-populated from gender × age, read only)", opts([
    { code: "m_young", label: "Male 18–34" }, { code: "m_old", label: "Male 35+" }, { code: "f_young", label: "Female 18–34" }, { code: "f_old", label: "Female 35+" }, { code: "other", label: "Other / not stated" },
  ]), {
    settings: { readOnly: true }, required: false,
    punches: [
      { id: "pq1", source: { kind: "codes", codes: ["m_young"] }, action: "select", recompute: "always", when: and(rule("q_gender", "eq", 1), rule("q_age", "lt", 35)) },
      { id: "pq2", source: { kind: "codes", codes: ["m_old"] }, action: "select", recompute: "always", when: and(rule("q_gender", "eq", 1), rule("q_age", "gte", 35)) },
      { id: "pq3", source: { kind: "codes", codes: ["f_young"] }, action: "select", recompute: "always", when: and(rule("q_gender", "eq", 2), rule("q_age", "lt", 35)) },
      { id: "pq4", source: { kind: "codes", codes: ["f_old"] }, action: "select", recompute: "always", when: and(rule("q_gender", "eq", 2), rule("q_age", "gte", 35)) },
      { id: "pq5", source: { kind: "codes", codes: ["other"] }, action: "select", recompute: "always", when: rule("q_gender", "in", [3, 99]) },
    ],
    notes: "[DEMO: Quota flag as a visible read-only variable] Mirrors the Gender × Age quota cells so testers can see which cell they fell into. The quotas themselves are enforced by the quota_check node after demographics.",
  });
  calculated("h_quota_flag", "QUOTA_FLAG", "Hidden quota flag", "GENDER + '_' + AGE_GROUP",
    { notes: "[DEMO: Hidden quota flag] Text key of the combined quota cell, e.g. 1_25-34." });
  calculated("h_score", "HIDDEN_SCORE", "Hidden score", "round(avg(L1_SAT_*), 1)",
    { notes: "[DEMO: Hidden score] Mean of the loop ratings L1_SAT_1…N (positional loop variables)." });
  calculated("h_loop_cap", "LOOP_CAP", "Hidden loop control", "min(6, count(BRANDS_USED))",
    { notes: "[DEMO: Hidden loop control] LOOP_001 uses count.mode 'max' with this calculation, so at most 6 brands are evaluated even if more were used." });

  /* ====================================================== 16 Conjoint */

  info("info_conjoint", "<p>Next you will see 9 sets of three smartphone offers. In each set, choose the one you would buy — or none of them.</p>");
  Q({ id: "q_conjoint", variableName: "CBC", type: "conjoint_task", text: "Which of these would you choose?", required: true,
    settings: { designRef: "design_conjoint_phone" },
    displayLogic: rule("q_purchase_role", "in", [1, 2]),
    notes: "[DEMO: CONJOINT] Renders the tasks of design 'design_conjoint_phone' (4 attributes, 3 alternatives + None, 8 tasks + 1 holdout, 2 versions, seed 20260901). Shown only to decision-makers (PURCHASE_ROLE 1–2)." });
  single("q_cbc_driver", "CBC_DRIVER", "Which single attribute mattered most in the choices you just made?", opts(["Brand tier", "Price", "Battery life", "Warranty"]), { displayLogic: rule("q_conjoint", "answered") });
  open("q_cbc_why", "CBC_WHY", "Why did {{CBC_DRIVER}} matter most?", { displayLogic: rule("q_cbc_driver", "answered"), notes: "[DEMO: Piping a single-select label into an open end]" });

  /* ====================================================== 17 MaxDiff + custom design */

  Q({ id: "q_maxdiff", variableName: "MD", type: "maxdiff_task", text: "For each set, pick the feature that matters MOST and the one that matters LEAST when buying a phone.", required: true,
    settings: { designRef: "design_maxdiff_features" },
    notes: "[DEMO: MAXDIFF] 12 items, 5 per task, 9 tasks, 2 versions (design_maxdiff_features, seed 20260902)." });
  Q({ id: "q_md_top3", variableName: "MD_TOP3", type: "ranking", text: "Overall, rank the three features that matter most to you.", required: true,
    settings: { rankMode: "top_n", maxSelections: 3 },
    options: MAXDIFF_ITEMS.map((label, i) => ({ code: `f${i + 1}`, label })),
    notes: "[DEMO: MaxDiff follow-up with the same item list]" });
  single("q_cd_agree", "CD_AGREE", "Statement: “{{loop.Statement}}” ({{loop.Component}} · intensity level {{loop.Level}}). How much do you agree?", AGREE_5, {
    notes: "[DEMO: CUSTOM DESIGN loop] LOOP_007 iterates the rows of design_custom_statements; the statement text, component and level are carried as LOOP_007 references keyed by task number.",
  });
  open("q_cd_why", "CD_WHY", "Why do you feel that way about “{{loop.Statement}}”?", { displayLogic: loopRule("Level", "gte", 3), notes: "[DEMO: Display logic on a numeric loop reference] Only for level-3 statements." });

  /* ====================================================== 18 Specialised question types */

  Q({
    id: "q_product_grid", variableName: "PRODGRID", type: "composite", text: "For each product you own, tell us a bit more.", required: true,
    rows: [{ code: "phone", label: "Smartphone", visibleIf: rule("q_devices", "selected", 1) }, { code: "laptop", label: "Laptop", visibleIf: rule("q_devices", "selected", 2) }, { code: "tablet", label: "Tablet", visibleIf: rule("q_devices", "selected", 4) }],
    columns: [
      { id: "c_primary", label: "Primary device?", responseType: "single", variableStem: "PG_PRIMARY", options: opts(["Yes", "No"]), validation: [{ kind: "required" }] },
      { id: "c_features", label: "Features used", responseType: "multi", variableStem: "PG_FEATURES", options: opts(["Camera", "Gaming", "Work", "Streaming", "Payments"]), validation: [{ kind: "min_selections", value: 1, message: "Pick at least one feature." }] },
      { id: "c_freq", label: "Usage", responseType: "dropdown", variableStem: "PG_FREQ", options: FREQ_6 },
      { id: "c_comment", label: "Comment", responseType: "text", variableStem: "PG_COMMENT", validation: [{ kind: "max_length", value: 100 }] },
      { id: "c_rating", label: "Rating 1–10", responseType: "numeric", variableStem: "PG_RATING", min: 1, max: 10, validation: [{ kind: "required" }] },
    ],
    notes: "[DEMO §40: Complex multi-column question] One logical question, five response types (single / multi / dropdown / text / numeric), each column its own variable stem and validation; rows shown only for owned devices.",
  });
  Q({
    id: "q_constant_sum_grid", variableName: "TIMESPLIT", type: "custom_table", text: "Split 100% of your weekly screen time across devices, for weekdays and weekends.", required: true,
    rows: [{ code: "weekday", label: "Weekdays" }, { code: "weekend", label: "Weekends" }],
    columns: ["Phone", "Laptop / PC", "Tablet", "TV"].map((l, i) => ({ id: `c_${i}`, label: l, responseType: "numeric", variableStem: `TIME_${l.split(" ")[0].toUpperCase().replace("/", "")}`, min: 0, max: 100 })),
    settings: { rowSum: true, sumTarget: 100 },
    notes: "[DEMO: Constant-sum grid] Each row must total 100 (settings.rowSum + sumTarget).",
  });
  Q({
    id: "q_repeating", variableName: "SUBSCRIPTION", type: "repeating_group", text: "List the paid digital subscriptions you have (add as many as apply).",
    rows: [
      { code: "service", label: "Service name", fieldType: "text", required: true }, { code: "cost", label: "Monthly cost", fieldType: "currency" },
      { code: "since", label: "Subscribed since", fieldType: "date" },
    ],
    settings: { minRepeats: 1, maxRepeats: 8 },
    notes: "[DEMO: Repeating group] Respondent-driven repetition (1–8 entries).",
  });
  Q({
    id: "q_hotspot", variableName: "HOTSPOT", type: "hotspot", text: "Click the area of this device that you touch most often.", required: false,
    settings: { imageUrl: svgTile("Device", "#0f172a") },
    notes: "[DEMO: Hotspot] Stores click coordinates HOTSPOT_1_X/Y.",
  });
  Q({
    id: "q_annotation", variableName: "ANNOTATE", type: "annotation", text: "Mark anything you would change about this concept design (pin + comment, or draw).", required: false,
    settings: { imageUrl: svgTile("Concept", "#b45309"), tools: ["pin", "pen"] },
    notes: "[DEMO: Annotation] Pins and strokes on a stimulus image.",
  });
  Q({
    id: "q_image_rank", variableName: "COLOUR_RANK", type: "image_ranking", text: "Rank these colour finishes from most to least appealing.", required: true,
    options: [
      { code: "graphite", label: "Graphite", imageUrl: svgTile("Graphite", "#374151") }, { code: "silver", label: "Silver", imageUrl: svgTile("Silver", "#9ca3af") },
      { code: "blue", label: "Ocean blue", imageUrl: svgTile("Ocean", "#1d4ed8") }, { code: "green", label: "Forest green", imageUrl: svgTile("Forest", "#166534") },
    ],
    notes: "[DEMO: Image ranking]",
  });
  Q({
    id: "q_upload", variableName: "RECEIPT", type: "upload", text: "Optionally, upload a photo or screenshot of your most recent technology receipt.", required: false,
    settings: { accept: "image/*,.pdf", maxSizeMb: 5, maxFiles: 1 },
    notes: "[DEMO: File upload] Optional; RECEIPT_URL / RECEIPT_NAME / RECEIPT_SIZE.",
  });
  Q({
    id: "q_media", variableName: "AD_REACTION", type: "media_timeline", text: "Watch this short clip and tap a reaction whenever you feel one.", required: false,
    settings: { mediaUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", timelineMode: "options" },
    options: opts(["Like", "Dislike", "Confused", "Interested"]),
    displayLogic: rule("q_hours_online", "gte", 2),
    notes: "[DEMO: Media timeline] Timestamped reactions (public-domain sample clip); shown to respondents online ≥ 2 h/day.",
  });
  single("q_adaptive", "ADAPTIVE_Q", "Which of these would most improve your experience with technology?", opts(["Lower prices", "Better privacy", "Simpler interfaces", "Longer support"]), {
    settings: {
      adaptive: [
        { label: "Business users", when: rule("q_use_type", "eq", 2), text: "Which of these would most improve your organisation's technology?", options: opts(["Lower total cost", "Better security", "Easier administration", "Longer support contracts"]) },
        { label: "Heavy spenders", when: rule("q_monthly_spend", "gte", 200), text: "As a heavy technology spender, which of these would most improve your experience?" },
      ],
    },
    notes: "[DEMO: Adaptive question] Text and options change with the first matching condition (business users / heavy spenders).",
  });
  single("q_swipe", "SWIPE_STATEMENT", "“I would pay more for a device that is easy to repair.”", opts([{ code: "agree", label: "Agree" }, { code: "disagree", label: "Disagree" }]), {
    variant: "swipe.statement", settings: { swipeDirections: { right: "agree", left: "disagree" } },
    notes: "[DEMO: Presentation variant] Same single_select response model, swipe presentation.",
  });
  single("q_stars", "SURVEY_STARS", "How would you rate the design of the products you saw in this survey?", opts(["1", "2", "3", "4", "5"]), { variant: "single_select.stars", notes: "[DEMO: Star-rating variant]" });

  /* ====================================================== 19 Open ends */

  open("q_oe_improve", "OE_IMPROVE", "What would most improve your experience with your main device?", { required: true });
  open("q_oe_brand_perc", "OE_BRAND_PERCEPTION", "How would you describe {{FAV_BRAND}} to someone who has never heard of it?", { displayLogic: rule("q_fav_brand", "answered"), notes: "[DEMO: Piped, conditional open end]" });
  open("q_oe_detractor", "OE_DETRACTOR", "You gave your main device a {{NPS_DEVICE}} out of 10. What would it take to make that a 9 or 10?", {
    required: true, displayLogic: rule("q_nps_device", "lte", 6),
    notes: "[DEMO: Conditional open end] Detractors only (NPS ≤ 6); pipes the numeric answer.",
  });
  open("q_oe_rank_first", "OE_RANK_FIRST", "You ranked “{{PRIORITY_RANK.first}}” as your top priority. Why?", {
    displayLogic: rule("q_priority_rank", "answered"), notes: "[DEMO: Ranking piping] {{PRIORITY_RANK.first}} pipes the #1-ranked label.",
  });
  Q({ id: "q_oe_suggest", variableName: "OE_SUGGEST", type: "open_text", text: "One suggestion for technology brands in 2026:", validation: [{ kind: "max_length", value: 200 }] });
  open("q_oe_finance", "OE_FINANCE", "How has digital banking changed the way you manage money?", { displayLogic: or(rule("q_fin_products", "selected", 8), rule("q_fin_products", "selected", 6)) });

  /* ====================================================== 20 Final */

  single("q_survey_sat", "SURVEY_SAT", "How was your experience completing this survey?", SAT_5);
  single("q_recontact", "RECONTACT", "Would you be willing to be re-contacted for a follow-up interview?", YES_NO);
  Q({ id: "q_recontact_email", variableName: "RECONTACT_EMAIL", type: "open_text", variant: "text.email", text: "Please confirm the best email address to reach you on.",
    displayLogic: rule("q_recontact", "eq", 1),
    validation: [{ kind: "required", when: rule("q_recontact", "eq", 1) }, { kind: "email", message: "Please enter a valid email address." }],
    notes: "[DEMO: Conditional required + email validation]" });
  open("q_final_comments", "FINAL_COMMENTS", "Any final comments?", { required: false });

  /* ============================================================ codes */

  let qn = 0, hn = 0, tn = 0;
  for (const q of questions) {
    const type = q.type as string;
    if (type === "html") q.code = `INFO${++tn}`;
    else if (type === "hidden" || type === "calculated" || type === "embedded_data") q.code = `H${++hn}`;
    else q.code = `Q${++qn}`;
  }

  /* ============================================================ flow */

  const flow: FlowNode[] = [
    { type: "embedded_data", id: "ed_capture", title: "Embedded data capture", fields: [
      { name: "PANEL_ID", source: "url", defaultValue: "DEMO-PANEL" },
      { name: "SOURCE", source: "url", defaultValue: "direct" },
      { name: "WAVE", source: "static", value: "2026-W36" },
      { name: "SAMPLE_TYPE", source: "expression", value: "if(AGE >= 55, 'senior', 'core')", dataType: "string" },
    ] },

    section("sec_01_introduction", "01_Introduction", [
      page("p_intro_welcome", "Welcome", ["info_welcome", "q_consent", "q_confirm"]),
      page("p_intro_about", "About you", ["q_age", "q_country", "q_region", "q_city"]),
      page("p_intro_contact", "Contact details", ["q_email", "q_contact_ok", "q_phone"]),
    ]),

    section("sec_02_screening", "02_Screening", [
      page("p_screen_1", "Screening", ["q_devices", "q_purchase_role"]),
      page("p_screen_2", "Screening — role", ["q_use_type", "q_attention"]),
    ]),

    section("sec_03_demographics", "03_Demographics", [
      page("p_demo_core", "Demographics", ["q_gender", "q_employment", "q_education", "q_income", "h_age_group", "h_eligible"]),
      page("p_demo_work", "Work profile", ["q_industry", "q_job_level", "q_company_size"]),
      page("p_demo_household", "Household", ["q_hh_size", "q_hh_children", "q_fin_products"]),
      page("p_demo_dates", "Recent purchase", ["q_last_purchase", "q_warranty_end", "q_shop_time"]),
      { type: "quota_check", id: "qc_demographics", quotaIds: ["quota_gender", "quota_age", "quota_gender_age"], onFull: { kind: "terminate" } },
      page("p_quota_cell", "Quota cell (test visibility)", ["q_quota_cell", "h_quota_flag"]),
    ]),

    section("sec_04_technology", "04_Technology_Usage", [
      page("p_tech_usage", "Technology usage", ["q_hours_online", "q_activities", "q_apps", "q_form_factor"]),
      page("p_tech_priorities", "Priorities", ["q_priority_rank", "q_nps_device"]),
      page("p_tech_spend", "Spending", ["q_monthly_spend", "q_sub_spend", "q_hw_spend", "q_spend_split", "q_pct_online"]),
      page("p_tech_spend_12m", "Spending — 12 months", ["q_spend_by_type", "q_budget_next"]),
      page("p_tech_sat", "Device satisfaction", ["q_smartwatch_sat", "q_smarthome_sat", "q_invest"]),
      {
        type: "branch", id: "br_use_type", title: "Consumer / Business / Both",
        branches: [
          { id: "br_consumer", label: "Consumer: personal use, or Both while not working", when: or(rule("q_use_type", "eq", 1), and(rule("q_use_type", "eq", 3), rule("q_employment", "in", [4, 5, 6]))),
            children: [block("blk_04a_consumer", "04a_Consumer_Section", [page("p_consumer", "Consumer section", ["q_consumer_focus"])])] },
          { id: "br_business", label: "Business: work use only", when: rule("q_use_type", "eq", 2),
            children: [block("blk_04b_business", "04b_Business_Section", [page("p_business", "Business section", ["q_business_function", "q_company_devices"])])] },
        ],
        otherwise: [block("blk_04c_combined", "04c_Combined_Section", [page("p_combined", "Combined section", ["q_consumer_focus", "q_business_function", "q_blend"])])],
      },
    ]),

    section("sec_05_brand_selection", "05_Brand_Selection", [
      page("p_brand_unaided", "Unaided awareness", ["q_unaided"]),
      page("p_brand_aware", "Aided awareness", ["q_aware"]),
      page("p_brand_used", "Brands used & trusted", ["q_used", "q_trusted"]),
      page("p_brand_fav", "Favourite brand", ["q_fav_brand", "q_fav_why"]),
      page("p_brand_grids", "Brand grids", ["q_brand_agree", "q_brand_assoc"]),
      page("p_brand_grids_2", "Brand grids (2)", ["q_years_used", "q_channel", "q_one_word"]),
      page("p_brand_detail_gate", "Detail gate", ["q_detail_interest", "h_lf_source"]),
    ]),

    section("sec_06_list_fill", "06_List_Fill", [
      page("p_lf_destinations", "List Fill destinations (hidden)", ["h_lf_brand_1", "h_lf_brand_2", "h_lf_topic"]),
      page("p_lf_eval", "List Fill evaluation", ["q_lf_sat_1", "q_lf_sat_2", "q_lf_topic_open", "q_lf_trust_pick"]),
      {
        type: "loop", id: "loop_lf", title: "LOOP_LF — for each List-Fill-allocated brand", loopVar: "lfbrand",
        source: { kind: "listFill", listFillId: "lf_brand_eval" },
        references: {
          columns: [{ name: "Tier", dataType: "text", required: true }, { name: "Segment", dataType: "text" }],
          values: {
            "1": { Tier: "Premium", Segment: "Ecosystem" }, "2": { Tier: "Premium", Segment: "Hardware leader" }, "3": { Tier: "Mainstream", Segment: "Software-first" },
            "4": { Tier: "Value", Segment: "Challenger" }, "5": { Tier: "Value", Segment: "Challenger" }, "6": { Tier: "Premium", Segment: "Entertainment" },
            "7": { Tier: "Mainstream", Segment: "Productivity" }, "8": { Tier: "Mainstream", Segment: "Services" }, "9": { Tier: "Value", Segment: "Challenger" },
            "10": { Tier: "Mainstream", Segment: "Computing" }, "11": { Tier: "Mainstream", Segment: "Computing" }, "12": { Tier: "Mainstream", Segment: "Appliances" },
          },
        },
        children: [page("p_lf_loop", "List Fill loop page", ["q_lf_loop_nps", "q_lf_loop_why"])],
      },
    ]),

    section("sec_07_list_operations", "07_List_Operations", [
      page("p_listops_1", "List operations (1)", ["q_curious", "q_consider"]),
      page("p_listops_2", "List operations (2)", ["q_core_brand", "q_never_seen"]),
      page("p_listops_3", "List operations (3)", ["q_sorted_pick", "q_random_three", "q_masked", "q_prioritized"]),
    ]),

    section("sec_08_loop_demo", "08_Loop_Demo — LOOP_001 (FOR EACH selected brand in BRANDS_USED)", [
      {
        type: "loop", id: "loop_001", title: "LOOP_001 — selected brands", loopVar: "brand",
        source: { kind: "question", questionId: "q_used", filter: "selected" },
        order: { kind: "selection" },
        count: { mode: "max", value: { kind: "variable", ref: "LOOP_CAP" } },
        references: LOOP_001_REFS,
        children: [
          block("blk_08_block2", "Block 2 — repeated per brand", [
            page("p_l1_a", "Brand evaluation (a)", ["q_l1_familiar", "q_l1_freq", "q_l1_sat"]),
            page("p_l1_b", "Brand evaluation (b)", ["q_l1_why", "q_l1_nps", "q_l1_attrs"]),
            page("p_l1_c", "Brand evaluation (c)", ["q_l1_smartphone", "q_l1_spend_rate", "q_l1_recommend", "q_l1_category_auto"]),
          ]),
            {
              type: "loop", id: "loop_002", title: "LOOP_002 — features (nested inside LOOP_001)", loopVar: "feature",
              source: { kind: "static", items: FEATURES },
              order: { kind: "priority", column: "Weight", direction: "desc" },
              count: { mode: "max", value: 3 },
              references: {
                columns: [{ name: "Feature_Group", dataType: "text", required: true }, { name: "Weight", dataType: "number", required: true }],
                values: {
                  battery: { Feature_Group: "Hardware", Weight: 5 }, camera: { Feature_Group: "Hardware", Weight: 4 }, price: { Feature_Group: "Commercial", Weight: 3 },
                  design: { Feature_Group: "Experience", Weight: 2 }, support: { Feature_Group: "Service", Weight: 1 },
                },
              },
              children: [page("p_l2", "Feature rating", ["q_l2_feature_rate", "q_l2_feature_reason"])],
            },
        ],
      },
    ]),

    section("sec_09_loop_not_selected", "09_Loop_Not_Selected — LOOP_003 (FOR EACH NOT-selected brand)", [
      {
        type: "loop", id: "loop_003", title: "LOOP_003 — brands aware of but not used", loopVar: "nonuser",
        source: { kind: "question", questionId: "q_used", filter: "notSelected" },
        order: { kind: "random" },
        count: { mode: "max", value: 3 },
        references: {
          columns: [{ name: "Reason_Prompt", dataType: "text", required: true }],
          values: Object.fromEntries(BRANDS.map((b) => [String(b.code), { Reason_Prompt: `What would make you try ${b.label} for the first time?` }])),
        },
        children: [block("blk_09_block3", "Block 3 — repeated per non-used brand", [page("p_l3", "Non-user evaluation", ["q_l3_why_not", "q_l3_try", "q_l3_convince"])])],
      },
    ]),

    section("sec_10_loop_invalid", "10_Loop_Invalid — LOOP_004 (filter 'invalid') + LOOP_005 (script-detected invalid answers)", [
      {
        type: "loop", id: "loop_004", title: "LOOP_004 — brands flagged invalid (market exit)", loopVar: "exited",
        source: { kind: "question", questionId: "q_aware", filter: "invalid" },
        invalidIf: loopRule("Market_Status", "eq", "exited"),
        references: {
          columns: [{ name: "Market_Status", dataType: "text", required: true }, { name: "Exit_Year", dataType: "number" }],
          values: Object.fromEntries([...BRANDS, NONE_BRAND].map((b) => [String(b.code), b.code === 9 || b.code === 12 ? { Market_Status: "exited", Exit_Year: 2021 } : { Market_Status: "active", Exit_Year: null }])),
        },
        children: [page("p_l4", "Market-exit awareness", ["q_l4_aware_exit", "q_l4_effect"])],
      },
      {
        type: "loop", id: "loop_005", title: "LOOP_005 — implausible years-used entries (set by script)", loopVar: "badyears",
        source: { kind: "variable", ref: "INVALID_BRANDS" },
        count: { mode: "max", value: 3 },
        references: {
          columns: [{ name: "Brand", dataType: "text", required: true }],
          values: Object.fromEntries(BRANDS.map((b) => [String(b.code), { Brand: b.label }])),
        },
        children: [page("p_l5", "Correct an implausible entry", ["q_l5_fix_years"])],
      },
    ]),

    section("sec_11_loop_count", "11_Loop_Count — LOOP_006 (FOR i = 1 TO N_PRODUCTS)", [
      page("p_l6_count", "How many products?", ["q_n_products"]),
      {
        type: "loop", id: "loop_006", title: "LOOP_006 — runs N_PRODUCTS times", loopVar: "product",
        source: { kind: "count", count: { kind: "question", ref: "q_n_products" } },
        count: { mode: "max", value: 5 },
        children: [page("p_l6", "Product detail", ["q_l6_type", "q_l6_name", "q_l6_price", "q_l6_sat"])],
      },
    ]),

    section("sec_12_randomization", "12_Randomization", [
      page("p_rand_1", "Randomized options", ["q_rand_anchor", "q_rand_rotate"]),
      page("p_rand_2", "Randomized rows & picks", ["q_rand_half", "q_rand_pick"]),
      page("p_rand_3", "Conditional & grouped randomization", ["q_rand_conditional", "q_rand_groups"]),
      page("p_rand_experiment", "Message experiment", ["q_experiment", "q_experiment_react"]),
      {
        type: "randomizer", id: "rnd_attitudes", title: "Randomized blocks — show 2 of 3", show: 2,
        children: [
          block("blk_12a_privacy", "12a_Attitude_Privacy", [page("p_att_privacy", "Attitudes — privacy", ["q_attitude_privacy"])]),
          block("blk_12b_sustain", "12b_Attitude_Sustainability", [page("p_att_sustain", "Attitudes — sustainability", ["q_attitude_sustain"])]),
          block("blk_12c_ai", "12c_Attitude_AI", [page("p_att_ai", "Attitudes — AI", ["q_attitude_ai"])]),
        ],
      },
    ]),

    section("sec_13_calculations", "13_Calculations", [
      page("p_calc_summary", "Calculated summary", ["q_calc_summary", "q_calc_confirm", "q_calc_correct", "h_score"]),
      page("p_calc_segments", "Segments & auto-punch", ["q_score_band", "q_auto_segment", "q_auto_fav_mirror", "q_auto_os_family", "q_auto_lf_mirror", "q_auto_calc_flag"]),
    ]),

    section("sec_14_validation", "14_Validation", [
      page("p_val_1", "Validation (1)", ["q_exact_three", "q_postcode", "q_devices_count"]),
      page("p_val_2", "Validation (2)", ["q_feedback_short", "q_upgrade_dates"]),
    ]),

    section("sec_15_conjoint", "15_Conjoint", [
      page("p_cbc", "Conjoint", ["info_conjoint", "q_conjoint"], { visibleIf: rule("q_purchase_role", "in", [1, 2]) }),
      page("p_cbc_follow", "Conjoint follow-up", ["q_cbc_driver", "q_cbc_why"]),
    ]),

    section("sec_16_maxdiff", "16_MaxDiff_and_Custom_Design", [
      page("p_maxdiff", "MaxDiff", ["q_maxdiff"]),
      page("p_maxdiff_follow", "MaxDiff follow-up", ["q_md_top3"]),
      {
        type: "loop", id: "loop_007", title: "LOOP_007 — custom design rows (statement rotation)", loopVar: "task",
        source: { kind: "design", designId: "design_custom_statements" },
        count: { mode: "max", value: 3 },
        references: {
          columns: [{ name: "Statement", dataType: "text", required: true }, { name: "Component", dataType: "text" }, { name: "Level", dataType: "number" }],
          values: Object.fromEntries(custom.rows.map((r, i) => [String(i + 1), { Statement: String(r.statement), Component: String(r.component), Level: Number(r.level) }])),
        },
        children: [page("p_cd", "Statement task", ["q_cd_agree", "q_cd_why"])],
      },
    ]),

    section("sec_17_specialised", "17_Specialised_Question_Types", [
      page("p_spec_grid", "Multi-column grid", ["q_product_grid", "q_constant_sum_grid"]),
      page("p_spec_repeat", "Repeating group", ["q_repeating"]),
      page("p_spec_media", "Images & media", ["q_hotspot", "q_annotation", "q_image_rank", "q_upload", "q_media"]),
      page("p_spec_variants", "Adaptive & variants", ["q_adaptive", "q_swipe", "q_stars"]),
    ]),

    section("sec_18_open_ends", "18_Open_Ends", [
      page("p_oe_1", "Open ends (1)", ["q_oe_improve", "q_oe_brand_perc", "q_oe_detractor"]),
      page("p_oe_2", "Open ends (2)", ["q_oe_rank_first", "q_oe_suggest", "q_oe_finance"]),
    ]),

    section("sec_19_final", "19_Final", [
      page("p_final", "Final questions", ["q_survey_sat", "q_recontact", "q_recontact_email", "q_final_comments"]),
    ]),

    { type: "end", id: "end_complete", status: "complete",
      message: "Thank you, {{CITY}}! You evaluated {{calc.N_BRANDS_USED}} brand(s), your favourite being {{FAV_BRAND}}. Engagement score: {{calc.ENGAGEMENT_SCORE}}/100 · Segment: {{calc.TECH_SEGMENT}}." },
    { type: "end", id: "end_screened", status: "screened", message: "Thank you for your interest — this study is looking for a different profile today." },
    { type: "end", id: "end_quota_full", status: "quota_full", message: "Thank you — we have already heard from enough people in your group." },
  ];

  /* ============================================================ logic flow (data) */

  const logicFlow = {
    nodes: [
      { id: "lf_consent", kind: "question", ref: "q_consent", label: "Q1 Consent", x: 40, y: 40 },
      { id: "lf_d_consent", kind: "decision", label: "Agreed?", x: 40, y: 140 },
      { id: "lf_t_screened", kind: "terminate", label: "Terminate (screened)", x: 320, y: 140 },
      { id: "lf_devices", kind: "question", ref: "q_devices", label: "Devices owned", x: 40, y: 240 },
      { id: "lf_d_devices", kind: "decision", label: "Owns any device?", x: 40, y: 340 },
      { id: "lf_quota", kind: "action", ref: "qc_demographics", label: "Quota check (gender, age, gender×age)", x: 40, y: 440 },
      { id: "lf_t_quota", kind: "terminate", label: "Terminate (quota_full)", x: 320, y: 440 },
      { id: "lf_use_type", kind: "decision", ref: "q_use_type", label: "Consumer / Business / Both", x: 40, y: 540 },
      { id: "lf_consumer", kind: "action", ref: "blk_04a_consumer", label: "Consumer section", x: -200, y: 640 },
      { id: "lf_business", kind: "action", ref: "blk_04b_business", label: "Business section", x: 40, y: 640 },
      { id: "lf_both", kind: "action", ref: "blk_04c_combined", label: "Combined section", x: 280, y: 640 },
      { id: "lf_brands", kind: "question", ref: "q_used", label: "Brands used (loop source)", x: 40, y: 740 },
      { id: "lf_detail", kind: "decision", ref: "q_detail_interest", label: "Detailed evaluation?", x: 40, y: 840 },
      { id: "lf_listfill", kind: "action", ref: "lf_brand_eval", label: "List Fill (priority + cap + quota)", x: 40, y: 940 },
      { id: "lf_loop", kind: "action", ref: "loop_001", label: "LOOP_001 → Block 2 (repeated per brand)", x: 40, y: 1040 },
      { id: "lf_count", kind: "action", ref: "loop_006", label: "LOOP_006 (count)", x: 320, y: 940 },
      { id: "lf_cbc", kind: "action", ref: "q_conjoint", label: "Conjoint", x: 40, y: 1140 },
      { id: "lf_md", kind: "action", ref: "q_maxdiff", label: "MaxDiff", x: 40, y: 1240 },
      { id: "lf_end", kind: "end", label: "End (complete)", x: 40, y: 1340 },
    ],
    edges: [
      { id: "e1", from: "lf_consent", to: "lf_d_consent" },
      { id: "e2", from: "lf_d_consent", to: "lf_devices", label: "Yes", when: rule("q_consent", "eq", 1) },
      { id: "e3", from: "lf_d_consent", to: "lf_t_screened", label: "No", when: rule("q_consent", "eq", 2) },
      { id: "e4", from: "lf_devices", to: "lf_d_devices" },
      { id: "e5", from: "lf_d_devices", to: "lf_quota", label: "Yes", when: not(rule("q_devices", "selected", 98)) },
      { id: "e6", from: "lf_d_devices", to: "lf_t_screened", label: "None", when: rule("q_devices", "selected", 98) },
      { id: "e7", from: "lf_quota", to: "lf_use_type", label: "open" },
      { id: "e8", from: "lf_quota", to: "lf_t_quota", label: "full" },
      { id: "e9", from: "lf_use_type", to: "lf_consumer", label: "Consumer", when: rule("q_use_type", "eq", 1) },
      { id: "e10", from: "lf_use_type", to: "lf_business", label: "Business", when: rule("q_use_type", "eq", 2) },
      { id: "e11", from: "lf_use_type", to: "lf_both", label: "Both", when: rule("q_use_type", "eq", 3) },
      { id: "e12", from: "lf_consumer", to: "lf_brands" }, { id: "e13", from: "lf_business", to: "lf_brands" }, { id: "e14", from: "lf_both", to: "lf_brands" },
      { id: "e15", from: "lf_brands", to: "lf_detail" },
      { id: "e16", from: "lf_detail", to: "lf_listfill", label: "Yes", when: rule("q_detail_interest", "eq", 1) },
      { id: "e17", from: "lf_detail", to: "lf_count", label: "No → shorter version", when: rule("q_detail_interest", "eq", 2) },
      { id: "e18", from: "lf_listfill", to: "lf_loop" }, { id: "e19", from: "lf_loop", to: "lf_count" },
      { id: "e20", from: "lf_count", to: "lf_cbc" }, { id: "e21", from: "lf_cbc", to: "lf_md" }, { id: "e22", from: "lf_md", to: "lf_end" },
    ],
  };

  /* ============================================================ calculations */

  const calculations = [
    { id: "calc_n_aware", targetVariable: "N_AWARE", label: "Number of brands aware of", expression: "count(BRANDS_AWARE) - BRANDS_AWARE_98", trigger: "on_change", notes: "[DEMO: Number of selected options] Excludes the exclusive None code." },
    { id: "calc_n_used", targetVariable: "N_BRANDS_USED", label: "Number of brands used", expression: "count(BRANDS_USED)", trigger: "on_change" },
    { id: "calc_n_aware_not_used", targetVariable: "N_AWARE_NOT_USED", label: "Aware but not used", expression: "N_AWARE - N_BRANDS_USED", trigger: "on_change", notes: "[DEMO: Calculation on calculations] Reads two other calculated variables." },
    { id: "calc_n_fin", targetVariable: "N_FIN_PRODUCTS", label: "Financial products used", expression: "count(FIN_PRODUCTS) - FIN_PRODUCTS_98", trigger: "on_page_submit" },
    { id: "calc_total_12m", targetVariable: "TOTAL_SPEND_12M", label: "Total 12-month spend", expression: "sum(SPEND_12M_*)", trigger: "on_page_submit", notes: "[DEMO: Sum with wildcard] Q_phone + Q_computer + Q_wearable + Q_accessory." },
    { id: "calc_annual", targetVariable: "ANNUAL_SPEND", label: "Annualised monthly spend", expression: "MONTHLY_SPEND * 12", trigger: "on_page_submit" },
    { id: "calc_pct_sub", targetVariable: "PCT_SUBSCRIPTIONS", label: "% of spend on subscriptions", expression: "round(pct(SUB_SPEND, MONTHLY_SPEND), 1)", trigger: "on_page_submit", notes: "[DEMO: Percentage calculation]" },
    { id: "calc_avg_rating", targetVariable: "AVG_BRAND_RATING", label: "Average loop brand rating", expression: "round(avg(L1_SAT_*), 1)", trigger: "on_page_submit", notes: "[DEMO: Average of loop-iteration answers] L1_SAT_1…N are the positional loop variables." },
    { id: "calc_engagement", targetVariable: "ENGAGEMENT_SCORE", label: "Weighted engagement score (0–100)", expression: "round(weighted(min(HOURS_ONLINE, 10) * 10, 0.4, count(APPS) * 100 / 15, 0.3, N_BRANDS_USED * 100 / 12, 0.3), 0)", trigger: "on_page_submit", notes: "[DEMO: Weighted score] 40% hours online, 30% app breadth, 30% brand breadth." },
    { id: "calc_segment", targetVariable: "TECH_SEGMENT", label: "Technology segment", expression: "if(ENGAGEMENT_SCORE >= 70, 'Digital Native', if(ENGAGEMENT_SCORE >= 40, 'Connected Mainstream', 'Selective User'))", trigger: "on_page_submit", dataType: "text", notes: "[DEMO: Text segment from a score]" },
    { id: "calc_nps_segment", targetVariable: "NPS_SEGMENT", label: "NPS segment", expression: "if(NPS_DEVICE >= 9, 'promoter', if(NPS_DEVICE >= 7, 'passive', 'detractor'))", trigger: "on_page_submit", dataType: "text" },
    { id: "calc_lf_count", targetVariable: "LF_EVAL_COUNT", label: "List Fill count (min(2, brands used))", expression: "min(2, N_BRANDS_USED)", trigger: "on_change", notes: "[DEMO: Dynamic List Fill count] LF_BRAND_EVAL's count reads this variable." },
    { id: "calc_total_score", targetVariable: "TOTAL_SCORE", label: "Total score (sum of loop NPS)", expression: "sum(L1_NPS_*)", trigger: "on_page_submit", notes: "[DEMO: Total score]" },
  ];

  /* ============================================================ quotas */

  const g = (code: number) => rule("q_gender", "eq", code);
  const age = (grp: string) => rule("h_age_group", "eq", grp);
  const quotas = [
    {
      id: "quota_gender", name: "Gender 50/50", mode: "hard", targetTotal: 300,
      cells: [
        { id: "qg_male", label: "Male 50%", when: g(1), limit: 50, limitType: "percent" },
        { id: "qg_female", label: "Female 50%", when: g(2), limit: 50, limitType: "percent" },
      ],
      onFull: { kind: "terminate" },
    },
    {
      id: "quota_age", name: "Age groups", mode: "hard", targetTotal: 300,
      cells: [
        { id: "qa_18_24", label: "18–24 = 20%", when: age("18-24"), limit: 20, limitType: "percent" },
        { id: "qa_25_34", label: "25–34 = 30%", when: age("25-34"), limit: 30, limitType: "percent" },
        { id: "qa_35_44", label: "35–44 = 25%", when: age("35-44"), limit: 25, limitType: "percent" },
        { id: "qa_45", label: "45+ = 25%", when: age("45+"), limit: 25, limitType: "percent" },
      ],
      onFull: { kind: "terminate" },
    },
    {
      id: "quota_gender_age", name: "Gender × Age (combined cells)", mode: "hard",
      cells: ([[1, "m"], [2, "f"]] as [number, string][]).flatMap(([gc, gk]) =>
        ["18-24", "25-34", "35-44", "45+"].map((grp) => ({
          id: `qga_${gk}_${grp.replace(/[^0-9]/g, "")}`, label: `${gk === "m" ? "Male" : "Female"} ${grp}`,
          when: and(g(gc), age(grp)), limit: gk === "m" ? (grp === "18-24" ? 30 : grp === "25-34" ? 45 : grp === "35-44" ? 38 : 37) : (grp === "18-24" ? 30 : grp === "25-34" ? 45 : grp === "35-44" ? 37 : 38),
          limitType: "count",
        }))),
      onFull: { kind: "terminate" },
    },
    {
      id: "quota_soft_region", name: "Soft quota — North America (flag only)", mode: "soft", targetTotal: 300,
      cells: [{ id: "qs_na", label: "US + Canada ≤ 60%", when: rule("q_country", "in", [1, 8]), limit: 60, limitType: "percent" }],
      onFull: { kind: "flag" },
    },
  ];

  /* ============================================================ list fills */

  const listFills = [
    {
      id: "lf_brand_eval", name: "BRAND_EVAL", label: "Brand evaluation allocation (priority → cap → quota → random fallback)",
      source: { kind: "question", questionId: "q_used", take: "selected" },
      selection: { count: { kind: "calculation", ref: "LF_EVAL_COUNT" }, method: "priority_quota", equalPriority: "random", afterTarget: "continue", afterMaximum: "random_fallback", fallback: "random_eligible", fillToCount: true },
      tracking: { sampleLevel: true, respectQuotas: true, quotaIds: ["quota_gender", "quota_age"], separateTestCounts: true, sampleSize: 300 },
      options: [
        { code: "1", label: "Apple", priority: 1, target: 150, maximum: 150, notes: "Priority 1 — takes the first 150 respondents who used Apple" },
        { code: "2", label: "Samsung", priority: 2, target: 75, maximum: 75, notes: "Priority 2 — used once Apple is capped or not selected" },
        { code: "3", label: "Google", priority: 3, target: 50, maximum: 50, notes: "Priority 3" },
        { code: "4", label: "Xiaomi", priority: 4, notes: "Priority 4 — no cap; joins the random fallback pool" },
        { code: "5", label: "OnePlus", priority: 5, notes: "Priority 5 — no cap; random fallback" },
        ...BRANDS.filter((b) => Number(b.code) > 5).map((b) => ({ code: String(b.code), label: b.label, notes: "No priority, no cap — random fallback pool" })),
      ],
      runWhen: calcRule("N_BRANDS_USED", "gte", 1),
      destinations: [
        { questionId: "h_lf_brand_1", position: 1, write: "answer", whenUnused: "blank" },
        { questionId: "h_lf_brand_2", position: 2, write: "answer", whenUnused: "blank" },
      ],
      repeatBlockId: "p_lf_loop",
      storeTrace: true,
      notes: "[DEMO §10: Priority + quota-aware List Fill] Total sample 300. A (Apple) first until 150, then B (Samsung) until 75, then C (Google) until 50; after that the random fallback among the remaining eligible options. Count = min(2, brands used). Unlisted brands are unlimited and un-prioritised.",
    },
    {
      id: "lf_topic", name: "TOPIC", label: "Random deep-dive topic (no sample tracking)",
      source: { kind: "static", items: [
        { code: "privacy", label: "privacy" }, { code: "sustainability", label: "sustainability" }, { code: "repairability", label: "repairability" },
        { code: "pricing", label: "pricing" }, { code: "customer_service", label: "customer service" }, { code: "innovation", label: "innovation" },
      ] },
      selection: { count: { kind: "fixed", n: 1 }, method: "random", fallback: "random_eligible" },
      tracking: { sampleLevel: false, respectQuotas: false },
      destinations: [{ questionId: "h_lf_topic", position: 1, write: "answer" }],
      notes: "[DEMO: Randomized List Fill] Pure per-respondent random assignment.",
    },
    {
      id: "lf_trust", name: "TRUST", label: "One brand from the hidden used ∩ trusted list",
      source: { kind: "question", questionId: "h_lf_source", take: "selected" },
      selection: { count: { kind: "fixed", n: 1 }, method: "balanced_random", fallback: "balanced_eligible" },
      tracking: { sampleLevel: true, respectQuotas: false, sampleSize: 300 },
      options: BRANDS.map((b) => ({ code: String(b.code), label: b.label, target: 25 })),
      runWhen: rule("h_lf_source", "answered"),
      destinations: [],
      notes: "[DEMO: List Fill from a hidden, script-built source + balanced targets] Every brand has target 25 of 300; the engine favours whichever is furthest below target.",
    },
  ];

  /* ============================================================ scripts */

  const scripts = [
    {
      id: "js_on_load", name: "On load — stamp build tag and log embedded data", scope: "survey", event: "on_load",
      code: [
        "// [DEMO: Custom variable assignment] Runs once when the survey opens.",
        "setCalc('BUILD_TAG', 'MASTER_DEMO_2026_v1');",
        "log('panel', getEmbedded('PANEL_ID'), 'source', getEmbedded('SOURCE'));",
      ].join("\n"),
      notes: "[DEMO: on_load script] Writes a calculated variable that is exported with every response.",
    },
    {
      id: "js_spend_band", name: "On change — dynamic spend band text", scope: "question", ref: "q_monthly_spend", event: "on_change",
      code: [
        "// [DEMO: Dynamic text] Recomputed on every change of MONTHLY_SPEND; piped as {{calc.SPEND_BAND_TEXT}}.",
        "const s = Number(get('q_monthly_spend'));",
        "setCalc('SPEND_BAND_TEXT', !Number.isFinite(s) ? '' : s < 50 ? 'a light' : s < 200 ? 'a moderate' : 'a heavy');",
      ].join("\n"),
    },
    {
      id: "js_hidden_list_source", name: "On submit — build hidden List Fill source (used ∩ trusted)", scope: "page", ref: "p_brand_used", event: "on_submit",
      code: [
        "// [DEMO: Hidden question written by script] Intersection of BRANDS_USED and BRANDS_TRUSTED → LF_SOURCE_LIST.",
        "const used = (get('q_used') || []).map(String);",
        "const trusted = (get('q_trusted') || []).map(String);",
        "const both = used.filter((c) => trusted.includes(c)).map(Number);",
        "set('h_lf_source', both);",
        "setCalc('N_USED_AND_TRUSTED', both.length);",
        "log('hidden list source', both);",
      ].join("\n"),
    },
    {
      id: "js_invalid_years", name: "On submit — detect implausible years-used (feeds LOOP_005)", scope: "page", ref: "p_brand_grids_2", event: "on_submit",
      code: [
        "// [DEMO: Custom logic defining 'invalid' items] Any brand with more years than the respondent's age.",
        "const years = get('q_years_used') || {};",
        "const age = Number(get('q_age'));",
        "const bad = [];",
        "for (const [code, y] of Object.entries(years)) {",
        "  const n = Number(y);",
        "  setCalc('INVALID_YEARS_' + code, Number.isFinite(n) ? n : '');",
        "  if (Number.isFinite(n) && Number.isFinite(age) && n > age) bad.push({ code, label: String(n) });",
        "}",
        "setCalc('INVALID_BRANDS', bad); // [{code, label}] → LOOP_005 items: code = brand, label = years entered",
        "setCalc('N_INVALID_BRANDS', bad.length);",
        "if (bad.length) flag('implausible_years_used');",
        "log('invalid brands', bad);",
      ].join("\n"),
      notes: "Writes INVALID_BRANDS ([{code, label}]) — the `variable` source of LOOP_005 — and INVALID_YEARS_<code> for export.",
    },
    {
      id: "js_date_order", name: "On submit — warranty end must not precede purchase (custom validation)", scope: "page", ref: "p_demo_dates", event: "on_submit",
      code: [
        "// [DEMO: Custom JavaScript validation] error(message, questionRef) blocks the page.",
        "const bought = get('q_last_purchase'); const ends = get('q_warranty_end');",
        "if (bought && ends && String(ends) < String(bought)) error('The warranty cannot end before the purchase date (' + bought + ').', 'q_warranty_end');",
      ].join("\n"),
    },
    {
      id: "js_upgrade_window", name: "On submit — upgrade window To ≥ From", scope: "page", ref: "p_val_2", event: "on_submit",
      code: [
        "// [DEMO: Custom validation across composite columns]",
        "const w = (get('q_upgrade_dates') || {}).w || {};",
        "if (w.c_from && w.c_to && String(w.c_to) < String(w.c_from)) error('The end of your upgrade window cannot be before its start.', 'q_upgrade_dates');",
      ].join("\n"),
    },
    {
      id: "js_loop_inspect", name: "On submit — loop & reference inspection (LOOP_001 page a)", scope: "page", ref: "p_l1_a", event: "on_submit",
      code: [
        "// [DEMO: Loop inspection + reference inspection from a script]",
        "const item = getCurrentLoopItem();",
        "if (item) {",
        "  log('LOOP_001 iteration', getCurrentLoopIndex(), 'of', getLoopCount(), item.code, item.label, item.references);",
        "  setCalc('LAST_CLIENT_CODE', getCurrentLoopReference('Client_Code'));",
        "  setCalc('LOOP_001_VISITED_' + item.code, 1);",
        "}",
      ].join("\n"),
    },
    {
      id: "js_complete_flags", name: "On submit — final page flags", scope: "page", ref: "p_final", event: "on_submit",
      code: [
        "// [DEMO: Flags for the quality/response view]",
        "const score = Number(getCalc('ENGAGEMENT_SCORE'));",
        "if (score >= 70) flag('digital_native');",
        "if (get('q_recontact') === 1) flag('recontact_ok');",
      ].join("\n"),
    },
  ];

  /* ============================================================ display rules */

  const displayRules = [
    { id: "dr_hide_income_prompt", label: "Hide the investment page-level question for 'prefer not to say' income", target: { kind: "question", ref: "q_invest" }, action: "hide", when: rule("q_income", "in", [98, 99]) },
    { id: "dr_show_work_page", label: "Work profile page only for the employed", target: { kind: "page", ref: "p_demo_work" }, action: "show", when: rule("q_employment", "in", [1, 2, 3]) },
  ];

  /* ============================================================ assemble */

  const raw = {
    meta: {
      id: surveyId, code: "MASTER_DEMO_2026", title: "Master Demo — 2026 Consumer Technology, Finance & Digital Lifestyle Study",
      description: "Capability showcase: every question type, display/skip/branch logic, piping, carry-forward, list operations, priority + quota-aware List Fill, four loop kinds with loop-scoped reference columns, a nested loop, randomization, auto-punch, calculations, validation, hidden variables, quotas, custom JavaScript, Conjoint, MaxDiff and a custom design — all connected.",
      version: "1.0", status: "testing",
    },
    branding: {
      colors: { primary: "#1d4ed8", secondary: "#0f172a" },
      layout: { showBlockTitles: false, progressStyle: "percent" },
      buttons: { nextLabel: "Next", backLabel: "Back", submitLabel: "Finish", showBack: true, style: "solid" },
      footerHtml: "<span>Master Demo · build {{calc.BUILD_TAG}} · wave {{ed.WAVE}}</span>",
    },
    embeddedData: [
      { name: "PANEL_ID", label: "Panel respondent id", source: "url", defaultValue: "DEMO-PANEL" },
      { name: "SOURCE", label: "Traffic source", source: "url", defaultValue: "direct" },
      { name: "WAVE", label: "Fieldwork wave", source: "static", defaultValue: "2026-W36" },
      { name: "SAMPLE_TYPE", label: "Derived sample type", source: "expression", dataType: "string" },
    ],
    questions, flow, logicFlow, displayRules, calculations, quotas, scripts, designs, listFills,
    deployment: { clientSlug: "demo", studySlug: "master-demo-2026", access: { mode: "open", allowRetake: true, captureAnonymous: true } },
    quality: {},
  };

  return SurveyDefinition.parse(raw);
}

/* ============================================================ test paths (§53) */

export interface DemoTestPath {
  id: string;
  title: string;
  description: string;
  /** answers keyed by question id (survey-level keys) */
  answers: Record<string, unknown>;
  /** URL / embedded data */
  embedded?: Record<string, string>;
  seed: number;
  expect: string[];
}

const COMMON = {
  q_consent: 1, q_confirm: 1, q_age: 29, q_country: 1, q_region: "us_w", q_city: "Seattle", q_email: "demo@example.com", q_contact_ok: 2,
  q_employment: 1, q_devices: [1, 2, 5], q_purchase_role: 1, q_use_type: 3, q_attention: 4,
  q_gender: 2, q_hh_size: 3, q_hh_children: 1, q_income: 5, q_education: 5, q_industry: 1, q_job_level: 5, q_company_size: 4,
  q_last_purchase: "2026-03-10", q_warranty_end: "2028-03-10", q_shop_time: "20:30", q_fin_products: [1, 3, 6, 9],
  q_hours_online: 5, q_activities: { a1: 1, a2: 2, a3: 3, a4: 1, a5: 3, a6: 5, a7: 1, a8: 4 }, q_apps: [1, 2, 3, 8, 14], q_form_factor: ["slab"],
  q_priority_rank: [2, 1, 4], q_nps_device: 8, q_monthly_spend: 120, q_sub_spend: 40, q_hw_spend: 50,
  q_spend_split: { 1: 50, 2: 20, 3: 15, 4: 10, 5: 5 }, q_pct_online: 70, q_spend_by_type: { phone: 900, computer: 0, wearable: 250, accessory: 80 }, q_budget_next: 2000,
  q_smartwatch_sat: 4, q_invest: [1, 2], q_consumer_focus: 1, q_business_function: 2, q_blend: 2,
  q_unaided: { b1: "Apple", b2: "Samsung" },
};

/** The seven intentional paths — used by the tests and documented for manual testers. */
export const MASTER_DEMO_TEST_PATHS: DemoTestPath[] = [
  {
    id: "A", title: "Apple + Google + Samsung", seed: 101,
    description: "Three brands used → LOOP_001 runs 3 times (with the nested feature loop), LOOP_003 covers the aware-but-unused brands, List Fill allocates 2.",
    answers: { ...COMMON, q_aware: [1, 2, 3, 4, 6, 9], q_used: [1, 3, 2], q_trusted: [1, 3], q_fav_brand: 1, q_fav_why: "Ecosystem and privacy.",
      q_years_used: { 1: 8, 2: 2, 3: 4 }, q_detail_interest: 1, q_n_products: 2 },
    expect: ["LOOP_001 iterates Apple, Google, Samsung in selection order", "nested LOOP_002 runs 3 features per brand", "LOOP_003 covers up to 3 of Xiaomi/Sony/Huawei", "LOOP_004 covers Huawei (market exit)", "List Fill count = 2"],
  },
  {
    id: "B", title: "Apple only", seed: 102,
    description: "One brand → single loop iteration, List Fill allocates exactly one item (count = min(2, 1)); LF_SAT_2 is hidden.",
    answers: { ...COMMON, q_aware: [1, 2, 3], q_used: [1], q_trusted: [1, 2], q_fav_brand: 1, q_fav_why: "It just works.", q_years_used: { 1: 10 }, q_detail_interest: 1, q_n_products: 1 },
    expect: ["LOOP_001 runs once", "LISTFILL_BRAND_EVAL_COUNT = 1", "q_lf_sat_2 hidden"],
  },
  {
    id: "C", title: "Five or more brands", seed: 103,
    description: "Seven brands used → LOOP_001 capped at 6 by the LOOP_CAP calculation; every list operation has a non-empty result.",
    answers: { ...COMMON, q_aware: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12], q_used: [1, 2, 3, 4, 5, 6, 7], q_trusted: [1, 2, 7], q_fav_brand: 2, q_fav_why: "Best screens.",
      q_years_used: { 1: 3, 2: 5, 3: 1, 4: 2, 5: 1, 6: 12, 7: 15 }, q_detail_interest: 1, q_n_products: 5 },
    expect: ["LOOP_001 runs 6 times (cap)", "LOOP_006 runs 5 times", "curious/consider/core/never-seen lists all non-empty"],
  },
  {
    id: "D", title: "Fails screening", seed: 104,
    description: "Declines consent → terminated as 'screened' on the first page; nothing else is asked.",
    answers: { q_consent: 2 },
    expect: ["status screened after page 1"],
  },
  {
    id: "E", title: "Quota full", seed: 105,
    description: "Female 25–34 when that combined cell (and the gender cell) is already full → quota_check terminates with status 'quota_full'.",
    answers: { ...COMMON },
    expect: ["status quota_full at the quota_check node"],
  },
  {
    id: "F", title: "List Fill cap reached", seed: 106,
    description: "Apple used, but Apple has already hit its maximum of 150 → the engine moves down the priority order (Samsung), demonstrating cap + fallback.",
    answers: { ...COMMON, q_aware: [1, 2, 3], q_used: [1, 2, 3], q_trusted: [1, 2], q_fav_brand: 1, q_fav_why: "Long-time user.", q_years_used: { 1: 1, 2: 1, 3: 1 }, q_detail_interest: 1, q_n_products: 1 },
    expect: ["Apple rejected (maximum_reached)", "Samsung allocated at position 1"],
  },
  {
    id: "H", title: "Shorter version (skip logic to a section)", seed: 108,
    description: "Declines the detailed evaluation → the skip rule on DETAIL_INTEREST jumps over 06_List_Fill, 07_List_Operations and the three loop groups straight to 11_Loop_Count.",
    answers: { ...COMMON, q_aware: [1, 2, 3], q_used: [1, 2], q_trusted: [1, 2], q_fav_brand: 1, q_fav_why: "Habit.", q_years_used: { 1: 2, 2: 1 }, q_detail_interest: 2, q_n_products: 1 },
    expect: ["no List Fill, list-operation or LOOP_001/003/004 pages", "p_l6_count follows p_brand_detail_gate directly"],
  },
  {
    id: "G", title: "Multiple loop iterations + invalid years", seed: 107,
    description: "Four brands used, one with an implausible years-used entry → LOOP_001 ×4, LOOP_005 ×1 (script-detected invalid item), N_PRODUCTS = 3 → LOOP_006 ×3.",
    answers: { ...COMMON, q_aware: [1, 2, 3, 4, 5, 6], q_used: [1, 2, 3, 4], q_trusted: [1, 2], q_fav_brand: 3, q_fav_why: "Clean software.",
      q_years_used: { 1: 5, 2: 40, 3: 3, 4: 1 }, q_l5_fix_years: 4, q_detail_interest: 1, q_n_products: 3 },
    expect: ["LOOP_001 runs 4 times", "LOOP_005 runs once for Samsung (40 years > age 29)", "LOOP_006 runs 3 times"],
  },
];
