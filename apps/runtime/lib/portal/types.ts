import type { AccountStatus } from "@rescript/access/respondent";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * THE RESPONDENT PORTAL'S RECORDS AND ITS STORE (phase 1, 2026-11-20). The service (service.ts) is written against
 * this interface so the whole lifecycle — invitation, sign-in, lockout, sessions, assessments, edits — runs in a
 * plain test against memory (memoryStore.ts) and in production against the database (supabaseStore.ts).
 */
export interface AccountRec {
  id: string;
  respondentId: string;
  email: string | null;
  name: string | null;
  scope: "persistent" | "assessment";
  status: AccountStatus;
  expiresAt: string | null;
  lastLoginAt: string | null;
}

export interface CredentialRec {
  accountId: string;
  passwordHash: string | null;
  mustChange: boolean;
  failedAttempts: number;
  lastFailedAt: string | null;
  inviteTokenHash: string | null;
  inviteExpiresAt: string | null;
  resetTokenHash: string | null;
  resetExpiresAt: string | null;
}

export interface SessionRec {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  deviceLabel: string | null;
}

/** one person in one survey: a `respondents` row linked to the account */
export interface EnrolmentRec {
  id: string;
  accountId: string;
  surveyId: string;
  customerId: string | null;
  title: string;
  surveyStatus: string;
  /** the personal link's token — a credential; never sent to the browser except inside the start link */
  token: string;
  accessFrom: string | null;
  accessUntil: string | null;
  maxAttempts: number | null;
  suspended: boolean;
  lockedAt: string | null;
  reopenedUntil: string | null;
  /** the live link, when the survey is deployed */
  link: { clientSlug: string; studySlug: string; versionId: string } | null;
}

export interface AttemptRec {
  id: string;
  sessionId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  revision: number;
  versionId: string | null;
}
export interface AttemptData extends AttemptRec {
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: unknown[];
  stepIndex: number;
  seed: number | null;
}

export interface PortalEvent {
  accountId: string | null;
  event: string;
  surveyId?: string | null;
  customerId?: string | null;
  detail?: Record<string, unknown>;
  ipHash?: string | null;
}

export interface PortalStore {
  accountByLogin(login: { kind: "respondent_id" | "email"; value: string }): Promise<AccountRec | null>;
  accountById(id: string): Promise<AccountRec | null>;
  accountByInviteHash(hash: string): Promise<AccountRec | null>;
  accountByResetHash(hash: string): Promise<AccountRec | null>;
  saveAccount(id: string, patch: Partial<Pick<AccountRec, "name" | "status" | "lastLoginAt">>): Promise<void>;
  credential(accountId: string): Promise<CredentialRec | null>;
  saveCredential(accountId: string, patch: Partial<Omit<CredentialRec, "accountId">>): Promise<void>;

  createSession(s: { accountId: string; tokenHash: string; deviceLabel: string | null; ipHash: string | null; now: string }): Promise<SessionRec>;
  sessionByHash(hash: string): Promise<SessionRec | null>;
  touchSession(id: string, now: string): Promise<void>;
  revokeSession(id: string, reason: string, now: string): Promise<void>;
  revokeAllSessions(accountId: string, reason: string, now: string, exceptId?: string): Promise<void>;
  sessions(accountId: string): Promise<SessionRec[]>;

  enrolments(accountId: string): Promise<EnrolmentRec[]>;
  attempts(e: EnrolmentRec): Promise<AttemptRec[]>;
  attempt(e: EnrolmentRec, responseId: string): Promise<AttemptData | null>;
  /** the frozen definition of a version (what an attempt ran, or what the live link runs) */
  definition(e: EnrolmentRec, versionId: string): Promise<SurveyDefinition | null>;
  /** atomic: refuses when the row moved on (`conflict`) */
  writeEdit(e: EnrolmentRec, w: { responseId: string; expectedRevision: number; answers: Record<string, unknown>; calculated: Record<string, unknown> | null; changes: Record<string, { from: unknown; to: unknown }>; by: string }): Promise<{ ok: true; revision: number } | { ok: false; conflict: boolean; error: string }>;

  log(e: PortalEvent): Promise<void>;
}
