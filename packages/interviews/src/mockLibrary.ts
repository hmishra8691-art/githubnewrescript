import type { RequirementCategory } from "./scoring.js";

/**
 * THE PRACTICE SHELF.
 *
 * A mock interview is an ordinary interview project with `mode = 'mock'`,
 * created from one of these templates for the person who wants to practise,
 * with that person as its only candidate. Same recorder, same transcription,
 * same analysis, same scorecard — the difference is that the feedback is
 * shown to the person who sat it.
 *
 * ## Why the library is code, not rows
 *
 * A template is content that ships with the product and changes with it. In
 * a table it would need seeding, versioning, a cross-tenant read path and an
 * admin UI before anybody could practise anything. As code it is reviewed like
 * code, shipped like code, and `startMockInterview` copies what it needs into
 * the organization's own tables at the moment somebody presses Start — after
 * which it is theirs, editable, and subject to their retention like anything
 * else.
 *
 * ## Every requirement has criteria
 *
 * Because that is what the analysis is shown as "what meeting it looks like",
 * and a practice session whose feedback rests on a guessed standard would be
 * worse than none. The criteria describe the ANSWER — what a good one
 * contains — never the person.
 */

export interface MockQuestion {
  code: string;
  prompt: string;
  guidance?: string;
  kind: "video" | "audio" | "text" | "long_text";
  maxSeconds?: number;
  thinkSeconds?: number;
}

export interface MockRequirement {
  code: string;
  title: string;
  criteria: string;
  category: RequirementCategory;
  weight?: number;
}

export interface MockTemplate {
  key: string;
  category: string;
  title: string;
  blurb: string;
  minutes: number;
  questions: MockQuestion[];
  requirements: MockRequirement[];
}

export const MOCK_CATEGORIES = [
  "software_engineering", "data_science", "product_management", "marketing", "sales",
  "finance", "consulting", "hr", "customer_support", "leadership", "communication",
] as const;

export const MOCK_CATEGORY_SAY: Record<(typeof MOCK_CATEGORIES)[number], string> = {
  software_engineering: "Software engineering",
  data_science: "Data science",
  product_management: "Product management",
  marketing: "Marketing",
  sales: "Sales",
  finance: "Finance",
  consulting: "Consulting",
  hr: "HR",
  customer_support: "Customer support",
  leadership: "Leadership",
  communication: "Communication",
};

const COMM: MockRequirement = {
  code: "COMM", title: "Explains clearly", category: "communication",
  criteria: "Uses plain language, gives one concrete example, and says what the outcome was rather than only what was done.",
};
const STRUCT: MockRequirement = {
  code: "STRUCT", title: "Structures the answer", category: "communication",
  criteria: "Names the situation, what they did, and the result, in that order, without circling back.",
};

