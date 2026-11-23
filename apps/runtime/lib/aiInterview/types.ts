import type { QualStudy } from "@rescript/schema";
import type { InterviewTurnRecord, ModeratorFlag, ModeratorState, QualTranscriptShape } from "@rescript/engine";

/**
 * AI-MODERATED INTERVIEWS — what the runtime keeps (migration 0069), behind one interface with two
 * implementations: the database (service role, `supabaseStore.ts`) and memory (`memoryStore.ts`, only
 * on a runtime with no database AND the fake provider — the sandbox the browser suites and a laptop
 * use; nothing there is real or costs anything).
 */

export interface StudyRec {
  id: string;
  surveyId: string;
  customerId: string | null;
  title: string;
  status: "live" | "paused" | "closed";
  linkToken: string;
  testToken: string;
  guide: QualStudy;
  guideLanguage: string;
  spentUsd: number;
}

export type InterviewStatus = "in_progress" | "completed" | "screened_out" | "abandoned" | "flagged" | "ended";

export interface SessionRec {
  id: string;
  studyId: string;
  surveyId: string;
  participantId: string;
  participantNumber: number;
  segment: string | null;
  mode: "text" | "voice" | "video";
  language: string;
  status: InterviewStatus;
  excluded: boolean;
  isTest: boolean;
  state: ModeratorState;
  flags: ModeratorFlag[];
  turnsCount: number;
  costUsd: number;
  version: number;
  startedAt: number;
  externalRef: string | null;
  consent: { statement?: boolean; recording?: boolean; at?: string };
}

export interface BeginArgs {
  study: StudyRec;
  segment: string | null;
  isTest: boolean;
  screener: Record<string, unknown>;
  consent: SessionRec["consent"];
  language: string;
  externalRef: string | null;
  mode: SessionRec["mode"];
  tokenHash: string;
  state: ModeratorState | Record<string, never>;
  flags: ModeratorFlag[];
  screenedOut?: boolean;
}
export type BeginResult = { admitted: true; sessionId: string; participantId: string; number: number } | { admitted: false; reason: string };

export interface RecordArgs {
  sessionId: string;
  expected: number;
  turns: InterviewTurnRecord[];
  state: ModeratorState;
  status: InterviewStatus;
  flags: ModeratorFlag[];
  turnsCount: number;
  costDelta: number;
  completed: boolean;
}

export interface AiInterviewStore {
  kind: "supabase" | "memory";
  studyByLink(linkToken: string): Promise<StudyRec | null>;
  studyById(id: string): Promise<StudyRec | null>;
  begin(a: BeginArgs): Promise<BeginResult>;
  sessionByHash(hash: string): Promise<SessionRec | null>;
  turns(sessionId: string): Promise<InterviewTurnRecord[]>;
  /** the new version, or null when the session moved on (a double submit) or is no longer in progress */
  recordTurn(a: RecordArgs): Promise<number | null>;
  /** the finished interview as a qualitative session + transcript (0065); null when that could not be written */
  saveQual(a: { study: StudyRec; session: SessionRec; transcript: QualTranscriptShape }): Promise<{ qualSessionId: string; qualTranscriptId: string } | null>;
  /** does this media row belong to this interview? */
  mediaOwned(mediaId: string, sessionId: string): Promise<boolean>;
  /** Q5: the oldest question the observer room queued for this interview (null when none, or before migration 0115) */
  nextObserverQuestion(sessionId: string): Promise<{ id: string; text: string } | null>;
  /** Q5: the question was asked at this moderator turn, or refused (why) */
  settleObserverQuestion(id: string, outcome: { askedSeq: number } | { refused: string }): Promise<void>;
}

/** Q5: one note of the observer room (chat, marker, or a question for the moderator) */
export interface ObserverNote {
  id: string; kind: "chat" | "marker" | "question"; body: string; turnSeq: number | null; offsetMs: number | null;
  status: "queued" | "asked" | "refused" | "withdrawn" | null; askedSeq: number | null; refusedReason: string | null; authorLabel: string | null; createdAt: number;
}
