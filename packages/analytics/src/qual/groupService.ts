import {
  participantView, checkAnswer, canAnswer, voteSample, canVote, tick, nextHandle, currentPrompt, readGroupSettings,
  type GroupSession, type GroupParticipant, type GroupAnswer, type GroupVote,
} from "./groups.js";

/**
 * THE PARTICIPANT SIDE OF A GROUP SESSION, over any store (2026-10-22) — the
 * runtime (Supabase, service role) and the Studio's sandbox (memory) run the same
 * orchestration: join (consent, a handle, a token whose HASH is stored), see the
 * current question and their rating sample, answer, rate. The session's own
 * clock (autonomous mode) advances on any poll. Nothing a participant sends can
 * change the session's prompts, phase or other participants' rows.
 *
 * I/O is the store's; hashing and token generation are injected (Node crypto in
 * the runtime). Errors are `{ status, error }`, never a thrown provider message.
 */

export interface GroupRow { id: string; surveyId: string; joinCode: string; status: string; state: GroupSession; version: number }
export interface GroupStore {
  byCode(code: string): Promise<GroupRow | null>;
  participants(groupId: string): Promise<(GroupParticipant & { tokenHash?: string })[]>;
  participantByHash(groupId: string, hash: string): Promise<GroupParticipant | null>;
  addParticipant(groupId: string, surveyId: string, p: { handle: string; tokenHash: string; group?: string; consentAt: string }): Promise<GroupParticipant | "handle_taken">;
  seen(participantId: string, at: string): Promise<void>;
  answers(groupId: string, promptId?: string): Promise<GroupAnswer[]>;
  upsertAnswer(groupId: string, surveyId: string, a: { promptId: string; participantId: string; text: string; at: string }): Promise<GroupAnswer>;
  votes(groupId: string): Promise<GroupVote[]>;
  addVote(groupId: string, surveyId: string, v: GroupVote): Promise<"ok" | "duplicate">;
  /** compare-and-set on the version; false when someone else wrote first */
  saveState(groupId: string, state: GroupSession, expectedVersion: number): Promise<boolean>;
}
export interface GroupDeps { now(): string; hash(token: string): string; newToken(): string }
export type GroupReply = { status: number; body: Record<string, unknown> };

const JOIN_CODE = /^[A-Za-z0-9_-]{16,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{24,120}$/;
const err = (status: number, error: string, code?: string): GroupReply => ({ status, body: { error, ...(code ? { code } : {}) } });

/** advance the session's clock (autonomous mode) if due; the stored state wins a race */
export async function advanceClock(store: GroupStore, row: GroupRow, now: string): Promise<GroupRow> {
  if (row.state.status !== "live" || row.state.mode !== "autonomous") return row;
  const cur = currentPrompt(row.state);
  const [people, answers, votes] = await Promise.all([store.participants(row.id), cur ? store.answers(row.id, cur.id) : Promise.resolve([]), store.votes(row.id)]);
  const ids = new Set(answers.map((a) => a.id));
  const votesHere = votes.filter((v) => ids.has(v.answerId)).length;
  const k = row.state.settings.voteSample;
  /* every participant who answered rates up to k of the others' answers */
  const expected = answers.length * Math.min(k, Math.max(0, answers.length - 1));
  const t = tick(row.state, { now, participants: people.length, answered: new Set(answers.map((a) => a.participantId)).size, votesDone: votesHere, votesExpected: expected });
  if (!t) return row;
  const ok = await store.saveState(row.id, t.session, row.version);
  return ok ? { ...row, state: t.session, version: row.version + 1 } : ((await store.byCode(row.joinCode)) ?? row);
}

/**
 * One participant request: { action: "join" | "view" | "answer" | "vote", code, token?, consent?, promptId?, text?, answerId?, vote? }.
 */
export async function participantAction(store: GroupStore, raw: unknown, deps: GroupDeps): Promise<GroupReply> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const code = String(b.code ?? "");
  if (!JOIN_CODE.test(code)) return err(404, "This link is not valid.", "no_session");
  let row = await store.byCode(code);
  if (!row) return err(404, "This conversation does not exist or has been removed.", "no_session");
  const now = deps.now();
  const action = String(b.action ?? "view");

  if (action === "join") {
    if (b.consent !== true) return err(400, "Please confirm that you agree to take part.", "consent_required");
    if (row.state.status === "closed") return err(409, "This conversation has ended.", "closed");
    const people = await store.participants(row.id);
    if (people.length >= readGroupSettings(row.state.settings).maxParticipants) return err(409, "This conversation is full.", "full");
    const token = deps.newToken();
    let added: GroupParticipant | "handle_taken" = "handle_taken";
    for (let attempt = 0; attempt < 5 && added === "handle_taken"; attempt++) {
      const taken = (await store.participants(row.id)).map((p) => p.handle);
      added = await store.addParticipant(row.id, row.surveyId, { handle: nextHandle(taken), tokenHash: deps.hash(token), consentAt: now });
    }
    if (added === "handle_taken") return err(503, "Too many people are joining at once — try again in a moment.", "busy");
    return { status: 200, body: { ok: true, token, handle: added.handle } };
  }

  const token = String(b.token ?? "");
  if (!TOKEN.test(token)) return err(401, "Join the conversation first.", "not_joined");
  const me = await store.participantByHash(row.id, deps.hash(token));
  if (!me) return err(401, "Join the conversation first.", "not_joined");
  void store.seen(me.id, now);
  row = await advanceClock(store, row, now);
  const s = row.state;

  if (action === "answer") {
    const promptId = String(b.promptId ?? "");
    const why = canAnswer(s, promptId);
    if (why) return err(409, why, "not_open");
    const a = checkAnswer(b.text);
    if (!a.ok) return err(400, a.error, "invalid");
    await store.upsertAnswer(row.id, row.surveyId, { promptId, participantId: me.id, text: a.text, at: now });
  } else if (action === "vote") {
    const cur = currentPrompt(s);
    const answers = cur ? await store.answers(row.id, cur.id) : [];
    const votes = await store.votes(row.id);
    if (!cur || !answers.some((x) => x.participantId === me.id)) return err(409, "Answer the question first, then rate others' answers.", "answer_first");
    const sample = voteSample(answers, votes, me.id, cur.id, s.settings.voteSample);
    const answer = answers.find((x) => x.id === String(b.answerId ?? ""));
    const vote = Number(b.vote);
    const why = canVote(s, answer, me.id, sample, vote);
    if (why) return err(409, why, "not_open");
    const r = await store.addVote(row.id, row.surveyId, { answerId: answer!.id, voterId: me.id, vote: vote as 1 | -1 | 0, at: now });
    if (r === "duplicate") return err(409, "You have rated this answer already.", "duplicate");
  } else if (action !== "view") return err(400, "unknown action");

  const cur = currentPrompt(s);
  const [people, answers, votes] = await Promise.all([store.participants(row.id), cur ? store.answers(row.id, cur.id) : Promise.resolve([]), store.votes(row.id)]);
  return { status: 200, body: { ok: true, view: participantView(s, me, { participants: people.length, answers, votes }, now) } };
}

