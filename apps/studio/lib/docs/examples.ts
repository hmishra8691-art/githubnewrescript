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
  /** Intelligent Mode: type this sentence and photograph the proposal it gets */
  intelligent?: string;
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
  /**
   * INTELLIGENT MODE (phase 2): sentences, in order, read by the engine's own `interpretRequest` on the survey as it
   * stands after the actions (and the sentences before). What the engine proposes is applied exactly as Intelligent
   * Mode applies it on approval; a sentence the engine hands to the language model or refuses is shown as such.
   */
  say?: string[];
  /**
   * SAMPLE OUTPUT (phase 2): run the Studio's own respondent simulation (`runSimulation`, random answers that walk the
   * real survey) and these analyses on its responses — the shape of the output, never findings. `plan` runs the
   * survey's analysis plan instead.
   */
  analysis?: { kind: string; variables: string[]; options?: Record<string, unknown>; label?: string }[] | "plan";
  /** how many simulated respondents (default 150) */
  simulate?: number;
}

const opts = (...labels: string[]) => labels;

/** the small survey the Intelligent Mode examples talk to */
const IM_BASE = (): Record<string, unknown>[] => [
  { op: "create_question", type: "single_select", code: "Q1", variable: "BRAND", text: "Which brand of phone do you use?", options: ["Apple", "Samsung", "Google", { label: "Other", code: 99 }] },
  { op: "create_question", type: "rating", code: "Q2", variable: "SAT", text: "How satisfied are you with your phone?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" }, newPage: true },
  { op: "create_question", type: "long_text", code: "Q3", variable: "WHY", text: "Why do you say that?", newPage: true },
  { op: "create_question", type: "integer", code: "Q4", variable: "AGE", text: "How old are you?", newPage: true },
];

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

  /* ================================================================ C · Intelligent Mode (phase 2) */
  {
    id: "im-overview", title: "Three sentences, read by the engine and applied",
    actions: IM_BASE(),
    say: ["make Q1 and Q2 required", "show Q3 only if Q2 is 1 or 2", "terminate if Q4 < 18"],
    tryIt: "The survey below is the result of the three sentences. Rate 1 or 2 at Q2 to see Q3; enter an age under 18 at Q4 to be terminated.",
    builder: { intelligent: "show Q3 only if Q2 is 1 or 2", caption: "Mode → Intelligent: the sentence, the card saying how it was read, and the proposed change waiting for Apply." },
  },
  {
    id: "im-edit", title: "Changing questions in words",
    actions: IM_BASE(),
    say: ["add Don't know to Q1", "change Q2 to a 7 point scale", "rename Q3 to WHY_SAT", "duplicate Q3", "add a 5-point satisfaction question about the battery"],
    tryIt: "Q1 now ends with an exclusive “Don't know”, Q2 is a 7-point scale and Q3 has a copy. The last sentence needed wording, so it went to the language model (not run here).",
    builder: { intelligent: "change Q2 to a 7 point scale", caption: "The card states exactly what will change — here, that the 7-point scale replaces Q2's five current options." },
  },
  {
    id: "im-logic", title: "Logic, routing and randomization in words",
    actions: IM_BASE(),
    say: ["randomize Q1 options keeping Other last", "show Q3 only if Q2 is 1 or 2", "skip to Q4 if Q2 = 5", "Q4 must be between 18 and 99", "terminate if Q4 < 18"],
    tryIt: "Try Q2 = 5 (Q3 is skipped), Q2 = 1 (Q3 shown), an age of 12 (refused by the range rule) and 16 (terminated). Restart to see Q1's options reshuffled with Other last.",
    builder: { intelligent: "randomize Q1 options keeping Other last", caption: "A randomization request read without a model: Q1's options shuffled, “Other” kept last." },
  },
  {
    id: "im-review", title: "How a sentence was read, before anything changes",
    actions: IM_BASE(),
    say: ["add an open end asking why after Q2", "delete Q2"],
    tryIt: "Nothing is applied until Apply: in this example both proposals were approved, so Q3 sits after Q2 and Q2 is gone. The first card shows the engine saying how it read an unusual sentence.",
    builder: { intelligent: "delete Q2", caption: "A destructive change: the card names the impact (what depends on Q2) and Changes asks for confirmation before Apply." },
  },
  {
    id: "im-validation", title: "What the gate refuses, and the fix it suggests",
    actions: IM_BASE(),
    say: ["make Q9 required", "show Q1 only if Q4 > 30", "skip to Q1 if Q4 = 30", "make Q4 optional"],
    tryIt: "None of these four sentences changed the survey — each was refused with the reason and what to say instead. The survey below is unchanged.",
    builder: { intelligent: "show Q1 only if Q4 > 30", caption: "Refused before anything is applied: Q4 is asked after Q1, with the two ways to fix it." },
  },
  {
    id: "im-troubleshooting", title: "When the engine hands over, asks back or declines",
    actions: IM_BASE(),
    say: ["help", "rewrite Q3 in a friendlier tone", "write me a poem"],
    tryIt: "A bare request is answered with a question, rewording goes to the language model (not run in these docs), and a request outside research is declined with what Intelligent Mode does.",
    builder: { intelligent: "help", caption: "Nothing to act on yet: Intelligent Mode asks one focused question with choices." },
  },

  /* ================================================================ E · Research design generators (phase 2) */
  {
    id: "maxdiff", title: "A MaxDiff of ten phone features",
    actions: [{ op: "create_maxdiff", code: "MD", variable: "MD", text: "Of these features, which is the MOST and which is the LEAST important to you?", items: ["Battery life", "Camera quality", "Price", "Screen size", "Storage", "Design", "Brand", "Water resistance", "5G", "Warranty"] }],
    analysis: [{ kind: "maxdiff", variables: ["MD"], label: "MaxDiff scores" }],
    tryIt: "Pick the most and least important feature in each set and press Next — each respondent sees the sets of their own design version.",
    builder: { question: "MD", caption: "The MaxDiff question with its attached design (items per task, tasks, versions); the design itself lives in Design Generators." },
  },
  {
    id: "cbc", title: "A choice-based conjoint for smartphones",
    actions: [{ op: "create_conjoint", code: "CBC", variable: "CBC", method: "cbc", text: "If these were your only options, which would you choose?", none: true,
      attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["6.1 inch", "6.7 inch"] }, { name: "Battery", levels: ["1 day", "2 days"] }, { name: "Price", levels: ["$499", "$699", "$899"] }] }],
    analysis: [{ kind: "conjoint", variables: ["CBC"], label: "Conjoint utilities and importance" }],
    tryIt: "Choose an option (or None) in each task and press Next; every respondent gets the tasks of one design version.",
    builder: { question: "CBC", caption: "The CBC question and its design: attributes, alternatives per task, tasks, versions and the None option." },
  },
  {
    id: "cbc-partial", title: "Partial-profile CBC: 4 of 8 attributes per task",
    actions: [{ op: "create_conjoint", code: "PP", variable: "PP", method: "cbc", attributesPerTask: 4, text: "Which car would you choose?",
      attributes: [{ name: "Brand", levels: ["Volta", "Ampère", "Faraday"] }, { name: "Body", levels: ["Hatchback", "SUV"] }, { name: "Range", levels: ["300 km", "450 km"] }, { name: "Charging", levels: ["45 min", "20 min"] },
        { name: "Warranty", levels: ["5 years", "8 years"] }, { name: "Seats", levels: ["5", "7"] }, { name: "Home charger", levels: ["Not included", "Included"] }, { name: "Price", levels: ["$32,000", "$40,000", "$48,000"] }] }],
    tryIt: "Each task shows only four of the eight attributes — the others are left out of that task, balanced across the design.",
    builder: { question: "PP", caption: "A CBC with “attributes shown per task” set to 4." },
  },
  {
    id: "acbc", title: "Adaptive CBC: build your own, screening, tournament",
    actions: [{ op: "create_conjoint", code: "ACBC", variable: "ACBC", method: "acbc", text: "Let's find the laptop that suits you best.",
      attributes: [{ name: "Brand", levels: ["Acme", "Globex", "Initech"] }, { name: "Screen", levels: ["13 inch", "14 inch", "16 inch"] }, { name: "Battery", levels: ["8 h", "12 h", "18 h"] }, { name: "Price", levels: ["$699", "$999", "$1,299"] }] }],
    tryIt: "Build your ideal laptop, then accept or reject the near alternatives, answer the must-have / unacceptable checks, and pick winners in the tournament.",
    builder: { question: "ACBC", caption: "The ACBC question: the attributes, screening tasks, concepts per screen and the tournament settings." },
  },
  {
    id: "menu-conjoint", title: "A menu-based conjoint for mobile add-ons",
    actions: [{ op: "create_conjoint", code: "MENU", variable: "MENU", method: "menu", text: "Build the plan you would buy: tick the add-ons you want at these prices.", tasks: 6,
      items: [{ name: "Extra data 10 GB", prices: ["$3", "$5", "$7"] }, { name: "International calls", prices: ["$4", "$6", "$9"] }, { name: "Device insurance", prices: ["$6", "$9", "$12"] }, { name: "Music streaming", prices: ["$5", "$8"] }] }],
    analysis: [{ kind: "conjoint", variables: ["MENU"], label: "Menu take rates by price" }],
    tryIt: "Tick the add-ons you would buy at the prices shown; the prices change from task to task.",
    builder: { question: "MENU", caption: "The menu question: each item with its price points, the number of tasks and versions." },
  },
  {
    id: "rating-conjoint", title: "A rating-based conjoint (CVA)",
    actions: [{ op: "create_conjoint", code: "CVA", variable: "CVA", method: "cva", text: "How likely would you be to buy this product? (0 = not at all, 10 = certainly)",
      attributes: [{ name: "Brand", levels: ["Alpha", "Beta"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["$199", "$299", "$399"] }] }],
    tryIt: "Rate each product profile from 0 to 10; each respondent rates the profiles of one design version.",
    builder: { question: "CVA", caption: "The CVA question: attributes, profiles per version, single or paired mode." },
  },
  {
    id: "experimental-designs", title: "Three ads in a carry-over balanced (Williams) order",
    actions: [
      { op: "create_block", title: "Ad A" }, { op: "create_question", block: "Ad A", type: "rating", code: "Q1", variable: "LIKE_A", text: "How much do you like Ad A?", scale: { points: 5, low: "Not at all", high: "A lot" }, required: true },
      { op: "create_block", title: "Ad B" }, { op: "create_question", block: "Ad B", type: "rating", code: "Q2", variable: "LIKE_B", text: "How much do you like Ad B?", scale: { points: 5, low: "Not at all", high: "A lot" }, required: true },
      { op: "create_block", title: "Ad C" }, { op: "create_question", block: "Ad C", type: "rating", code: "Q3", variable: "LIKE_C", text: "How much do you like Ad C?", scale: { points: 5, low: "Not at all", high: "A lot" }, required: true },
      { op: "create_randomizer", blocks: ["Ad A", "Ad B", "Ad C"], title: "Ad order", order: "williams" },
      { op: "create_experiment", designType: "williams", treatments: ["Ad A", "Ad B", "Ad C"], name: "Ad order (Williams)" },
    ],
    flow: ["randomizer"],
    tryIt: "Rate the three ads, then Restart a few times: the order follows the Williams rows, so every ad is seen in every position and after every other ad equally often.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: the Randomizer ordering the three ad blocks by a Williams design; the design file is in Design Generators." },
  },
  {
    id: "van-westendorp", title: "Van Westendorp price sensitivity with Newton–Miller–Smith",
    actions: [{ op: "add_method_template", template: "pricing_psm", product: "the Aurora kettle", currency: "$" }],
    patch: (d) => { for (const q of d.questions) if (/^PSM_/.test(q.code)) q.settings = { ...(q.settings ?? {}), minValue: 0, maxValue: 200 }; },
    analysis: "plan",
    tryIt: "Enter four prices (too cheap, a bargain, getting expensive, too expensive) and the two purchase likelihoods — the second page pipes your own prices.",
    builder: { question: "PSM_TOO_CHEAP", caption: "The first of the four price questions the template adds, with the analysis plan item that reads all four." },
  },
  {
    id: "gabor-granger", title: "An adaptive Gabor–Granger price ladder",
    actions: [{ op: "add_method_template", template: "price_ladder", product: "the Plus plan", currency: "$", prices: [5, 8, 12, 15, 20] }],
    analysis: "plan",
    tryIt: "Say Yes or No to the price shown: Yes moves the next price up, No moves it down, until the highest accepted price is found.",
    builder: { question: "PRICE_LADDER", caption: "The Price Ladder question: the prices, where the ladder starts, and the yes / no labels." },
  },
  {
    id: "concept-testing", title: "A sequential monadic test of three concepts",
    actions: [{ op: "add_method_template", template: "sequential_monadic", concepts: ["Fresh", "Bold", "Calm"] }],
    analysis: "plan",
    tryIt: "Each concept is shown and rated on its own page; Restart to see another Williams order of the three concepts.",
    builder: { tab: "Survey Flow", caption: "Survey Flow: the template's randomizer of one block per concept, in a Williams order recorded for the order-effect test." },
  },
  {
    id: "kano-model", title: "A Kano study of three app features",
    actions: [{ op: "add_method_template", template: "kano", product: "the Volt app", features: ["Offline mode", "Dark theme", "Live chat"], importance: true }],
    analysis: "plan",
    tryIt: "Answer how you would feel if each feature were there, then if it were not — the pair classifies each feature for you.",
    builder: { question: "KANO_FUNC", caption: "The functional grid the Kano template adds; the dysfunctional grid uses the same rows." },
  },
  {
    id: "brand-research", title: "A brand funnel: awareness to preference",
    actions: [{ op: "add_method_template", template: "brand_funnel", product: "coffee", brands: ["Alpha", "Beta", "Gamma", "Delta"] }],
    analysis: [{ kind: "brand", variables: ["AWARE", "CONSIDER", "PURCHASED", "PREFER"], label: "Brand funnel" }],
    tryIt: "Name a brand unprompted, then pick the brands you know — later stages offer only the brands from the stage before.",
    builder: { question: "AWARE", caption: "Aided awareness, carried forward into consideration, purchase and preference." },
  },

  /* ================================================================ D · Actions and integrations (phase 2) */
  {
    id: "actions-in-practice", title: "Sentences become actions, checked and applied",
    actions: IM_BASE(),
    say: ["make Q1 and Q2 required", "Q4 must be between 18 and 99", "add Don't know to Q1"],
    tryIt: "The survey below carries the three batches of actions. Open “The actions” under each sentence to see exactly what was applied.",
    builder: { intelligent: "make Q1 and Q2 required", caption: "The proposed actions, shown as a change to approve; Apply makes them one undoable change in History." },
  },
  {
    id: "behaviours", title: "A behaviour: when “Other” is picked, open and focus its box, with a message",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "SOURCE", text: "Where did you hear about us?", options: ["Search engine", "Social media", "A friend", { label: "Other (please specify)", other: true, code: 99 }], required: true },
      { op: "create_behavior", label: "Guide the Other answer", target: "Q1.option:99", on: "select_option",
        effects: [{ do: "show_message", target: "Q1", message: "Thanks — please tell us where, in a few words." }, { do: "focus", target: "Q1.other_text" }] },
      { op: "create_behavior", label: "Clear the message", target: "Q1.option:99", on: "deselect_option", effects: [{ do: "hide_message", target: "Q1" }] },
    ],
    tryIt: "Pick “Other (please specify)”: the message appears and the cursor goes into the box. Pick another answer and the message goes away.",
    builder: { question: "Q1", section: "ux", caption: "Properties → Styles, animations & scripts: two behaviours on the Other option — the event, and the effects that follow." },
  },
  {
    id: "auto-punch", title: "Auto-punch: code a segment from an answer",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "AGE", text: "How old are you?", required: true },
      { op: "create_question", type: "hidden", code: "SEG", variable: "SEG", text: "Age segment (coded)", options: [{ label: "Under 35", code: 1 }, { label: "35 and over", code: 2 }], newPage: true },
      { op: "create_question", type: "single_select", code: "Q2", variable: "PLAN", text: "Which plan are you on?", options: ["Prepaid", "Contract"], required: true },
      { op: "add_punch", target: "SEG", when: "Q1 < 35", action: "select", codes: [1] },
      { op: "add_punch", target: "SEG", mode: "else", action: "select", codes: [2] },
    ],
    tryIt: "Enter an age and press Next: SEG is coded 1 (under 35) or 2 without being asked — see “Stored” under the survey.",
    builder: { question: "SEG", section: "auto-punch", caption: "Properties → Auto punch on the hidden SEG question: IF Q1 < 35 THEN select 1, ELSE select 2." },
  },
  {
    id: "panel-integration", title: "A Prolific panel: entry ID captured, outcomes sent back",
    actions: [
      { op: "create_question", type: "integer", code: "Q1", variable: "AGE", text: "How old are you?", required: true },
      { op: "add_skip", from: "Q1", when: "Q1 < 18", to: "screened" },
      { op: "create_question", type: "single_select", code: "Q2", variable: "USE", text: "How often do you use a streaming service?", options: ["Daily", "Weekly", "Rarely"], newPage: true, required: true },
      { op: "connect_panel", preset: "prolific", completionCode: "C1A2B3", codes: { screenout: "S9X8Y7" }, targets: ["survey"] },
    ],
    embedded: { PROLIFIC_PID: "5f1e…demo", STUDY_ID: "demo-study", SESSION_ID: "demo-session" },
    tryIt: "The link carries Prolific's IDs (captured as embedded data). Finish the survey to see where the respondent is sent back, with the completion code in the URL.",
    builder: { tab: "Survey Flow", caption: "Survey Flow after connecting the panel: the embedded IDs at the start and the panel redirects on each end." },
  },
  {
    id: "alerts-webhooks", title: "Alerts and a per-response webhook",
    actions: [
      { op: "create_question", type: "single_select", code: "Q1", variable: "NPSGRP", text: "How likely are you to recommend us?", options: ["Promoter", "Passive", "Detractor"], required: true },
      { op: "configure_alerts", events: ["quota.full"], channels: [{ kind: "email", to: "@team" }], digest: "immediate" },
      { op: "configure_alerts", events: ["response.completed"], channels: [{ kind: "webhook", to: "#crm-sync" }], responses: { enabled: true, events: ["completed"], includeAnswers: true } },
    ],
    tryIt: "Answering here sends nothing — alerts and webhooks fire for real responses on a live link. The stored JSON shows the two rules and the response-event settings.",
    builder: { tab: "Survey Flow", caption: "Alerts are part of the survey definition (no secrets in it); they are set from Qualitative → Alerts & panels or by Intelligent Mode." },
  },
];

export const exampleById = (id: string) => DOC_EXAMPLES.find((e) => e.id === id) ?? null;