export const MOCK_TEMPLATES: MockTemplate[] = [
  {
    key: "swe_backend_behavioural", category: "software_engineering",
    title: "Backend engineer — behavioural", minutes: 12,
    blurb: "Four questions about systems you have built and decisions you have made.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Introduce yourself and describe the system you are proudest of building.", maxSeconds: 120, thinkSeconds: 20 },
      { code: "Q2", kind: "video", prompt: "Tell me about a production incident you were involved in. What happened, and what did you change afterwards?", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q3", kind: "video", prompt: "Describe a time you disagreed with a technical decision. How did you handle it?", maxSeconds: 150, thinkSeconds: 30 },
      { code: "Q4", kind: "long_text", prompt: "In a few sentences: how would you explain eventual consistency to a product manager?" },
    ],
    requirements: [
      { code: "OWN", title: "Takes ownership of outcomes", category: "behavioural", criteria: "Describes what they personally did and decided, names a mistake or limitation of their own, and says what they would do differently." },
      { code: "INC", title: "Learns from incidents", category: "technical", criteria: "Names a specific failure, its root cause, and a concrete change made afterwards — a test, an alert, a runbook, a design change." },
      { code: "DISAGREE", title: "Disagrees constructively", category: "behavioural", criteria: "States the other position fairly, gives the reasons for their own, and describes how the decision was resolved rather than who won." },
      { code: "TEACH", title: "Explains a technical idea to a non-technical listener", category: "communication", criteria: "Avoids jargon or defines it, uses an analogy or example, and states the practical consequence for the listener." },
      COMM,
    ],
  },
  {
    key: "swe_system_design", category: "software_engineering",
    title: "System design — talk it through", minutes: 15,
    blurb: "Design a service out loud. The reading looks for trade-offs, not the right answer.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Design a URL shortener that handles a billion redirects a day. Talk through storage, the redirect path, and what breaks first.", maxSeconds: 300, thinkSeconds: 60 },
      { code: "Q2", kind: "video", prompt: "How would you add analytics — click counts per link — without slowing the redirect?", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q3", kind: "long_text", prompt: "List the three things you would monitor in production for this system, and why each one." },
    ],
    requirements: [
      { code: "TRADE", title: "Names trade-offs", category: "technical", criteria: "For at least one decision, states what is gained, what is given up, and when the other choice would be right." },
      { code: "SCALE", title: "Reasons about scale", category: "technical", criteria: "Gives rough numbers — requests, bytes, latency — and uses them to justify a choice." },
      { code: "FAIL", title: "Anticipates failure", category: "problem_solving", criteria: "Names a specific component that fails first and what the system does when it does." },
      { code: "OBS", title: "Thinks about operability", category: "technical", criteria: "Names concrete metrics or alerts and ties each to a user-visible symptom." },
      STRUCT,
    ],
  },
  {
    key: "ds_case", category: "data_science",
    title: "Data science — analysis case", minutes: 12,
    blurb: "A metric moved. Explain how you would find out why, and what you would do about it.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Weekly retention dropped four points last week. Walk me through how you would investigate.", maxSeconds: 240, thinkSeconds: 45 },
      { code: "Q2", kind: "video", prompt: "You find the drop is concentrated in one acquisition channel. What do you recommend, and how would you test it?", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q3", kind: "long_text", prompt: "Describe a time an analysis you did was wrong. What was the mistake, and how did you catch it?" },
    ],
    requirements: [
      { code: "HYP", title: "Forms hypotheses before querying", category: "problem_solving", criteria: "Lists two or more plausible causes and says how each would show up in the data before describing any query." },
      { code: "SEG", title: "Segments the problem", category: "technical", criteria: "Breaks the metric down by a named dimension — channel, cohort, platform, geography — to localise the change." },
      { code: "EXP", title: "Designs a fair test", category: "technical", criteria: "Names a control, a success metric, and how long it needs to run or how many users it needs." },
      { code: "HUMBLE", title: "Owns analytical mistakes", category: "behavioural", criteria: "Describes a specific error of their own, how it was detected, and a check they now do." },
      COMM,
    ],
  },
  {
    key: "pm_product_sense", category: "product_management",
    title: "Product management — product sense", minutes: 12,
    blurb: "Improve a product you use every day. The reading looks for users, trade-offs and a way to know if it worked.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Pick a product you use daily. What would you improve, for whom, and why that first?", maxSeconds: 240, thinkSeconds: 60 },
      { code: "Q2", kind: "video", prompt: "How would you know, three months after shipping, whether it worked?", maxSeconds: 150, thinkSeconds: 30 },
      { code: "Q3", kind: "video", prompt: "Tell me about a time you said no to a stakeholder. What was the request, and how did you handle it?", maxSeconds: 180, thinkSeconds: 30 },
    ],
    requirements: [
      { code: "USER", title: "Starts from a user and a problem", category: "domain", criteria: "Names a specific kind of user and the problem they have before describing any feature." },
      { code: "PRIO", title: "Prioritises with reasons", category: "problem_solving", criteria: "Says why this improvement before others, using impact, effort, or evidence — not preference." },
      { code: "MEAS", title: "Defines success measurably", category: "domain", criteria: "Names a metric, the direction it should move, and a plausible target or comparison." },
      { code: "NO", title: "Says no well", category: "behavioural", criteria: "Explains the stakeholder's goal, the reason for declining, and an alternative offered." },
      STRUCT,
    ],
  },
  {
    key: "sales_discovery", category: "sales",
    title: "Sales — discovery call", minutes: 10,
    blurb: "Run the first ten minutes of a discovery conversation, and handle an objection.",
    questions: [
      { code: "Q1", kind: "video", prompt: "You have a first call with a prospect who filled in a form on the website. Open the call and tell me the first three questions you ask, and why.", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q2", kind: "video", prompt: "The prospect says: 'We already have a tool for this.' Respond as you would on the call.", maxSeconds: 120, thinkSeconds: 20 },
      { code: "Q3", kind: "video", prompt: "Tell me about a deal you lost. What did you learn?", maxSeconds: 150, thinkSeconds: 30 },
    ],
    requirements: [
      { code: "DISC", title: "Asks about the customer's situation before pitching", category: "role", criteria: "The first questions are about the prospect's goals, current process or pain, not about the product." },
      { code: "OBJ", title: "Handles objections with curiosity", category: "role", criteria: "Acknowledges the objection, asks a question about it, and only then offers a distinction." },
      { code: "LOSS", title: "Learns from lost deals", category: "behavioural", criteria: "Names a specific reason the deal was lost and a concrete change to their process since." },
      COMM,
    ],
  },
  {
    key: "consulting_case", category: "consulting",
    title: "Consulting — market entry case", minutes: 15,
    blurb: "Structure a market-entry question and estimate a number out loud.",
    questions: [
      { code: "Q1", kind: "video", prompt: "A regional coffee chain is considering opening in a new country. How would you structure the decision?", maxSeconds: 240, thinkSeconds: 60 },
      { code: "Q2", kind: "video", prompt: "Estimate the annual revenue of a single busy city-centre coffee shop. Talk through the numbers.", maxSeconds: 180, thinkSeconds: 45 },
      { code: "Q3", kind: "long_text", prompt: "What would make you recommend against entering, even if the numbers looked good?" },
    ],
    requirements: [
      { code: "FRAME", title: "Structures before diving in", category: "problem_solving", criteria: "Lays out the branches of the decision — market, competition, economics, capability — before analysing any one of them." },
      { code: "EST", title: "Estimates with stated assumptions", category: "problem_solving", criteria: "States each assumption as a number, shows the arithmetic, and sanity-checks the result." },
      { code: "RISK", title: "Weighs non-financial risk", category: "domain", criteria: "Names a specific regulatory, cultural, operational or brand risk and how it would change the recommendation." },
      STRUCT,
    ],
  },
  {
    key: "leadership_team", category: "leadership",
    title: "Leadership — managing a team", minutes: 12,
    blurb: "Three situations every manager meets. The reading looks for judgement and follow-through.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Tell me about a time you had to deliver difficult feedback. What did you say, and what happened next?", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q2", kind: "video", prompt: "A strong performer on your team has become disengaged. Walk me through what you would do in the first two weeks.", maxSeconds: 180, thinkSeconds: 30 },
      { code: "Q3", kind: "video", prompt: "Describe a decision you made that your team disagreed with. How did you bring them along — or not?", maxSeconds: 180, thinkSeconds: 30 },
    ],
    requirements: [
      { code: "FEED", title: "Gives specific, kind feedback", category: "behavioural", criteria: "Describes the behaviour and its effect rather than a judgement of the person, and what was agreed afterwards." },
      { code: "CURIOUS", title: "Investigates before acting", category: "behavioural", criteria: "Describes finding out why — a conversation, a question — before proposing a fix." },
      { code: "DECIDE", title: "Decides and explains", category: "role", criteria: "States the decision, the reasons given to the team, and what they did with the disagreement." },
      COMM,
    ],
  },
  {
    key: "support_escalation", category: "customer_support",
    title: "Customer support — a hard ticket", minutes: 10,
    blurb: "An angry customer, an unclear bug, and a colleague who needs your help.",
    questions: [
      { code: "Q1", kind: "video", prompt: "A customer writes in furious: their payment went through twice. Respond as you would in the first reply.", maxSeconds: 120, thinkSeconds: 20 },
      { code: "Q2", kind: "long_text", prompt: "You cannot reproduce a bug a customer reports. Write the message you would send them." },
      { code: "Q3", kind: "video", prompt: "Tell me about a time you went beyond the script for a customer. Was it the right call?", maxSeconds: 150, thinkSeconds: 30 },
    ],
    requirements: [
      { code: "EMP", title: "Acknowledges before solving", category: "communication", criteria: "The first sentences acknowledge the problem and its effect on the customer before any explanation or ask." },
      { code: "CLEAR", title: "Asks for exactly what is needed", category: "communication", criteria: "Requests specific, minimal information — a screenshot, a time, an account id — and says why." },
      { code: "JUDGE", title: "Exercises judgement", category: "behavioural", criteria: "Names the rule they stepped outside, why, and whether they would again." },
    ],
  },
  {
    key: "communication_basics", category: "communication",
    title: "Communication — first impressions", minutes: 8,
    blurb: "Introduce yourself and explain something you know well. Good for a first go.",
    questions: [
      { code: "Q1", kind: "video", prompt: "Introduce yourself in under a minute: who you are, what you do, and what you are looking for.", maxSeconds: 60, thinkSeconds: 30 },
      { code: "Q2", kind: "video", prompt: "Explain something you know well to someone who has never heard of it.", maxSeconds: 120, thinkSeconds: 45 },
      { code: "Q3", kind: "video", prompt: "What is a piece of feedback you have received that changed how you work?", maxSeconds: 120, thinkSeconds: 30 },
    ],
    requirements: [
      { code: "INTRO", title: "Introduces with a point", category: "communication", criteria: "Says who they are, what they do, and what they want, each in a sentence, without listing every job." },
      { code: "TEACH", title: "Explains to a newcomer", category: "communication", criteria: "Defines terms, uses one example, and checks the idea lands with a summary sentence." },
      { code: "GROW", title: "Shows they act on feedback", category: "behavioural", criteria: "Names the feedback, the change made, and a result of the change." },
      STRUCT,
    ],
  },
];

export function findMockTemplate(key: string): MockTemplate | undefined {
  return MOCK_TEMPLATES.find((t) => t.key === key);
}

export function mockTemplatesIn(category: string): MockTemplate[] {
  return MOCK_TEMPLATES.filter((t) => t.category === category);
}

/**
 * What to practise next.
 *
 * Templates whose requirements sit in the categories the person scored lowest
 * on, excluding the one just taken. Falls back to "anything else" when there
 * is no weak category, because a person who did well still deserves a next
 * step.
 */
export function suggestPractice(justTaken: string | null, weakCategories: readonly string[]): MockTemplate[] {
  const others = MOCK_TEMPLATES.filter((t) => t.key !== justTaken);
  if (!weakCategories.length) return others.slice(0, 3);
  const scored = others
    .map((t) => ({ t, hits: t.requirements.filter((r) => weakCategories.includes(r.category)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.t);
  return (scored.length ? scored : others).slice(0, 3);
}
