/**
 * THE DEVELOPER DOCS' LIVE EXAMPLES (2026-11-09). Each example is a small survey built the way the product builds
 * one — survey actions through the engine's own `applySurveyActions` (the same path the editor's commands and
 * Intelligent Mode take), plus, where no action exists, a patch in the documented schema shape that
 * `SurveyDefinition.parse` must accept. Nothing here is a mock: the page shows
 *
 *   · BUILDER — a screenshot of the real Studio with this survey loaded, captured by
 *     `scripts/capture-docs-builder.mjs` from `builder` below (re-run it when the editor changes);
 *   · EXPRESSION — the logic as the engine prints it (`formatCondition`) and the stored JSON of the parts involved;
 *   · RESPONDENT — the survey itself, drawn by the real renderer and moved page to page by the real engine.
 *
 * `build.test.ts` builds every example and fails on any refused action, schema error or broken reference.
 */
export interface BuilderShot {
  /** the Studio tool to open (the menubar label) — default Questions */
  tab?: string;
  /** Questions: the question (code) whose editor is opened */
  question?: string;
  /** Questions: the Properties section to open and show beside it (its id, e.g. "display-logic") */
  section?: string;
  /** what to say under the picture */
  caption: string;
}

export interface DocExample {
  id: string;
  title: string;
  /** survey actions, applied to an empty survey in order */
  actions: Record<string, unknown>[];
  /** fields no action sets, in the schema's own shape — applied after the actions, then re-parsed */
  patch?: (def: Record<string, any>, q: (code: string) => Record<string, any>) => void;
  /** the questions whose stored JSON is shown (codes); default every question */
  show?: string[];
  /** also show these flow nodes' JSON (by type) */
  flow?: string[];
  /** what to try in the live survey */
  tryIt: string;
  builder: BuilderShot;
  /** embedded values the live survey starts with (as if they came on the link) */
  embedded?: Record<string, string>;
}

const opts = (...labels: string[]) => labels;

