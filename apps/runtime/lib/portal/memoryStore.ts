import type { SurveyDefinition } from "@rescript/schema";
import type { BenchmarkSnapshot, StoredScore } from "@rescript/analytics/benchmark";
import type { AccountRec, AttemptData, CredentialRec, EnrolmentRec, PortalEvent, PortalStore, SessionRec, StoredScorecard } from "./types.ts";

/**
 * The portal's store in memory — for the service's tests, and for nothing else. It keeps the same promises the
 * database store does: lookups by hash, one edit at a time by revision, enrolments only by account.
 */
export interface MemoryPortal {
  store: PortalStore;
  accounts: AccountRec[];
  credentials: Map<string, CredentialRec>;
  sessions: SessionRec[];
  enrolments: EnrolmentRec[];
  /** enrolment id → its attempts */
  attempts: Map<string, AttemptData[]>;
  definitions: Map<string, SurveyDefinition>;
  events: PortalEvent[];
  /** survey id → stored scores (person = the enrolment id) */
  scorecards: Map<string, (StoredScore & { key: string; responseId: string })[]>;
  benchmarks: Map<string, { snapshot: BenchmarkSnapshot; computedAt: string }>;
  edits: { responseId: string; changes: Record<string, { from: unknown; to: unknown }>; by: string }[];
}

export function memoryPortal(): MemoryPortal {
  const m: Omit<MemoryPortal, "store"> = { accounts: [], credentials: new Map(), sessions: [], enrolments: [], attempts: new Map(), definitions: new Map(), events: [], edits: [], scorecards: new Map(), benchmarks: new Map() };
  let n = 0;
  const byCred = (pick: (c: CredentialRec) => string | null, hash: string) => {
    for (const c of m.credentials.values()) if (pick(c) === hash) return m.accounts.find((a) => a.id === c.accountId) ?? null;
    return null;
  };
  const store: PortalStore = {
    async accountByLogin(l) { return m.accounts.find((a) => (l.kind === "email" ? a.scope === "persistent" && a.email === l.value : a.respondentId === l.value)) ?? null; },
    async accountById(id) { return m.accounts.find((a) => a.id === id) ?? null; },
    async accountByInviteHash(h) { return byCred((c) => c.inviteTokenHash, h); },
    async accountByResetHash(h) { return byCred((c) => c.resetTokenHash, h); },
    async saveAccount(id, patch) { const a = m.accounts.find((x) => x.id === id); if (a) Object.assign(a, patch); },
    async credential(id) { const c = m.credentials.get(id); return c ? { ...c } : null; },
    async saveCredential(id, patch) { const c = m.credentials.get(id); if (c) Object.assign(c, patch); },
    async createSession(s) { const rec: SessionRec = { id: `sess-${++n}`, accountId: s.accountId, tokenHash: s.tokenHash, createdAt: s.now, lastSeenAt: s.now, revokedAt: null, deviceLabel: s.deviceLabel }; m.sessions.push(rec); return { ...rec }; },
    async sessionByHash(h) { const s = m.sessions.find((x) => x.tokenHash === h); return s ? { ...s } : null; },
    async touchSession(id, now) { const s = m.sessions.find((x) => x.id === id); if (s) s.lastSeenAt = now; },
    async revokeSession(id, _reason, now) { const s = m.sessions.find((x) => x.id === id); if (s && !s.revokedAt) s.revokedAt = now; },
    async revokeAllSessions(accountId, _reason, now, exceptId) { for (const s of m.sessions) if (s.accountId === accountId && s.id !== exceptId && !s.revokedAt) s.revokedAt = now; },
    async sessions(accountId) { return m.sessions.filter((s) => s.accountId === accountId).map((s) => ({ ...s })); },
    async enrolments(accountId) { return m.enrolments.filter((e) => e.accountId === accountId).map((e) => ({ ...e })); },
    async attempts(e) { return (m.attempts.get(e.id) ?? []).map(({ answers: _a, calculated: _c, embedded: _e, flags: _f, stepIndex: _s, seed: _d, ...rest }) => ({ ...rest })); },
    async attempt(e, id) { const a = (m.attempts.get(e.id) ?? []).find((x) => x.id === id); return a ? structuredClone(a) : null; },
    async definition(_e, versionId) { return m.definitions.get(versionId) ?? null; },
    async writeEdit(e, w) {
      const a = (m.attempts.get(e.id) ?? []).find((x) => x.id === w.responseId);
      if (!a) return { ok: false, conflict: false, error: "RESPONSE_NOT_FOUND" };
      if (a.revision !== w.expectedRevision) return { ok: false, conflict: true, error: "REVISION_CONFLICT" };
      a.answers = structuredClone(w.answers); if (w.calculated) a.calculated = structuredClone(w.calculated); a.revision += 1;
      m.edits.push({ responseId: w.responseId, changes: w.changes, by: w.by });
      return { ok: true, revision: a.revision };
    },
    async saveScorecard(e, sc: StoredScorecard) {
      const rows = (m.scorecards.get(e.surveyId) ?? []).filter((r) => r.responseId !== sc.responseId);
      rows.push({ responseId: sc.responseId, key: sc.key, person: e.id, at: sc.completedAt, values: sc.scores, cohort: sc.cohort });
      m.scorecards.set(e.surveyId, rows);
    },
    async scoreRows(e, key) { return (m.scorecards.get(e.surveyId) ?? []).filter((r) => r.key === key).map((r) => ({ person: r.person, at: r.at, values: r.values, cohort: r.cohort })); },
    async benchmark(e) { return m.benchmarks.get(e.surveyId) ?? null; },
    async saveBenchmark(e, snapshot, now) { m.benchmarks.set(e.surveyId, { snapshot, computedAt: now }); },
    async log(e) { m.events.push(e); },
  };
  return { ...m, store };
}
