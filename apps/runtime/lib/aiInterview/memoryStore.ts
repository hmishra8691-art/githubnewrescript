import type { QualStudy } from "@rescript/schema";
import { moderationOf, quotaVerdict, type InterviewTurnRecord, type ModeratorState, type QualTranscriptShape } from "@rescript/engine";
import type { AiInterviewStore, BeginArgs, BeginResult, RecordArgs, SessionRec, StudyRec } from "./types.ts";

/**
 * THE SANDBOX STORE — the same contract as the database (`rescript_ai_interview_begin` /
 * `_record_turn` in 0069: admission under the study's quotas, completes target and budget, a paused
 * study admitting only tests, interviews idle 30 minutes swept to abandoned; optimistic versions;
 * nothing written to a finished interview), kept in this process's memory. Used only when the runtime
 * has no database and the provider is the fake one (`runtimeDeps.ts`), so the browser suites and a
 * laptop can run the whole path; the Studio's sandbox reads it through `/api/ai-interview/sandbox`.
 * Restarting the server forgets it, which is the point.
 */

interface Mem {
  studies: Map<string, StudyRec>;
  sessions: Map<string, SessionRec & { tokenHash: string; lastActivity: number; completedAt: number | null; qual?: { title: string; transcript: QualTranscriptShape } }>;
  turns: Map<string, InterviewTurnRecord[]>;
  observers: Map<string, string>;
  seq: number;
}
declare global {
  // eslint-disable-next-line no-var
  var __rescriptAiInterviewMem: Mem | undefined;
}
const mem = (): Mem => (globalThis.__rescriptAiInterviewMem ??= { studies: new Map(), sessions: new Map(), turns: new Map(), observers: new Map(), seq: 0 });

const hex = (n: number) => { let s = ""; const c = globalThis.crypto; const b = new Uint8Array(n); c.getRandomValues(b); for (const x of b) s += x.toString(16).padStart(2, "0"); return s; };
const id = () => globalThis.crypto.randomUUID();

export const ABANDON_MS = 30 * 60_000;

