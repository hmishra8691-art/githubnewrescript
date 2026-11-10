/**
 * THE DEVELOPER DOCS' NAVIGATION (2026-11-09). Categories A–G, each with groups of pages, plus the Reference
 * pages (several generated from the code). A page is one markdown file in `content/docs`; a page may be listed in
 * more than one group (answer randomization is both a fundamental and an advanced flow tool), but it has ONE home —
 * the first place it is listed — which decides its category, its breadcrumb and its Previous / Next.
 *
 * `guides: false` marks a category whose visual feature guides are still being written: its reference pages are
 * listed (they are current), and the category says so instead of showing pages that do not exist.
 */
export interface NavGroup { label: string; slugs: string[] }
export interface NavCategory { key: string; letter: string; label: string; summary: string; groups: NavGroup[]; guides: boolean }

export const DOC_NAV: NavCategory[] = [
  {
    key: "start", letter: "", label: "Start here", guides: true,
    summary: "What ResLens.ai is, how a survey is built, and how these docs show each feature.",
    groups: [{ label: "Overview", slugs: ["getting-started"] }],
  },
  {
    key: "fundamentals", letter: "A", label: "Survey programming fundamentals", guides: true,
    summary: "Every everyday question type and answer option, with its builder settings, its stored form and what the respondent sees.",
    groups: [
      { label: "Question types", slugs: ["single-select", "multi-select", "text-entry", "numeric-entry", "open-ended", "ranking", "rating-scales", "matrix-questions", "grid-questions"] },
      { label: "Special answer options", slugs: ["other-specify", "exclusive-options", "none-of-the-above", "dont-know"] },
      { label: "Question behaviour", slugs: ["mandatory-optional", "question-validation", "question-randomization", "answer-randomization"] },
    ],
  },
  {
    key: "advanced", letter: "B", label: "Advanced programming", guides: true,
    summary: "Dynamic content, logic, flow, variables and code — each shown in the builder, as an expression and in the live survey.",
    groups: [
      { label: "Dynamic content", slugs: ["piping", "carry-forward", "masking", "lists", "loops"] },
      { label: "Logic and flow", slugs: ["display-logic", "skip-logic", "branching", "conditional-logic", "survey-flow", "question-randomization", "answer-randomization"] },
      { label: "Ending and leaving", slugs: ["survey-termination", "redirects"] },
      { label: "Data and variables", slugs: ["embedded-variables", "url-parameters", "quotas", "validation-rules"] },
      { label: "Custom code", slugs: ["custom-javascript", "custom-css", "custom-html-components"] },
    ],
  },
  {
    key: "intelligent", letter: "C", label: "Intelligent Mode", guides: true,
    summary: "Programming in plain language: how sentences are read, proposed, checked and approved — with real sentences read by the engine.",
    groups: [
      { label: "Guides", slugs: ["intelligent-mode-guide", "intelligent-editing", "intelligent-logic", "intelligent-review", "intelligent-validation", "intelligent-troubleshooting"] },
      { label: "Reference", slugs: ["intelligent-mode", "actions-reference"] },
    ],
  },
  {
    key: "actions", letter: "D", label: "Actions and integrations", guides: true,
    summary: "The actions every change goes through, behaviours and auto-punch inside the survey, and the panels, alerts and webhooks that connect it to other systems.",
    groups: [
      { label: "Inside the survey", slugs: ["actions", "behaviours", "auto-punch"] },
      { label: "Integrations", slugs: ["panel-integrations", "alerts-and-webhooks"] },
      { label: "Reference", slugs: ["actions-reference", "api"] },
    ],
  },
  {
    key: "designs", letter: "E", label: "Research design generators", guides: true,
    summary: "MaxDiff, conjoint, experimental designs, pricing, concept, Kano and brand research — the design, the respondent's screens and a sample of the output.",
    groups: [
      { label: "Start", slugs: ["design-generators", "study-methodologies"] },
      { label: "Choice designs", slugs: ["maxdiff", "choice-based-conjoint", "adaptive-cbc", "menu-based-conjoint", "rating-based-conjoint", "custom-experimental-designs"] },
      { label: "Pricing", slugs: ["van-westendorp", "gabor-granger"] },
      { label: "Product, concept and brand", slugs: ["concept-testing", "kano-model", "brand-research"] },
      { label: "Reference", slugs: ["research-engine", "capabilities"] },
    ],
  },
  {
    key: "branding", letter: "F", label: "Branding and survey customization", guides: false,
    summary: "Themes, colours, typography, layout, header and footer, custom CSS and scripts.",
    groups: [{ label: "Reference", slugs: ["custom-code"] }],
  },
  {
    key: "platform", letter: "G", label: "Project management and platform", guides: false,
    summary: "Projects, distribution, data, analytics, exports, languages, quotas and the API.",
    groups: [{ label: "Reference", slugs: ["analytics", "data-and-exports", "localization-and-quotas", "api"] }],
  },
  {
    key: "reference", letter: "", label: "Reference", guides: true,
    summary: "The complete technical reference — the survey definition, every type, operator and action. Pages marked “generated” are written from the platform's own code.",
    groups: [{ label: "Technical reference", slugs: ["survey-definition", "question-types", "logic", "logic-reference", "piping-and-lists", "custom-code", "actions-reference", "capabilities"] }],
  },
];

/** every page in reading order, each once (its home) */
export function readingOrder(): { slug: string; category: NavCategory; group: NavGroup }[] {
  const seen = new Set<string>();
  const out: { slug: string; category: NavCategory; group: NavGroup }[] = [];
  for (const category of DOC_NAV) for (const group of category.groups) for (const slug of group.slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, category, group });
  }
  return out;
}

export function homeOf(slug: string) { return readingOrder().find((x) => x.slug === slug) ?? null; }
