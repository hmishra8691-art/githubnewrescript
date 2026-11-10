/**
 * STUDIO SCREENS FOR THE DEVELOPER DOCS (phase 3, 2026-11-10). Some platform tools are not part of the survey a
 * respondent takes — versions, distribution lists, fieldwork, the data tables, the test runner — so a live survey
 * cannot show them. Their pages show the tool itself instead: a screenshot of the real Studio, captured by
 * `scripts/capture-docs-builder.mjs` (with the docs examples) into public/docs-media/screens/<id>.webp, placed in a
 * page with `::: screen <id>`. A screen may load a docs example's survey first, so the tool has something to show.
 */
export interface DocScreen {
  id: string;
  title: string;
  /** the Studio tool to open (its menubar label) */
  tab: string;
  /** a button inside the tool to click before the picture (its exact text) */
  click?: string;
  /** a control to press after opening the tool (a data-testid), then wait for the tool to settle — e.g. run the simulation */
  run?: string;
  /** load this docs example's survey first (an id in examples.ts) */
  load?: string;
  /** how tall the picture may be, in CSS pixels (default 900) */
  height?: number;
  caption: string;
}

export const DOC_SCREENS: DocScreen[] = [
  { id: "versions", title: "Versions & Deploy", tab: "Versions & Deploy", load: "im-overview",
    caption: "Management → Versions & Deploy: the version history (every saved version, its label, when it was saved and where it is deployed) and the script history." },
  { id: "distribution", title: "Distribution", tab: "Distribution", load: "im-overview",
    caption: "Management → Distribution: the live list and the test list of personal links — one link per respondent, its token generated in the database." },
  { id: "tests", title: "Tests — a simulation run", tab: "Tests", load: "im-overview", run: "sim-run", height: 1000,
    caption: "Research Tools → Tests after “Run the simulation”: 100 simulated respondents through the real survey — their endings, coverage of questions, pages and conditions, and each respondent's path." },
  { id: "data-formats", title: "Data — downloads and formats", tab: "Data", click: "⋯ More formats", load: "maxdiff", height: 430,
    caption: "Results → Data with More formats open: test, live or all data; CSV and XLSX; export presets and the data dictionary; SPSS, SAS and Stata; the timing and MaxDiff choice files; and how coded answers are written." },
  { id: "assets", title: "Assets", tab: "Assets",
    caption: "Research Tools → Assets: uploaded images, logos, video, audio and documents, chosen wherever media goes — question media, option images, the branding logo." },
];

export function screenById(id: string): DocScreen | undefined { return DOC_SCREENS.find((s) => s.id === id); }
