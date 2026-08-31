/**
 * Builds the demo "Smartphone Brand Study" — exercises carry-forward, piping,
 * composite multi-column questions, branching, loops, calculations, quotas,
 * skip logic, scripts, MaxDiff design, branding.
 */
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { registerBuiltinDesignGenerators } from "../packages/designs/dist/index.js";
import { designGeneratorRegistry } from "../packages/schema/dist/index.js";

registerBuiltinDesignGenerators();

export function buildDemoDefinition(surveyId) {
  const maxdiff = designGeneratorRegistry.get("maxdiff").generate(
    {
      items: ["Battery life", "Camera quality", "Price", "Screen size", "Brand reputation", "5G speed"],
      tasks: 5, itemsPerTask: 4, versions: 1,
    },
    4242,
  );

  const raw = {
    meta: {
      id: surveyId,
      code: "DEMO_BRAND_01",
      title: "Smartphone Brand Study (Demo)",
      description: "Demonstration survey exercising the full Rescript feature set.",
      version: "1.0",
      status: "testing",
    },
    branding: {
      colors: { primary: "#1d4ed8" },
      buttons: { nextLabel: "Next", backLabel: "Back", submitLabel: "Finish", showBack: true, style: "solid" },
      footerHtml: "<span>Powered by Rescript · {{ed.SOURCE}}</span>",
    },
    embeddedData: [{ name: "SOURCE", label: "Traffic source", source: "url" }],
    questions: [
      {
        id: "q_consent", code: "Q0", variableName: "CONSENT", type: "single_select",
        text: "Do you agree to participate in this short research study?",
        required: true,
        options: [
          { code: 1, label: "Yes, I agree" },
          { code: 2, label: "No, I do not agree" },
        ],
        skipLogic: [
          {
            id: "skip_noconsent",
            when: { type: "rule", source: { kind: "question", ref: "q_consent" }, operator: "eq", value: 2 },
            target: { kind: "terminate", status: "screened" },
          },
        ],
      },
      {
        id: "q_age", code: "Q1", variableName: "AGE", type: "numeric",
        text: "How old are you?", required: true,
        settings: { minValue: 16, maxValue: 99 },
        validation: [{ kind: "integer", message: "Please enter your age in whole years." }],
      },
      {
        id: "q_gender", code: "Q2", variableName: "GENDER", type: "single_select",
        text: "How do you identify?", required: true,
        options: [
          { code: 1, label: "Male" }, { code: 2, label: "Female" },
          { code: 3, label: "Non-binary / other" }, { code: 99, label: "Prefer not to say", flags: ["anchor_bottom"] },
        ],
      },
      {
        id: "q_brands", code: "Q3", variableName: "BRANDS", type: "multi_select",
        text: "Which smartphone brands do you know?", required: true,
        settings: { minSelections: 1 },
        randomization: { enabled: true, scope: "options", method: "shuffle" },
        options: [
          { code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" },
          { code: 4, label: "OnePlus" }, { code: 5, label: "Xiaomi" },
          { code: 98, label: "None of these", flags: ["none_of_above", "anchor_bottom"] },
        ],
        skipLogic: [
          {
            id: "skip_nobrands",
            when: { type: "rule", source: { kind: "question", ref: "q_brands" }, operator: "selected", value: 98 },
            target: { kind: "terminate", status: "screened" },
          },
        ],
      },
      {
        id: "q_fav", code: "Q4", variableName: "FAV_BRAND", type: "single_select",
        text: "Earlier you selected {{Q3}}. Which is your favorite?",
        required: true,
        carryForward: { sourceQuestionId: "q_brands", filter: "selected", into: "options", keepOwn: false },
        displayLogic: { type: "rule", source: { kind: "question", ref: "q_brands" }, operator: "answered" },
      },
      {
        id: "q_why", code: "Q5", variableName: "FAV_WHY", type: "long_text",
        text: "Why did you choose {{Q4}}?",
        validation: [{ kind: "min_length", value: 3, message: "Please tell us a little more." }],
      },
      {
        id: "q_grid", code: "Q6", variableName: "BRAND_GRID", type: "composite",
        text: "Please provide the following for each brand you know.",
        instruction: "Each column captures a separate variable per brand.",
        required: false,
        carryForward: { sourceQuestionId: "q_brands", filter: "selected", into: "rows", keepOwn: false },
        columns: [
          {
            id: "c_owned", label: "Ever owned?", responseType: "single", variableStem: "OWNED",
            options: [{ code: 1, label: "Yes" }, { code: 0, label: "No" }], validation: [], readOnly: false,
          },
          {
            id: "c_rating", label: "Rating (1–10)", responseType: "numeric", variableStem: "RATING",
            min: 1, max: 10, options: [], validation: [], readOnly: false,
          },
          {
            id: "c_channel", label: "Where would you buy?", responseType: "dropdown", variableStem: "CHANNEL",
            options: [
              { code: 1, label: "Official store" }, { code: 2, label: "Carrier" },
              { code: 3, label: "Online marketplace" }, { code: 4, label: "Second-hand" },
            ],
            validation: [], readOnly: false,
          },
          {
            id: "c_comment", label: "Comment", responseType: "text", variableStem: "COMMENT",
            options: [], validation: [], readOnly: false,
          },
        ],
      },
      {
        id: "q_nps", code: "Q7", variableName: "NPS", type: "nps",
        text: "How likely are you to recommend {{Q4}} to a friend or colleague?",
        required: true, settings: { minValue: 0, maxValue: 10 },
      },
      {
        id: "q_budget", code: "Q8", variableName: "BUDGET", type: "allocation",
        text: "You have 100 points. Allocate them across what matters most in a phone.",
        required: true,
        settings: { sumTarget: 100, sumUnit: " pts" },
        options: [
          { code: "battery", label: "Battery life" }, { code: "camera", label: "Camera" },
          { code: "price", label: "Price" }, { code: "design", label: "Design" },
        ],
      },
      {
        id: "q_maxdiff", code: "Q9", variableName: "MD", type: "maxdiff_task",
        text: "For each set, pick the feature that matters MOST and LEAST to you.",
        settings: { designRef: "design_maxdiff_demo" },
      },
      {
        id: "q_hidden_seg", code: "H1", variableName: "SEGMENT", type: "calculated",
        text: "Derived segment", settings: { expression: "if(NPS >= 9, 'promoter', if(NPS >= 7, 'passive', 'detractor'))", hidden: true },
      },
    ],
    calculations: [
      { id: "calc_nbrands", targetVariable: "N_BRANDS", expression: "count(BRANDS)", trigger: "on_page_submit", dataType: "numeric" },
      { id: "calc_score", targetVariable: "ENGAGEMENT", expression: "round(avg(RATING_*) * 10, 1)", trigger: "on_page_submit", dataType: "numeric" },
    ],
    quotas: [
      {
        id: "quota_gender", name: "Gender 50/50", mode: "hard", targetTotal: 200,
        cells: [
          { id: "cell_male", label: "Male", when: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 1 }, limit: 50, limitType: "percent" },
          { id: "cell_female", label: "Female", when: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 2 }, limit: 50, limitType: "percent" },
        ],
        onFull: { kind: "terminate" },
        countStatus: ["complete"],
      },
    ],
    scripts: [
      {
        id: "script_flag", name: "Flag heavy allocators", scope: "survey", event: "on_submit",
        code: "const pts = expr('BUDGET_camera'); if (pts != null && pts > 60) flag('camera_lover'); log('camera pts', pts);",
        enabled: true,
      },
    ],
    designs: [
      {
        id: "design_maxdiff_demo", kind: "maxdiff", name: "Feature MaxDiff", version: 1, seed: 4242,
        config: { items: ["Battery life", "Camera quality", "Price", "Screen size", "Brand reputation", "5G speed"], tasks: 5, itemsPerTask: 4, versions: 1 },
        file: { format: "json", columns: maxdiff.columns, rows: maxdiff.rows, generatedAt: new Date().toISOString() },
      },
    ],
    flow: [
      { type: "embedded_data", id: "ed_url", fields: [{ name: "SOURCE", source: "url" }] },
      { type: "page", id: "p_consent", title: "Welcome", questionIds: ["q_consent"] },
      {
        type: "section", id: "sec_screener", title: "Screener",
        children: [
          { type: "page", id: "p_demo", title: "About you", questionIds: ["q_age", "q_gender"] },
          {
            type: "branch", id: "br_age",
            branches: [
              {
                id: "br_minor",
                label: "Under 18 → screened",
                when: { type: "rule", source: { kind: "question", ref: "q_age" }, operator: "lt", value: 18 },
                children: [{ type: "end", id: "end_minor", status: "screened", message: "Thanks — this study is for adults only." }],
              },
            ],
          },
          { type: "quota_check", id: "qc_gender", quotaIds: ["quota_gender"], onFull: { kind: "terminate" } },
        ],
      },
      {
        type: "section", id: "sec_brands", title: "Brands",
        children: [
          { type: "page", id: "p_brands", questionIds: ["q_brands"] },
          { type: "page", id: "p_fav", questionIds: ["q_fav", "q_why"] },
          { type: "page", id: "p_grid", questionIds: ["q_grid"] },
        ],
      },
      {
        type: "section", id: "sec_deep", title: "Deep dive",
        children: [
          { type: "page", id: "p_nps", questionIds: ["q_nps"] },
          { type: "page", id: "p_budget", questionIds: ["q_budget"] },
          { type: "page", id: "p_maxdiff", questionIds: ["q_maxdiff"] },
        ],
      },
      { type: "end", id: "end_ok", status: "complete", message: "Thank you, {{Q4}} fan — you're all done! Your engagement score: {{calc.ENGAGEMENT}}" },
    ],
    deployment: { clientSlug: "demo", studySlug: "brand-study", access: { mode: "open", allowRetake: true, captureAnonymous: true } },
  };

  return SurveyDefinition.parse(raw);
}
