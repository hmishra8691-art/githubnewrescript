/**
 * THE STUDIO'S MENU (moved here 2026-11-09 from Studio.tsx, unchanged): every tool, its label and its group. One list
 * for the Studio's menubar and for Help, which describes where things are from this same list — so a renamed tab is
 * renamed in Help's answers too.
 */
export interface StudioNavEntry { key: string; label: string; icon: string; group: string }

export const STUDIO_NAV: StudioNavEntry[] = [
  { key: "questions", label: "Questions", icon: "questions", group: "Programming" },
  { key: "settings", label: "Survey Settings", icon: "settings", group: "Programming" },
  { key: "flow", label: "Survey Flow", icon: "flow", group: "Programming" },
  { key: "logic", label: "Logic", icon: "logic", group: "Programming" },
  { key: "variables", label: "Variables", icon: "variables", group: "Programming" },
  { key: "calculations", label: "Calculations", icon: "calc", group: "Programming" },
  { key: "quotas", label: "Quotas", icon: "quotas", group: "Programming" },
  { key: "listfill", label: "List Fill", icon: "listfill", group: "Programming" },
  /* 2026-11-09: the research methodology engine — objective → method → study (questions, design, plan, simulation) */
  { key: "studydesign", label: "Study design", icon: "designs", group: "Research tools" },
  { key: "designs", label: "Design Generators", icon: "designs", group: "Research tools" },
  /*
   * Qualitative research (2026-10-18): the interview / focus-group guide, session records and
   * recordings, transcripts, AI-assisted coding with human review, themes and the report. Not in
   * EDITING_TABS: its data are Data-module records gated at the routes, not the questionnaire.
   */
  { key: "qualitative", label: "Qualitative", icon: "notes", group: "Research tools" },
  { key: "branding", label: "Branding", icon: "branding", group: "Research tools" },
  { key: "assets", label: "Assets", icon: "assets", group: "Research tools" },
  /*
   * Translation & Localization — every language version of the survey (text
   * and audio) over the one language-neutral definition. In Research tools
   * beside Branding: it changes what a respondent reads and hears, never what
   * the survey asks or stores. In EDITING_TABS: a translation is authorship.
   */
  { key: "localization", label: "Translation", icon: "layers", group: "Research tools" },
  { key: "scripts", label: "Scripts", icon: "scripts", group: "Research tools" },
  /* S3b: every piece of code in the survey in one list, each editable in place (beside Scripts: Research tools is where survey code lives) */
  { key: "allcode", label: "All code", icon: "scripts", group: "Research tools" },
  /*
   * §55/§56. In Research tools rather than Programming, and deliberately NOT
   * in EDITING_TABS: a reviewer checking whether a programmer's change broke
   * path C must not have to take the edit lock away from them to do it. The
   * route gates it on `survey.edit` without the lock, for the same reason.
   */
  { key: "tests", label: "Tests", icon: "check", group: "Research tools" },
  { key: "data", label: "Data", icon: "data", group: "Results" },
  /* 2026-11-09: multi-wave tracking — uploaded waves and this survey's live data, mapped, tested and composition-checked */
  { key: "tracker", label: "Wave tracker", icon: "chart", group: "Results" },
  /*
   * Not in EDITING_TABS: a fieldwork manager watching supplier delivery is
   * reading response data, and must not need the edit lock to do it — the
   * same reasoning that keeps Data and Versions live for a reviewer.
   */
  { key: "fieldwork", label: "Fieldwork", icon: "chart", group: "Results" },
  /*
   * The recruitment exchange (2026-11-03). Beside Fieldwork, in Results, and for the same reason: buying sample
   * and watching it arrive are one job. Not in EDITING_TABS — a sample desk does not hold the edit lock — and
   * the route, not this list, decides who may spend money (`deploy.manage`).
   */
  { key: "recruitment", label: "Recruitment", icon: "chart", group: "Results" },
  /*
   * §24. Beside Versions & Deploy, because sending a study is the step after
   * shipping it — and gated on `deploy.manage` at the route, not here: the
   * roles separate the programmer who edits from the manager who sends.
   */
  /*
   * §60. First in Management, because it is the project — the thing every
   * other tab is about. Not in EDITING_TABS: recording a due date is not an
   * act on the questionnaire and must not need the edit lock (the route
   * gates it on `survey.edit` without the lock, and on
   * `project.lock_settings` for the freeze).
   */
  { key: "project", label: "Project", icon: "home", group: "Management" },
  /*
   * Metered usage & wallet (billing brief §11). Beside Project, because the
   * wallet belongs to the project, not the questionnaire. Not in
   * EDITING_TABS: reading what the project has spent, and asking for
   * credits, never needs the edit lock.
   */
  { key: "usage", label: "Usage & Wallet", icon: "chart", group: "Management" },
  { key: "distribution", label: "Distribution", icon: "share", group: "Management" },
  { key: "versions", label: "Versions & Deploy", icon: "versions", group: "Management" },
  { key: "json", label: "JSON", icon: "json", group: "Management" },
  { key: "collaborators", label: "Collaborators", icon: "collaborators", group: "Management" },
  { key: "notes", label: "Internal notes", icon: "notes", group: "Management" },
  { key: "activity", label: "Activity", icon: "activity", group: "Management" },
];