export const DOC_EXAMPLES: DocExample[] = [
  /* ---------------------------------------------------------------- A · question types */
  {
    id: "single-select", title: "A single-select question",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "BRAND", text: "Which brand of smartphone do you use most often?", options: opts("Apple", "Samsung", "Google", "OnePlus"), required: true },
    ],
    tryIt: "Pick a brand, then change your mind — a single-select keeps one answer. Press Next without answering to see the required message.",
    builder: { question: "Q1", caption: "Questions → Q1 open: the family Single Select, the type Radio Button, the options with their codes, and Required." },
  },
  {
    id: "multi-select", title: "A multi-select question with a None option",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "STREAM", text: "Which of these streaming services do you subscribe to?", instruction: "Select all that apply.", options: ["Netflix", "Prime Video", "Disney+", "Apple TV+", { label: "None of these", exclusive: true, anchor: true }], required: true },
    ],
    tryIt: "Tick several services, then tick “None of these” — the others are cleared, because that option is exclusive.",
    builder: { question: "Q1", caption: "A Checkbox multi-select. The last option carries the exclusive and anchor flags (its properties… button)." },
  },
  {
    id: "text-entry", title: "Short text entry, with a format check",
    actions: [
      { op: "create_question", type: "open_text", code: "Q1", variable: "FNAME", text: "What is your first name?", required: true },
      { op: "create_question", type: "email", code: "Q2", variable: "EMAIL", text: "And your email address, {{Q1}}?", required: true },
    ],
    tryIt: "Type a name — it is piped into the next question. Type “abc” as the email and press Next to see the format check.",
    builder: { question: "Q2", section: "validation-rules", caption: "Q2 is a Single-Line Text with the Email subtype; its format check is listed under Validation rules." },
  },
  {
    id: "numeric-entry", title: "A numeric answer with a range",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "HHSIZE", text: "How many people, including you, live in your household?", required: true,
        validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 20, message: "Please enter a number from 1 to 20." }] },
    ],
    tryIt: "Enter 0 or 25 and press Next: the range check stops you with the message written for it.",
    builder: { question: "Q1", section: "validation-rules", caption: "An Integer question; the 1–20 range is two validation rules, one with its own message." },
  },
  {
    id: "open-ended", title: "An open-ended question",
    actions: [
      { op: "create_question", type: "long_text", code: "Q1", variable: "IMPROVE", text: "What one thing could we do to improve your experience?", required: true,
        validation: [{ kind: "min_length", value: 10, message: "Please tell us a little more (10 characters or more)." }] },
    ],
    tryIt: "Type a few letters and press Next: the minimum length asks for more.",
    builder: { question: "Q1", caption: "A Multi-Line Text question (family Text / Open End) with a minimum length." },
  },
  {
    id: "ranking", title: "A ranking question",
    actions: [
      { op: "create_question", type: "ranking", code: "Q1", variable: "RANKF", text: "Rank these features from most to least important to you.", options: opts("Battery life", "Camera", "Price", "Screen size", "Storage"), required: true },
    ],
    tryIt: "Drag the features (or use the keyboard) into your order; the stored answer is the rank of each one.",
    builder: { question: "Q1", caption: "A Drag-and-Drop Ranking question: the items are its options." },
  },
  {
    id: "rating-scales", title: "A rating scale and an NPS question",
    actions: [
      { op: "create_question", type: "rating", code: "Q1", variable: "SAT", text: "Overall, how satisfied are you with your phone?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, required: true },
      { op: "create_question", type: "nps", code: "Q2", variable: "NPS", text: "How likely are you to recommend your phone to a friend or colleague?", required: true },
    ],
    tryIt: "Answer both: a labelled 5-point scale stores 1–5, the NPS question stores 0–10.",
    builder: { question: "Q1", caption: "A 5-point scale is a single-select whose options are the scale points (1–5), the end points labelled." },
  },
  {
    id: "matrix-questions", title: "A single-select matrix (Likert grid)",
    actions: [
      { op: "create_question", type: "grid", code: "Q1", variable: "ATT", text: "How much do you agree with each statement?", rows: ["The app is easy to use", "The app is good value", "I would recommend the app"],
        scale: { points: 5, labels: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"] }, required: true },
    ],
    tryIt: "Answer each row; press Next with a row empty to see which row is missing.",
    builder: { question: "Q1", caption: "A Single-Select Matrix: the statements are rows, the scale points are the columns." },
  },
  {
    id: "grid-questions", title: "A numeric grid (several answers per row)",
    actions: [
      { op: "create_question", type: "matrix_numeric", code: "Q1", variable: "SPEND", text: "Roughly how much do you spend on each, per month?", rows: ["Groceries", "Eating out", "Transport"] },
    ],
    patch: (_d, q) => {
      const x = q("Q1");
      x.columns = [{ id: "c1", label: "Amount ($)", responseType: "numeric", variableStem: "SPEND_AMT" }, { id: "c2", label: "Visits", responseType: "numeric", variableStem: "SPEND_VISITS" }];
    },
    tryIt: "Fill an amount and a number of visits for each row.",
    builder: { question: "Q1", caption: "A Numeric Matrix (composite grid): rows are the items, columns are fields of their own type." },
  },

  /* ---------------------------------------------------------------- A · special options */
  {
    id: "other-specify", title: "An “Other, please specify” option",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "SOURCE", text: "Where did you first hear about us?", options: ["Search engine", "Social media", "A friend", { label: "Other (please specify)", other: true, code: 99 }], required: true },
    ],
    tryIt: "Pick “Other” — a text box appears; press Next with it empty: the text is required.",
    builder: { question: "Q1", caption: "The Other option carries the other/specify flag; the box's default and “Require the Other text” are under the options." },
  },
  {
    id: "exclusive-options", title: "An exclusive option on a multi-select",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "DEVICES", text: "Which devices do you use to watch TV shows?", options: ["Smart TV", "Laptop", "Phone", "Tablet", { label: "I don't watch TV shows", exclusive: true, anchor: true }], required: true },
    ],
    tryIt: "Select devices, then the last option: everything else is cleared. Select a device again: the exclusive option is cleared.",
    builder: { question: "Q1", caption: "The exclusive flag is set on the option (properties… → exclusive)." },
  },
  {
    id: "none-of-the-above", title: "None of the above",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "FEAT", text: "Which of these features have you used in the last month?", options: ["Offline downloads", "Profiles", "Parental controls", { label: "None of the above", exclusive: true, anchor: true }], required: true, randomize: true },
    ],
    tryIt: "The options are shuffled each time you restart, but “None of the above” stays last and clears the others.",
    builder: { question: "Q1", caption: "“None of the above” is an exclusive option anchored at the bottom, so randomization never moves it." },
  },
  {
    id: "dont-know", title: "“Don't know” — as an option, and beside a typed answer",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "AWARE", text: "Before today, had you heard of the brand Volt?", options: ["Yes", "No", { label: "Don't know", code: 98 }], required: true },
      { op: "create_question", type: "numeric", code: "Q2", variable: "PAID", text: "How much did you pay for your last phone ($)?", required: true, settings: { dontKnow: true } },
    ],
    tryIt: "Q1 has “Don't know” as an answer code (98). On Q2 tick “I don't know” instead of typing — the number box clears, and the choice is stored beside the answer.",
    builder: { question: "Q2", caption: "On a numeric or text question, “Enable I don't know” stores the choice beside the answer (exported as PAID_DK)." },
  },

  /* ---------------------------------------------------------------- A · behaviour */
  {
    id: "mandatory-optional", title: "Required and optional questions",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "GENDER", text: "What is your gender?", options: ["Woman", "Man", "Non-binary", { label: "Prefer not to say", code: 99 }], required: true },
      { op: "create_question", type: "open_text", code: "Q2", variable: "COMMENT", text: "Anything you would like to add? (optional)", required: false },
    ],
    tryIt: "Press Next with nothing answered: only Q1 asks for an answer.",
    builder: { question: "Q1", caption: "The REQUIRED drop-down on the question card: required or optional." },
  },
  {
    id: "question-validation", title: "Validation on single questions",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "TOP2", text: "Pick the two features that matter most to you.", options: opts("Battery", "Camera", "Price", "Design", "Storage"), required: true,
        validation: [{ kind: "min_selections", value: 2 }, { kind: "max_selections", value: 2, message: "Please pick exactly two." }] },
      { op: "create_question", type: "zip", code: "Q2", variable: "ZIP", text: "What is your ZIP code?", required: true },
    ],
    tryIt: "Pick one or three features and press Next. Then type “12” as the ZIP.",
    builder: { question: "Q1", section: "validation-rules", caption: "Validation rules: minimum and maximum selections, each with an optional message." },
  },
  {
    id: "question-randomization", title: "Questions in random order",
    actions: [
      { op: "create_block", title: "Concept A" },
      { op: "create_question", block: "Concept A", type: "rating", code: "Q1", variable: "APPEAL_A", text: "How appealing is Concept A?", scale: { points: 5, low: "Not at all", high: "Very" } },
      { op: "create_block", title: "Concept B" },
      { op: "create_question", block: "Concept B", type: "rating", code: "Q2", variable: "APPEAL_B", text: "How appealing is Concept B?", scale: { points: 5, low: "Not at all", high: "Very" } },
      { op: "create_block", title: "Concept C" },
      { op: "create_question", block: "Concept C", type: "rating", code: "Q3", variable: "APPEAL_C", text: "How appealing is Concept C?", scale: { points: 5, low: "Not at all", high: "Very" } },
      { op: "create_randomizer", blocks: ["Concept A", "Concept B", "Concept C"], title: "Concept order" },
    ],
    flow: ["randomizer"],
    tryIt: "Go through the three concepts, then Restart: the order changes from respondent to respondent.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: a Randomizer holding one block per concept; each respondent gets them in a random order (recorded in an ORDER_ variable)." },
  },
  {
    id: "answer-randomization", title: "Options in random order, with an anchored option",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "PREF", text: "Which of these snacks do you like best?", options: ["Crisps", "Popcorn", "Pretzels", "Nuts", { label: "None of these", anchor: true }], required: true },
      { op: "set_option_randomization", target: "Q1", enabled: true },
    ],
    tryIt: "Restart a few times: the snacks are shuffled, “None of these” always stays last.",
    builder: { question: "Q1", section: "randomization", caption: "Properties → Randomization: shuffle the options; anchored options keep their place." },
  },

  /* ---------------------------------------------------------------- B · dynamic content */
  {
    id: "piping", title: "Piping an earlier answer into a question",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "BRAND", text: "Which brand of smartphone do you use most often?", options: opts("Apple", "Samsung", "Google"), required: true },
      { op: "create_question", type: "rating", code: "Q2", variable: "BRAND_SAT", text: "How satisfied are you with your {{Q1}} phone?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, newPage: true, required: true },
    ],
    tryIt: "Pick Samsung and press Next: Q2 reads “…your Samsung phone?”. Go Back, pick another brand, and the text follows.",
    builder: { question: "Q2", caption: "In the text editor a pipe shows as a chip (BRAND → Selected option label); stored, it is {{Q1}}. + Piping inserts one." },
  },
  {
    id: "carry-forward", title: "Carrying selected answers forward",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "AWARE", text: "Which of these brands have you heard of?", options: opts("Apple", "Samsung", "Google", "OnePlus", "Xiaomi"), required: true },
      { op: "create_question", type: "single_select", code: "Q2", variable: "FAV", text: "And which of those is your favourite?", options: opts("Apple", "Samsung", "Google", "OnePlus", "Xiaomi"), newPage: true, required: true },
    ],
    patch: (_d, q) => { q("Q2").carryForward = { sourceQuestionId: q("Q1").id, filter: "selected", into: "options" }; },
    tryIt: "Select two or three brands, press Next: Q2 offers only those.",
    builder: { question: "Q2", section: "carry-forward", caption: "Properties → Carry-forward: Q2's answer list is the options selected at Q1." },
  },
  {
    id: "masking", title: "Masking options with a set expression",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "USED", text: "Which of these brands have you ever bought?", options: opts("Apple", "Samsung", "Google", "OnePlus"), required: true },
      { op: "create_question", type: "multi_select", code: "Q2", variable: "CONSIDER", text: "Which of the brands you have NOT bought would you consider?", options: opts("Apple", "Samsung", "Google", "OnePlus"), newPage: true },
      { op: "set_mask", target: "Q2", expression: "Q1.Unselected", action: "display" },
    ],
    tryIt: "Select Apple and Samsung, press Next: Q2 shows only Google and OnePlus.",
    builder: { question: "Q2", section: "masking", caption: "Properties → Masking: display only Q1.Unselected — the options not chosen at Q1." },
  },
  {
    id: "lists", title: "List logic: excluding earlier answers",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "MAIN", text: "Which supermarket do you use most often?", options: opts("FreshCo", "ValueMart", "GreenGrocer", "CityShop"), required: true },
      { op: "create_question", type: "multi_select", code: "Q2", variable: "OTHERS", text: "Which other supermarkets do you also use?", options: ["FreshCo", "ValueMart", "GreenGrocer", "CityShop", { label: "No other", exclusive: true, anchor: true }], newPage: true },
    ],
    patch: (_d, q) => { q("Q2").listLogic = [{ id: "ll_1", sourceQuestionId: q("Q1").id, action: "exclude", which: "selected" }]; },
    tryIt: "Pick ValueMart at Q1: Q2 lists the others only.",
    builder: { question: "Q2", section: "list-logic", caption: "Properties → List logic: exclude what was selected at Q1." },
  },
  {
    id: "loops", title: "A loop over the brands selected",
    actions: [
      { op: "create_question", type: "multi_select", code: "Q1", variable: "OWN", text: "Which of these brands do you own a product from?", options: opts("Apple", "Samsung", "Google"), required: true },
      { op: "create_question", type: "rating", code: "Q2", variable: "LSAT", text: "How satisfied are you with {{loop.label}}?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, newPage: true, required: true },
      { op: "create_loop", from: "Q2", to: "Q2", over: "Q1", loopVar: "brand", title: "Each brand owned" },
    ],
    flow: ["loop"],
    tryIt: "Select two brands: Q2 is asked once for each, with the brand piped in ({{loop.label}}).",
    builder: { tab: "Survey Flow", caption: "Survey Flow: a Loop over Q1's selected options repeats Q2 per brand; answers are stored per item (LSAT_1, LSAT_2…)." },
  },

  /* ---------------------------------------------------------------- B · logic and flow */
  {
    id: "display-logic", title: "Display logic on a question",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "OWNCAR", text: "Do you own a car?", options: opts("Yes", "No"), required: true },
      { op: "create_question", type: "single_select", code: "Q2", variable: "FUEL", text: "What fuel does your car use?", options: opts("Petrol", "Diesel", "Hybrid", "Electric"), required: true },
      { op: "set_display_logic", target: "Q2", expression: "Q1 = 1" },
    ],
    tryIt: "Both questions are on one page: answer Yes and Q2 appears at once; answer No and it disappears.",
    builder: { question: "Q2", section: "display-logic", caption: "Properties → Display logic: “IF Q1 is Yes THEN show Q2”, with Edit logic for the full builder." },
  },
  {
    id: "skip-logic", title: "Skip logic: jump ahead",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "USED_APP", text: "Have you used our app in the last month?", options: opts("Yes", "No"), required: true },
      { op: "create_question", type: "rating", code: "Q2", variable: "APP_SAT", text: "How satisfied are you with the app?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, newPage: true, required: true },
      { op: "create_question", type: "long_text", code: "Q3", variable: "FINAL", text: "Is there anything else you'd like to tell us?", newPage: true },
      { op: "add_skip", from: "Q1", when: "Q1 = 2", to: "Q3" },
    ],
    tryIt: "Answer No and press Next: the survey jumps over Q2 straight to Q3. Restart and answer Yes to see Q2.",
    builder: { question: "Q1", section: "skip-logic", caption: "Properties → Skip logic on Q1: if Q1 is No, go to Q3 when the page is submitted." },
  },
  {
    id: "branching", title: "Branching: a path per group",
    actions: [
      { op: "create_block", title: "Screener" },
      { op: "create_question", block: "Screener", type: "single_select", code: "Q1", variable: "CUST", text: "Are you a current customer?", options: opts("Yes", "No"), required: true },
      { op: "create_block", title: "Customers" },
      { op: "create_question", block: "Customers", type: "rating", code: "Q2", variable: "CSAT", text: "How satisfied are you with our service?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, required: true },
      { op: "create_block", title: "Prospects" },
      { op: "create_question", block: "Prospects", type: "multi_select", code: "Q3", variable: "BARRIER", text: "What has stopped you from trying us?", options: opts("Price", "Not aware", "Happy with current provider", "Other reasons"), required: true },
      { op: "create_branch", blocks: ["Customers"], when: "Q1 = 1", title: "Customer or prospect", otherwise: ["Prospects"] },
    ],
    flow: ["branch"],
    tryIt: "Answer Yes: you get the Customers block. Restart and answer No: you get Prospects instead.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: a Branch / condition — the Customers block when Q1 is Yes, otherwise Prospects." },
  },
  {
    id: "conditional-logic", title: "Conditions that combine answers",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "AGE", text: "How old are you?", required: true },
      { op: "create_question", type: "multi_select", code: "Q2", variable: "SPORTS", text: "Which of these do you do at least once a week?", options: opts("Running", "Cycling", "Swimming", "Gym"), required: true },
      { op: "create_question", type: "single_select", code: "Q3", variable: "WEAR", text: "Would you be interested in a fitness watch made for people like you?", options: opts("Yes", "Maybe", "No"), newPage: true, required: true },
      { op: "set_display_logic", target: "Q3", expression: "Q1 between 18 and 44 AND COUNT(Q2) >= 2" },
    ],
    tryIt: "Enter 30 and tick two sports: Q3 is shown. Enter 60, or tick one sport, and Q3 is not.",
    builder: { question: "Q3", section: "display-logic", caption: "Display logic with two conditions joined by AND — an age range and a count of selections." },
  },
  {
    id: "survey-flow", title: "Flow elements: blocks, a randomizer and an end",
    actions: [
      { op: "create_block", title: "Intro" },
      { op: "create_question", block: "Intro", type: "html", code: "INTRO", text: "<p>Thanks for helping! You will see two short sections, in random order.</p>" },
      { op: "create_block", title: "Food" },
      { op: "create_question", block: "Food", type: "single_select", code: "Q1", variable: "FOOD", text: "Which cuisine do you eat most often?", options: opts("Italian", "Indian", "Chinese", "Mexican"), required: true },
      { op: "create_block", title: "Drinks" },
      { op: "create_question", block: "Drinks", type: "single_select", code: "Q2", variable: "DRINK", text: "Which do you drink most often?", options: opts("Coffee", "Tea", "Juice", "Water"), required: true },
      { op: "create_randomizer", blocks: ["Food", "Drinks"], title: "Section order" },
    ],
    flow: ["randomizer", "end"],
    tryIt: "Restart a few times: Food and Drinks swap order; the intro always comes first and the end screen last.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: the Intro block, a Randomizer over Food and Drinks, then the End of survey." },
  },
  {
    id: "survey-termination", title: "Screening out with a terminate",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "AGE", text: "How old are you?", required: true },
      { op: "create_question", type: "single_select", code: "Q2", variable: "INTENT", text: "How likely are you to buy a new car in the next 12 months?", options: opts("Very likely", "Somewhat likely", "Not likely"), newPage: true, required: true },
      { op: "add_skip", from: "Q1", when: "Q1 < 18", to: "screened" },
    ],
    tryIt: "Enter 16 and press Next: the survey ends with the screened-out message. Restart with 30 to continue.",
    builder: { question: "Q1", section: "skip-logic", caption: "A skip to Terminate (status screened) on Q1 — the usual way a screener ends the survey." },
  },
  {
    id: "redirects", title: "Redirecting at the end, with a panel ID piped in",
    actions: [
      { op: "create_embedded", name: "PID", source: "url" },
      { op: "create_question", type: "single_select", code: "Q1", variable: "DONE", text: "That's the last question — did you enjoy this survey?", options: opts("Yes", "No"), required: true },
    ],
    patch: (d) => {
      const end = d.flow.findIndex((n: any) => n.type === "end");
      d.flow.splice(end, 0, { type: "redirect", id: "rd_panel", url: "https://panel.example.com/complete?pid={{ed.PID}}&status=1" });
    },
    flow: ["redirect", "embedded_data"],
    embedded: { PID: "A123" },
    tryIt: "Answer and press Next: instead of the end screen, the survey shows where it would send the respondent — with PID=A123 (as if it came on the link) piped in.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: a Redirect after the questions, its URL piping the PID captured from the link." },
  },

  /* ---------------------------------------------------------------- B · data and variables */
  {
    id: "embedded-variables", title: "Embedded data used in text and logic",
    actions: [
      { op: "create_embedded", name: "TIER", source: "url" },
      { op: "create_question", type: "single_select", code: "Q1", variable: "RENEW", text: "As a {{ed.TIER}} member, how likely are you to renew?", options: opts("Very likely", "Somewhat likely", "Not likely"), required: true },
      { op: "create_question", type: "open_text", code: "Q2", variable: "GOLDWHY", text: "What is the best part of Gold membership?" },
      { op: "set_display_logic", target: "Q2", expression: "ed.TIER = \"Gold\"" },
    ],
    embedded: { TIER: "Gold" },
    tryIt: "The survey starts as if the link carried ?TIER=Gold: the text pipes it, and Q2 shows because TIER is Gold.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: the Embedded data element that captures TIER from the URL, before the questions that read it." },
  },
  {
    id: "url-parameters", title: "Reading URL parameters",
    actions: [
      { op: "create_embedded", name: "SRC", source: "url" },
      { op: "create_embedded", name: "LANG_HINT", source: "url" },
      { op: "create_question", type: "html", code: "WELCOME", text: "<p>Welcome! You came from <b>{{ed.SRC}}</b>.</p>" },
    ],
    embedded: { SRC: "newsletter", LANG_HINT: "en" },
    tryIt: "Here the link is …/s/abc?SRC=newsletter&LANG_HINT=en — both values are captured and SRC is piped into the welcome text.",
    builder: { tab: "Survey Flow", caption: "Each parameter is an embedded field with source URL; it is exported as a column of the data." },
  },
  {
    id: "quotas", title: "A quota on gender, checked after the screener",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "GENDER", text: "What is your gender?", options: opts("Woman", "Man"), required: true },
      { op: "create_question", type: "rating", code: "Q2", variable: "SAT", text: "How satisfied are you with your bank?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, newPage: true, required: true },
      { op: "create_quota", name: "Gender", cells: [{ label: "Women", when: "Q1 = 1", limit: 200 }, { label: "Men", when: "Q1 = 2", limit: 200 }], mode: "hard", check: true },
    ],
    flow: ["quota_check"],
    tryIt: "In this preview no quota is full yet, so both groups continue. When a cell reaches its limit, the next respondent in it ends at the quota-full screen.",
    builder: { tab: "Quotas", caption: "Quotas: the Gender quota's two cells with their limits and fills; a Quota check element after Q1 applies it." },
  },
  {
    id: "validation-rules", title: "A validation rule across questions",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "HH", text: "How many people live in your household?", required: true },
      { op: "create_question", type: "integer", code: "Q2", variable: "KIDS", text: "How many of them are under 18?", required: true,
        validation: [{ kind: "condition", check: "Q2 <= Q1", message: "That is more people than live in your household ({{Q1}})." }] },
    ],
    tryIt: "Enter 3, then 5 under-18s and press Next: the rule compares the two answers and shows its message with Q1 piped in.",
    builder: { question: "Q2", section: "validation-rules", caption: "A Condition validation rule on Q2: a valid answer must satisfy Q2 <= Q1." },
  },

  /* ---------------------------------------------------------------- B · custom code */
  {
    id: "custom-javascript", title: "A UX script reacting to an answer",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "MOOD", text: "How is your day going?", options: opts("Great", "OK", "Not great"), required: true },
      { op: "create_behavior", label: "Cheer up message", target: "Q1",
        script: "rs.listen('change', 'self', () => {\n  const a = rs.getAnswer('Q1');\n  if (a === 3) rs.showMessage('Q1', 'Sorry to hear that — thanks for still taking part!');\n  else rs.hideMessage('Q1');\n});" },
    ],
    tryIt: "Choose “Not great”: the script — running in its sandbox, as on a live link — shows a message under the question. Choose another answer and it goes away.",
    builder: { question: "Q1", section: "ux", caption: "Properties → Styles, animations & scripts: the behaviour's script, run in a sandboxed frame against the rs API." },
  },
  {
    id: "custom-css", title: "A scoped style: each option as a card, highlighted when selected",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "PLAN", text: "Which plan would you choose?", options: opts("Basic — $5 a month", "Standard — $9 a month", "Premium — $15 a month"), required: true },
      { op: "create_style", label: "Plan cards", target: "Q1.options", rules: [
        { declarations: { border: "2px solid #c7d2fe", "border-radius": "14px", padding: "14px 16px", background: "#f5f7ff", "font-weight": "600" } },
        { state: "selected", declarations: { "border-color": "#4f46e5", background: "#e0e7ff" } },
        { media: "mobile", declarations: { padding: "12px" } },
      ] },
    ],
    tryIt: "The live preview applies the style: every option is a rounded card, and the one you pick turns indigo (the selected state).",
    builder: { question: "Q1", section: "ux", caption: "A style in the UX layer targets Q1's options, with a rule for the selected state; its CSS is compiled and scoped to that question." },
  },
  {
    id: "custom-html-components", title: "An HTML block with piping",
    actions: [
      { op: "create_question", type: "open_text", code: "Q1", variable: "NAME", text: "What should we call you?", required: true },
      { op: "create_question", type: "html", code: "INFO", newPage: true, text: "<h3>Thanks, {{Q1}}!</h3><p>The next section is about <b>your last purchase</b>. It takes about two minutes.</p><style>h3 { color: #4f46e5; }</style>" },
    ],
    tryIt: "Type a name and press Next: the HTML block pipes it; its <style> applies to this block only.",
    builder: { question: "INFO", caption: "A Text / HTML block: HTML (sanitised) with piping; a <style> inside it is scoped to the block." },
  },
];

export const exampleById = (id: string) => DOC_EXAMPLES.find((e) => e.id === id) ?? null;
