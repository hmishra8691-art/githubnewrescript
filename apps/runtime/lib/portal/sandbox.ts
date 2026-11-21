import "server-only";
import { SurveyDefinition } from "@rescript/schema";
import { hashPassword, hashToken } from "@rescript/access/respondent";
import { memoryPortal, type MemoryPortal } from "./memoryStore";
import { scoreInterview } from "./scorecardRow";

/**
 * THE PORTAL'S SANDBOX — a runtime with NO database, the stand-in AI provider and not in production (the same rule
 * as every other sandbox in this app). The portal then runs on the in-memory store with three seeded people, so the
 * pages can be opened on a developer machine and driven by the browser suite (scripts/respondent-portal-test.mjs).
 * It can never be reached on a deployment that has a database, and never in production.
 */
export const portalSandboxAvailable = () => !process.env.SUPABASE_URL && !process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.AI_API_URL === "fake:" && process.env.NODE_ENV !== "production";

export const SANDBOX_PASSWORD = "sandbox portal password";
export const SANDBOX_INVITE_TOKEN = "sandbox-invitation-token-000000000000000000";

const survey = (title: string, portal: Record<string, unknown> | null) => SurveyDefinition.parse({
  meta: { id: "sandbox", code: "SBX", title, version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Overall, how have you felt this week?", required: true, options: [{ code: 1, label: "Very well" }, { code: 2, label: "Well" }, { code: 3, label: "Not well" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which of these did you do?", options: [{ code: "walk", label: "Went for a walk" }, { code: "sleep", label: "Slept well" }, { code: "friends", label: "Saw friends" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Is there anything you would like to add?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { access: { mode: "unique_links" } },
  ...(portal ? { portal } : {}),
});

/* phase 2: a short index with two scores, a headline and a comparison by team */
const five = (lo: string, hi: string) => [1, 2, 3, 4, 5].map((n) => ({ code: n, label: n === 1 ? lo : n === 5 ? hi : String(n) }));
const indexSurvey = () => SurveyDefinition.parse({
  meta: { id: "sandbox-index", code: "IDX", title: "Workplace wellbeing index", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "e1", code: "E1", variableName: "E1", type: "single_select", text: "I have energy for my work.", options: five("Never", "Always") },
    { id: "e2", code: "E2", variableName: "E2", type: "single_select", text: "I finish the day with something left.", options: five("Never", "Always") },
    { id: "s1", code: "S1", variableName: "S1", type: "single_select", text: "I feel under pressure.", options: five("Never", "Always") },
    { id: "s2", code: "S2", variableName: "S2", type: "single_select", text: "I find it hard to switch off.", options: five("Never", "Always") },
    { id: "team", code: "TEAM", variableName: "TEAM", type: "single_select", text: "Which team are you in?", options: [{ code: "n", label: "North" }, { code: "s", label: "South" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["e1", "e2", "s1", "s2", "team"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { access: { mode: "unique_links", allowRetake: true } },
  portal: {
    enabled: true, template: "employee_engagement", show: { answers: true, scores: true, comparison: true, trends: true },
    series: { id: "workplace-wellbeing", label: "Workplace wellbeing index", repeatEveryDays: 90 },
    scorecard: {
      overall: { label: "Wellbeing index" },
      dimensions: [
        { id: "energy", label: "Energy", description: "How much you have left for your work and after it.", source: { kind: "items", items: [{ question: "e1" }, { question: "e2" }] }, bands: [{ upTo: 4, label: "Low" }, { upTo: 7, label: "Moderate" }, { upTo: 10, label: "High", note: "You usually have energy to spare." }] },
        { id: "pressure", label: "Pressure", higherIsBetter: false, source: { kind: "items", items: [{ question: "s1" }, { question: "s2" }] }, bands: [{ upTo: 4, label: "Low" }, { upTo: 7, label: "Moderate" }, { upTo: 10, label: "High" }] },
      ],
    },
    benchmark: { enabled: true, groups: [{ id: "team", label: "Team", source: { kind: "question", ref: "TEAM" } }] },
  },
});

declare global {
  // eslint-disable-next-line no-var
  var __rescriptPortalSandbox: Promise<MemoryPortal> | undefined;
}

async function seed(): Promise<MemoryPortal> {
  const m = memoryPortal();
  const hash = await hashPassword(SANDBOX_PASSWORD);
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const person = (id: string, respondentId: string, email: string | null, name: string | null, status: "active" | "invited" = "active") => {
    m.accounts.push({ id, respondentId, email, name, scope: "persistent", status, expiresAt: null, lastLoginAt: null });
    m.credentials.set(id, { accountId: id, passwordHash: status === "active" ? hash : null, mustChange: false, failedAttempts: 0, lastFailedAt: null, inviteTokenHash: null, inviteExpiresAt: null, resetTokenHash: null, resetExpiresAt: null });
  };
  person("sbx-1", "RSP-SANDB0X1", "ana@sandbox.test", "Ana Silva");
  person("sbx-2", "RSP-SANDB0X2", "ben@sandbox.test", "Ben Okoro");
  person("sbx-3", "RSP-SANDB0X3", null, "Cara Lind", "invited");
  Object.assign(m.credentials.get("sbx-3")!, { inviteTokenHash: hashToken(SANDBOX_INVITE_TOKEN), inviteExpiresAt: new Date(now + 14 * 86_400_000).toISOString() });

  m.definitions.set("v-plain", survey("Onboarding questionnaire", null));
  m.definitions.set("v-edit", survey("Weekly wellbeing check", { enabled: true, show: { answers: true, history: true }, editing: { mode: "until_locked", lockedQuestions: ["q1"] } }));
  const enrol = (id: string, accountId: string, title: string, versionId: string, over: Record<string, unknown> = {}) => m.enrolments.push({ id, accountId, surveyId: `sandbox-${id}`, customerId: "sandbox", title, surveyStatus: "live", token: `sandbox-token-${id}`, accessFrom: null, accessUntil: null, maxAttempts: null, suspended: false, lockedAt: null, reopenedUntil: null, link: { clientSlug: "sandbox", studySlug: id, versionId }, ...over });
  enrol("e-open", "sbx-1", "Onboarding questionnaire", "v-plain", { accessUntil: new Date(now + 7 * 86_400_000).toISOString() });
  enrol("e-done", "sbx-1", "Weekly wellbeing check", "v-edit");
  enrol("e-running", "sbx-1", "Sleep diary", "v-plain");
  enrol("e-ben", "sbx-2", "Weekly wellbeing check", "v-edit");
  const row = (id: string, over: Record<string, unknown>) => ({ id, sessionId: `sandbox-session-${id}-0000`, status: "complete", startedAt: ago(30), completedAt: ago(29), revision: 0, versionId: "v-edit", answers: { q1: 2, q2: ["walk", "friends"], q3: "A calm week." }, calculated: {}, embedded: {}, flags: [], stepIndex: 1, seed: 11, ...over });
  m.attempts.set("e-done", [row("r-done", {})]);
  m.attempts.set("e-running", [row("r-running", { status: "in_progress", completedAt: null, versionId: "v-plain", answers: { q1: 1 } })]);
  m.attempts.set("e-ben", [row("r-ben", { answers: { q1: 3, q3: "Ben's private answer." } })]);

  /* the index: Ana and 22 colleagues (12 North with her, 11 South), so both of her comparisons can be shown */
  const idx = indexSurvey();
  m.definitions.set("v-index", idx);
  enrol("e-index", "sbx-1", "Workplace wellbeing index", "v-index");
  const mine = { e1: 4, e2: 5, s1: 2, s2: 3, team: "n" };
  /* three results over time: the page "My progress" has something to draw */
  m.attempts.set("e-index", [
    row("r-index-1", { versionId: "v-index", answers: { e1: 2, e2: 3, s1: 4, s2: 4, team: "n" }, startedAt: ago(200 * 24 + 1), completedAt: ago(200 * 24) }),
    row("r-index-2", { versionId: "v-index", answers: { e1: 3, e2: 4, s1: 3, s2: 3, team: "n" }, startedAt: ago(100 * 24 + 1), completedAt: ago(100 * 24) }),
    row("r-index", { versionId: "v-index", answers: mine }),
  ]);
  const surveyId = "sandbox-e-index";
  const stored = (person: string, responseId: string, answers: Record<string, unknown>) => {
    const sc = scoreInterview(idx, { answers })!;
    m.scorecards.set(surveyId, [...(m.scorecards.get(surveyId) ?? []), { responseId, key: sc.key, person, at: ago(29), values: sc.scores, cohort: sc.cohort }]);
  };
  stored("e-index", "r-index", mine);
  for (let i = 0; i < 22; i++) stored(`peer-${i}`, `r-peer-${i}`, { e1: 1 + (i % 5), e2: 1 + ((i * 2) % 5), s1: 1 + ((i * 3) % 5), s2: 1 + ((i + 2) % 5), team: i < 11 ? "n" : "s" });
  return m;
}

export function portalSandbox(): Promise<MemoryPortal> {
  return (globalThis.__rescriptPortalSandbox ??= seed());
}