/* ------------------------------------------------------------ an in-memory store (the Studio sandbox, the tests) */

export function memoryGroupStore(): GroupStore & { rows: Map<string, GroupRow>; put(row: GroupRow): void; all: { participants: (GroupParticipant & { tokenHash: string; groupId: string })[]; answers: (GroupAnswer & { groupId: string })[]; votes: (GroupVote & { groupId: string })[] } } {
  const rows = new Map<string, GroupRow>();
  const all = { participants: [] as (GroupParticipant & { tokenHash: string; groupId: string })[], answers: [] as (GroupAnswer & { groupId: string })[], votes: [] as (GroupVote & { groupId: string })[] };
  let n = 0;
  /* random as well as counted: a store reloaded from a file (the dev sandbox) never reissues an id */
  const id = (p: string) => `${p}-${(++n).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const strip = <T extends { groupId: string }>(x: T) => { const { groupId: _g, ...rest } = x; void _g; return rest; };
  return {
    rows, all,
    put(row) { rows.set(row.id, JSON.parse(JSON.stringify(row))); },
    async byCode(code) { const r = [...rows.values()].find((x) => x.joinCode === code); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async participants(g) { return all.participants.filter((p) => p.groupId === g).map((p) => { const { groupId: _g, ...rest } = p; void _g; return rest; }); },
    async participantByHash(g, h) { const p = all.participants.find((x) => x.groupId === g && x.tokenHash === h); if (!p) return null; const { groupId: _g, tokenHash: _t, ...rest } = p; void _g; void _t; return rest; },
    async addParticipant(g, _s, p) { if (all.participants.some((x) => x.groupId === g && x.handle === p.handle)) return "handle_taken"; const row = { id: id("p"), groupId: g, handle: p.handle, tokenHash: p.tokenHash, joinedAt: p.consentAt, ...(p.group ? { group: p.group } : {}) }; all.participants.push(row); const { groupId: _g, tokenHash: _t, ...rest } = row; void _g; void _t; return rest; },
    async seen(pid, at) { const p = all.participants.find((x) => x.id === pid); if (p) p.lastSeenAt = at; },
    async answers(g, promptId) { return all.answers.filter((a) => a.groupId === g && (!promptId || a.promptId === promptId)).map(strip); },
    async upsertAnswer(g, _s, a) { const ex = all.answers.find((x) => x.groupId === g && x.promptId === a.promptId && x.participantId === a.participantId); if (ex) { ex.text = a.text; return strip(ex); } const row = { id: id("a"), groupId: g, ...a }; all.answers.push(row); return strip(row); },
    async votes(g) { return all.votes.filter((v) => v.groupId === g).map(strip); },
    async addVote(g, _s, v) { if (all.votes.some((x) => x.answerId === v.answerId && x.voterId === v.voterId)) return "duplicate"; all.votes.push({ ...v, groupId: g }); return "ok"; },
    async saveState(g, state, expected) { const r = rows.get(g); if (!r || r.version !== expected) return false; rows.set(g, { ...r, state: JSON.parse(JSON.stringify(state)), status: state.status, version: expected + 1 }); return true; },
  };
}