export function memoryStore(now: () => number = Date.now): AiInterviewStore & SandboxOps {
  const m = mem();
  const sweep = (studyId: string) => {
    for (const s of m.sessions.values()) if (s.studyId === studyId && s.status === "in_progress" && now() - s.lastActivity > ABANDON_MS) { s.status = "abandoned"; s.completedAt = now(); s.version++; }
  };
  return {
    kind: "memory",
    async studyByLink(token) { return [...m.studies.values()].find((s) => s.linkToken === token) ?? null; },
    async studyById(sid) { return m.studies.get(sid) ?? null; },
    async begin(a: BeginArgs): Promise<BeginResult> {
      const st = m.studies.get(a.study.id);
      if (!st) return { admitted: false, reason: "unknown study" };
      if (st.status === "closed" || (st.status === "paused" && !a.isTest)) return { admitted: false, reason: "closed" };
      sweep(st.id);
      if (!a.isTest && !a.screenedOut) {
        const cfg = moderationOf(st.guide);
        const real = [...m.sessions.values()].filter((s) => s.studyId === st.id && !s.isTest);
        const completed: Record<string, number> = {}, open: Record<string, number> = {};
        for (const s of real) { const k = s.segment ?? ""; if (s.status === "completed" && !s.excluded) completed[k] = (completed[k] ?? 0) + 1; if (s.status === "in_progress") open[k] = (open[k] ?? 0) + 1; }
        const totalCompleted = real.filter((s) => s.status === "completed" && !s.excluded).length;
        const totalOpen = real.filter((s) => s.status === "in_progress").length;
        if (cfg.studyBudgetUsd && st.spentUsd >= cfg.studyBudgetUsd) return { admitted: false, reason: "budget reached" };
        const v = quotaVerdict({ ...cfg, screener: [] }, { completed, open, totalCompleted, totalOpen }, a.segment);
        if (!v.open) return { admitted: false, reason: /full$/.test(v.reason ?? "") && a.segment ? "quota full" : totalCompleted >= (cfg.targetCompletes ?? Infinity) ? "target reached" : "full for now" };
      }
      if ([...m.sessions.values()].some((s) => s.tokenHash === a.tokenHash)) throw new Error("duplicate token");
      const number = [...m.sessions.values()].filter((s) => s.studyId === st.id).reduce((n, s) => Math.max(n, s.participantNumber), 0) + 1;
      const sid = id();
      m.sessions.set(sid, {
        id: sid, studyId: st.id, surveyId: st.surveyId, participantId: id(), participantNumber: number, segment: a.segment, mode: a.mode, language: a.language,
        status: a.screenedOut ? "screened_out" : "in_progress", excluded: false, isTest: a.isTest, state: a.state as ModeratorState, flags: a.flags, turnsCount: 0, costUsd: 0, version: 0,
        startedAt: now(), externalRef: a.externalRef, consent: a.consent, tokenHash: a.tokenHash, lastActivity: now(), completedAt: a.screenedOut ? now() : null,
      });
      m.turns.set(sid, []);
      return { admitted: true, sessionId: sid, participantId: m.sessions.get(sid)!.participantId, number };
    },
    async sessionByHash(hash) { const s = [...m.sessions.values()].find((x) => x.tokenHash === hash); return s ? { ...s, state: JSON.parse(JSON.stringify(s.state)) } : null; },
    async turns(sid) { return [...(m.turns.get(sid) ?? [])]; },
    async recordTurn(a: RecordArgs) {
      const s = m.sessions.get(a.sessionId);
      if (!s || s.version !== a.expected || s.status !== "in_progress") return null;
      const list = m.turns.get(s.id) ?? [];
      if (a.turns.some((t) => list.some((x) => x.seq === t.seq)) || new Set(a.turns.map((t) => t.seq)).size !== a.turns.length) throw new Error("duplicate key value violates unique constraint");
      list.push(...a.turns.map((t) => ({ ...t })));
      m.turns.set(s.id, list);
      s.state = JSON.parse(JSON.stringify(a.state)); s.status = a.status; s.flags = a.flags; s.turnsCount = a.turnsCount;
      s.costUsd += Math.max(0, a.costDelta); s.version++; s.lastActivity = now();
      if (a.completed) s.completedAt ??= now();
      const st = m.studies.get(s.studyId);
      if (st && a.costDelta > 0) st.spentUsd += a.costDelta;
      return s.version;
    },
    async saveQual(a) {
      const s = m.sessions.get(a.session.id);
      if (!s) return null;
      s.qual = { title: a.transcript.title, transcript: a.transcript };
      return { qualSessionId: `mem-qs-${s.id}`, qualTranscriptId: `mem-qt-${s.id}` };
    },
    async mediaOwned() { return false; },

    /* ---------------------------------------------------------------- the Studio sandbox's view */
    launch(guide: QualStudy, o: { title: string; guideLanguage?: string }) {
      const sid = id();
      const study: StudyRec = { id: sid, surveyId: "sandbox", customerId: null, title: o.title.slice(0, 200) || "AI interviews", status: "live", linkToken: hex(18), testToken: hex(18), guide, guideLanguage: o.guideLanguage ?? "en", spentUsd: 0 };
      m.studies.set(sid, study);
      const observerKey = hex(16);
      m.observers.set(observerKey, sid);
      return { study, observerKey };
    },
    studyForObserver(key: string) { const sid = m.observers.get(key); return sid ? m.studies.get(sid) ?? null : null; },
    sessionsOf(studyId: string) {
      sweep(studyId);
      return [...m.sessions.values()].filter((s) => s.studyId === studyId).sort((a, b) => b.startedAt - a.startedAt).map((s) => ({ ...s, turns: [...(m.turns.get(s.id) ?? [])], lastActivity: s.lastActivity, completedAt: s.completedAt, qual: s.qual }));
    },
    setStudyStatus(studyId: string, status: StudyRec["status"]) { const st = m.studies.get(studyId); if (st) st.status = status; return !!st; },
    endSession(sessionId: string) { const s = m.sessions.get(sessionId); if (!s || s.status !== "in_progress") return false; s.status = "ended"; s.version++; s.completedAt = now(); return true; },
    excludeSession(sessionId: string, excluded: boolean, reason?: string) { const s = m.sessions.get(sessionId); if (!s) return false; s.excluded = excluded; (s as { exclusionReason?: string }).exclusionReason = reason; return true; },
    touch(sessionId: string, at: number) { const s = m.sessions.get(sessionId); if (s) s.lastActivity = at; },
  };
}

export interface SandboxOps {
  launch(guide: QualStudy, o: { title: string; guideLanguage?: string }): { study: StudyRec; observerKey: string };
  studyForObserver(key: string): StudyRec | null;
  sessionsOf(studyId: string): (SessionRec & { turns: InterviewTurnRecord[]; lastActivity: number; completedAt: number | null; qual?: { title: string; transcript: QualTranscriptShape } })[];
  setStudyStatus(studyId: string, status: StudyRec["status"]): boolean;
  endSession(sessionId: string): boolean;
  excludeSession(sessionId: string, excluded: boolean, reason?: string): boolean;
  touch(sessionId: string, at: number): void;
}

/** forget everything (tests) */
export function resetMemoryStore(): void { globalThis.__rescriptAiInterviewMem = undefined; }
