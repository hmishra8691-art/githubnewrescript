import { CATEGORIES } from "./articles.ts";

/**
 * WHAT HELP OFFERS BEFORE THE FIRST QUESTION (2026-11-09): popular questions, and topics by category. In the Studio
 * the category of the panel the user is on comes first.
 */
export const POPULAR: string[] = [
  "How do I create my first survey?",
  "How do I configure skip and display logic?",
  "How does automatic piping work?",
  "How do I use Intelligent Mode?",
  "How do I create a MaxDiff study?",
  "How do I generate a Conjoint design?",
  "How do I configure quotas?",
  "How do I test and deploy a survey?",
  "How does the usage wallet work?",
  "How do I create cross-tabulations?",
  "How do I monitor live responses?",
  "How do I manage collaborators and permissions?",
];

export const TOPICS: { category: string; label: string; questions: string[] }[] = [
  { category: "studio", label: CATEGORIES.studio, questions: ["How do I add questions and blocks?", "How do I preview and test my survey?", "How do I change survey settings like access and links?", "How do I simulate test respondents?"] },
  { category: "logic", label: CATEGORIES.logic, questions: ["How do I show a question only when someone selects a particular answer?", "How do I skip questions based on an answer?", "How do I show only the brands they selected earlier?", "How do I repeat questions for each brand?", "How do I randomize the order of options?", "How do I screen people out?"] },
  { category: "intelligent", label: CATEGORIES.intelligent, questions: ["What can Intelligent Mode do automatically?", "How do I get the best results from Intelligent Mode?"] },
  { category: "designs", label: CATEGORIES.designs, questions: ["Which method should I use for my research objective?", "How do I generate a choice-based conjoint design?", "How do I create a MaxDiff study?"] },
  { category: "advanced", label: CATEGORIES.advanced, questions: ["How do I create a calculated variable?", "How do I capture a panel ID from the URL?", "How do I write a custom JavaScript script?", "How do I translate my survey?"] },
  { category: "results", label: CATEGORIES.results, questions: ["How do I view and export responses?", "How do I clean my data?", "How do I monitor fieldwork?", "How do I compare tracking waves?", "How do I buy sample?"] },
  { category: "analytics", label: CATEGORIES.analytics, questions: ["How do I create a cross-tab between gender and brand preference?", "How does significance testing work?", "How do I export to SPSS?", "How do I build a report?"] },
  { category: "qualitative", label: CATEGORIES.qualitative, questions: ["How do I plan a qualitative study?", "How do I run AI-moderated interviews?", "How do I code transcripts into themes?"] },
  { category: "branding", label: CATEGORIES.branding, questions: ["How do I apply my brand colours and logo?"] },
  { category: "project", label: CATEGORIES.project, questions: ["How do I invite collaborators?", "How do I deploy a new survey version?", "How do I clone a project?"] },
  { category: "billing", label: CATEGORIES.billing, questions: ["How does the wallet deduct credits?", "Do test responses consume wallet credits?", "What happens when the wallet balance is insufficient?"] },
  { category: "troubleshooting", label: CATEGORIES.troubleshooting, questions: ["Why isn't my question displaying?", "My piped text is appearing blank", "My quota is not filling correctly", "My responses are not appearing in Analytics", "My JavaScript is not executing"] },
];

/** the Studio tab → the category to show first */
export const TAB_CATEGORY: Record<string, string> = {
  questions: "studio", settings: "studio", flow: "logic", logic: "logic", variables: "advanced", calculations: "advanced", quotas: "logic", listfill: "advanced",
  studydesign: "designs", designs: "designs", qualitative: "qualitative", branding: "branding", assets: "branding", localization: "advanced", scripts: "advanced", allcode: "advanced", tests: "studio",
  data: "results", tracker: "results", fieldwork: "results", recruitment: "results", project: "project", usage: "billing", distribution: "project", versions: "project", json: "advanced", collaborators: "project", notes: "project", activity: "project",
};

export function topicsFor(tab?: string): typeof TOPICS {
  const first = tab ? TAB_CATEGORY[tab] : undefined;
  return first ? [...TOPICS.filter((t) => t.category === first), ...TOPICS.filter((t) => t.category !== first)] : TOPICS;
}
