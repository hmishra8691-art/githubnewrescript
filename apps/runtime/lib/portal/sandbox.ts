import "server-only";
import { SurveyDefinition } from "@rescript/schema";
import { hashPassword, hashToken } from "@rescript/access/respondent";
import { memoryPortal, type MemoryPortal } from "./memoryStore";

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
  return m;
}

export function portalSandbox(): Promise<MemoryPortal> {
  return (globalThis.__rescriptPortalSandbox ??= seed());
}
