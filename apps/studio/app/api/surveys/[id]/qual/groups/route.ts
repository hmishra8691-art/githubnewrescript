import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiProviderName } from "@rescript/ai";
import {
  newGroupSession, promptsFromGuide, applyModeratorOp, currentPrompt, promptResults, clusterInput, clusterPrompt, readClusters, wordClusters, fakeClusterReply,
  followUpPrompt, readFollowUp, fakeFollowUpReply, groupTranscript, participantAction, advanceClock, memoryGroupStore, redactText, GroupError,
  GROUP_CLUSTER_SYSTEM, GROUP_CLUSTER_SCHEMA, GROUP_CLUSTER_MAX_TOKENS, GROUP_FOLLOWUP_SYSTEM, GROUP_FOLLOWUP_SCHEMA, GROUP_FOLLOWUP_MAX_TOKENS,
  type GroupStore, type GroupRow, type GroupSession, type GroupPrompt, type ModeratorOp,
} from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser, type AuthedUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { checkRow, hasPii, json, loadSettings, recordEvents, refuse, storeFailure, UUID } from "@/lib/qual/qualStore";
import { joinCode, parseModeratorOp } from "@/lib/qual/synthesisWorkspace";
import { claimGroupLease, dbGroupStore, getGroup, insertGroup, linkGroup, listGroups, modelRunner, releaseGroupLease, setParticipantSegment } from "@/lib/qual/synthesisStore";
import { enqueueAutoCode } from "@/lib/qual/autoCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * TEXT GROUP SESSIONS — THE MODERATOR'S SIDE (2026-10-22). A Remesh-style live conversation: the participants
 * join through a link to the respondent app (`/g/<code>`, apps/runtime), answer each prompt, rate a sample of
 * others' answers; here the moderator runs it.
 *
 *   GET                       the project's group sessions                                  Data view
 *   GET ?id=…                 one session live: the state, participants (handles and groups), the current
 *                             answers (redacted without contact details), clusters, votes by code    Data view
 *   POST { action: "create", title, mode?, prompts?: string[], settings? }   prompts from the guide by default
 *   POST { action: "op", id, version, op }      start / voting / next / ask / approve or reject a follow-up / mode / end
 *   POST { action: "ai", id, step: "cluster" | "followup" }   one metered call (or the word grouping without a model),
 *                                               under the session's lease; answers fenced and redacted; output checked
 *   POST { action: "segment", id, participantId, segment }    the participant group a handle belongs to
 *   POST { action: "close", id }                the session becomes a qualitative source (a focus-group session record
 *                                               and a transcript with speakers and timestamps), queued for auto-coding
 *   POST/GET … Data edit to run; Data view to watch.
 *
 * THE SANDBOX (fake provider only, no database) keeps sessions in this process's memory and also answers the
 * participants' requests (`role: "participant"`), which the runtime forwards to it when it has no database — so
 * the browser suite runs a real conversation across the two apps. Video conferencing is not supported.
 */

type MemoryStore = ReturnType<typeof memoryGroupStore>;
const SANDBOX_KEY = "__rescriptGroupSandbox";
/*
 * The sandbox's sessions live in this process — and in a file under the OS temp directory, so a development
 * server that restarts (they do, under memory pressure) does not drop a live test conversation. Fake provider only.
 */
const SANDBOX_FILE = join(tmpdir(), "rescript-group-sandbox.json");
function sandboxStore(): MemoryStore {
  const g = globalThis as unknown as Record<string, MemoryStore>;
  if (!g[SANDBOX_KEY]) {
    const st = memoryGroupStore();
    try {
      const saved = JSON.parse(readFileSync(SANDBOX_FILE, "utf8")) as { rows: GroupRow[]; all: MemoryStore["all"] };
      for (const r of saved.rows ?? []) st.put(r);
      st.all.participants.push(...(saved.all?.participants ?? [])); st.all.answers.push(...(saved.all?.answers ?? [])); st.all.votes.push(...(saved.all?.votes ?? []));
    } catch { /* none yet */ }
    g[SANDBOX_KEY] = st;
  }
  return g[SANDBOX_KEY];
}
function persistSandbox(): void {
  const st = sandboxStore();
  try { writeFileSync(SANDBOX_FILE, JSON.stringify({ rows: [...st.rows.values()], all: st.all })); } catch { /* best effort */ }
}
const now = () => new Date().toISOString();
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");

/** the live view of one session for the moderator */
async function liveView(store: GroupStore, row: GroupRow, opts: { pii: boolean; names: string[] }) {
  const s = row.state;
  const [people, answers, votes] = await Promise.all([store.participants(row.id), store.answers(row.id), store.votes(row.id)]);
  const red = (t: string) => (opts.pii ? t : redactText(t, { names: opts.names }).text);
  const cur = currentPrompt(s);
  const handleOf = new Map(people.map((p) => [p.id, p.handle]));
  return {
    id: row.id, joinCode: row.joinCode, version: row.version, state: s,
    participants: people.map((p) => ({ id: p.id, handle: p.handle, group: p.group ?? null, joinedAt: p.joinedAt, lastSeenAt: p.lastSeenAt ?? null })),
    answers: answers.map((a) => ({ id: a.id, promptId: a.promptId, handle: handleOf.get(a.participantId) ?? "?", text: red(a.text), at: a.at })),
    results: Object.fromEntries(s.prompts.filter((p) => p.askedAt).map((p) => [p.id, promptResults(p.id, answers, votes, s.clusters[p.id])])),
    current: cur ? { id: cur.id, text: cur.text, answered: answers.filter((a) => a.promptId === cur.id).length } : null,
    votes: votes.length,
  };
}

/** one moderator action on a store (DB or memory) — the same code for both */
async function moderate(store: GroupStore, row: GroupRow, body: Record<string, unknown>, ctx: { user: AuthedUser | null; surveyId: string; names: string[]; objectives: string[]; lease?: () => Promise<boolean>; release?: () => Promise<void>; scripted?: unknown[] | null }): Promise<{ status: number; body: Record<string, unknown>; detail?: string }> {
  const action = String(body.action ?? "");
  if (action === "op") {
    const op = parseModeratorOp(body.op);
    if (typeof op === "string") return { status: 400, body: { error: op } };
    if (Number(body.version) !== row.version) return { status: 409, body: { error: "The session moved on since you loaded it — it has been refreshed.", code: "version_conflict" } };
    try {
      const r = applyModeratorOp(row.state, op as ModeratorOp, { now: now(), actor: ctx.user?.userId ?? "sandbox" });
      if (!(await store.saveState(row.id, r.session, row.version))) return { status: 409, body: { error: "The session moved on at the same moment — try again.", code: "version_conflict" } };
      return { status: 200, body: { ok: true }, detail: r.detail };
    } catch (e) { if (e instanceof GroupError) return { status: e.status, body: { error: e.message } }; throw e; }
  }
  if (action === "ai") {
    const step = body.step === "followup" ? "followup" : "cluster";
    const cur = currentPrompt(row.state);
    if (!cur) return { status: 409, body: { error: "no question is open" } };
    const answers = await store.answers(row.id, cur.id);
    const input = clusterInput(cur, answers, ctx.names);
    if (input.answers.length < (step === "cluster" ? row.state.settings.minAnswersToCluster : 1)) return { status: 409, body: { error: `waiting for answers (${input.answers.length} so far)` } };
    if (ctx.lease && !(await ctx.lease())) return { status: 202, body: { ok: true, busy: true } };
    try {
      const runner = await modelRunner(ctx.user, ctx.surveyId, step === "cluster" ? "qual_group_cluster" : "qual_group_followup", "responses.manage", ctx.scripted);
      let clusters = row.state.clusters[cur.id];
      let followup = null;
      if (step === "cluster") {
        if ("response" in runner) clusters = wordClusters(input, now());
        else {
          const r = await runner.run({ system: GROUP_CLUSTER_SYSTEM, prompt: (nonce) => clusterPrompt(input, { nonce }), maxTokens: GROUP_CLUSTER_MAX_TOKENS, schema: GROUP_CLUSTER_SCHEMA, schemaName: "qual_group_clusters", fake: () => fakeClusterReply(input), seed: `cluster:${row.id}:${cur.id}:${input.answers.length}` });
          clusters = r.ok ? readClusters(r.value, input, now()) : wordClusters(input, now());
        }
      } else {
        if ("response" in runner) return { status: 503, body: { error: "No AI provider is configured — type the follow-up yourself (Ask)." } };
        const fid = `f${row.state.followups.length + 1}`;
        const r = await runner.run({ system: GROUP_FOLLOWUP_SYSTEM, prompt: (nonce) => followUpPrompt(input, clusters, { nonce, objectives: ctx.objectives }), maxTokens: GROUP_FOLLOWUP_MAX_TOKENS, schema: GROUP_FOLLOWUP_SCHEMA, schemaName: "qual_group_followup", fake: () => fakeFollowUpReply(input, clusters), seed: `followup:${row.id}:${cur.id}:${fid}` });
        if (!r.ok) return { status: 502, body: { error: "The AI could not propose a follow-up — type one yourself (Ask)." } };
        followup = readFollowUp(r.value, input, { now: now(), id: fid });
        if (!followup) return { status: 200, body: { ok: true, note: "The AI proposed nothing usable." } };
      }
      /* apply onto the state as it is now (participants' polls may have moved the clock) */
      for (let attempt = 0; attempt < 3; attempt++) {
        const fresh = (await store.byCode(row.joinCode)) ?? row;
        const next: GroupSession = JSON.parse(JSON.stringify(fresh.state));
        if (step === "cluster" && clusters) next.clusters[cur.id] = clusters;
        if (followup && !next.followups.some((f) => f.id === followup!.id)) next.followups.push(followup);
        if (await store.saveState(fresh.id, next, fresh.version)) return { status: 200, body: { ok: true, ...(step === "cluster" ? { clusters } : { followup }) }, detail: step === "cluster" ? `${clusters?.origin === "ai" ? "AI-clustered" : "Grouped by words"} ${input.answers.length} answers to “${cur.text.slice(0, 60)}” into ${clusters?.clusters.length ?? 0}` : `The AI proposed a follow-up${followup!.problems.length ? ` (held back: ${followup!.problems.join(", ")})` : ""}` };
      }
      return { status: 409, body: { error: "The session kept changing — try again.", code: "version_conflict" } };
    } finally { await ctx.release?.(); }
  }
  return { status: 400, body: { error: "action is create, op, ai, segment or close" } };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox runs group sessions only against the fake provider" }, 403);
    const store = sandboxStore();
    if (!id) return json({ ok: true, sessions: [...store.rows.values()].map((r) => ({ id: r.id, title: r.state.title, status: r.state.status, mode: r.state.mode, phase: r.state.phase, joinCode: r.joinCode })) });
    let row = store.rows.get(id);
    if (!row) return json({ error: "no such group session" }, 404);
    const before = row.version;
    row = await advanceClock(store, row, now());
    if (row.version !== before) persistSandbox();
    return json({ ok: true, session: await liveView(store, row, { pii: true, names: [] }) });
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "read");
  if (refused) return refused;
  try {
    const db = supabaseService();
    if (!id) return json({ ok: true, sessions: (await listGroups(db, params.id)).map((r) => ({ id: r.id, title: r.state.title, status: r.state.status, mode: r.state.mode, phase: r.state.phase, joinCode: r.joinCode, transcriptId: r.transcriptId ?? null, createdAt: r.createdAt })) });
    if (!UUID.test(id)) return json({ error: "no such group session" }, 404);
    let row = await getGroup(db, params.id, id);
    if (!row) return json({ error: "no such group session" }, 404);
    const store = dbGroupStore(db, params.id);
    row = { ...row, ...(await advanceClock(store, row, now())) };
    return json({ ok: true, session: await liveView(store, row, { pii: hasPii(gate), names: (await loadSettings(db, params.id)).redactNames }) });
  } catch (e) { return storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");

  /* ---------------------------------------------------- the sandbox: memory, fake provider only */
  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox runs group sessions only against the fake provider" }, 403);
    const store = sandboxStore();
    if (body.role === "participant") { const r = await participantAction(store, body, { now, hash: sha, newToken }); persistSandbox(); return json(r.body, r.status); }
    if (action === "create") {
      const prompts = parsePrompts(body.prompts) ?? promptsFromGuide((body.guide ?? null) as never);
      try {
        const gid = `sbx-${randomBytes(6).toString("hex")}`;
        const s = newGroupSession({ id: gid, title: String(body.title ?? ""), mode: body.mode === "autonomous" ? "autonomous" : "moderated", prompts, settings: body.settings });
        store.put({ id: gid, surveyId: "sandbox", joinCode: joinCode(randomBytes(24)), status: s.status, state: s, version: 0 });
        persistSandbox();
        return json({ ok: true, id: gid });
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    const row = store.rows.get(String(body.id ?? ""));
    if (!row) return json({ error: "no such group session" }, 404);
    if (action === "segment") {
      const p = store.all.participants.find((x) => x.groupId === row.id && x.id === body.participantId);
      if (!p) return json({ error: "no such participant" }, 404);
      p.group = typeof body.segment === "string" && body.segment.trim() ? body.segment.trim().slice(0, 120) : undefined;
      persistSandbox();
      return json({ ok: true });
    }
    if (action === "close") {
      const closed = applyModeratorOp(row.state, { op: "end" }, { now: now(), actor: "sandbox" }).session;
      closed.status = "closed"; closed.closedAt = now();
      await store.saveState(row.id, closed, row.version);
      persistSandbox();
      const [people, answers, votes] = await Promise.all([store.participants(row.id), store.answers(row.id), store.votes(row.id)]);
      return json({ ok: true, transcript: groupTranscript(closed, people, answers, votes) });
    }
    const r = await moderate(store, row, body, { user: isFailure(authed) ? null : authed, surveyId: "sandbox", names: [], objectives: Array.isArray(body.objectives) ? body.objectives.map(String) : [], scripted: Array.isArray(body.fake) ? body.fake : null });
    persistSandbox();
    return json(r.body, r.status);
  }

  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const db = supabaseService();
  try {
    const loaded = await loadDefinition(db, params.id).catch(() => null);
    const def = loaded && !("error" in loaded) ? loaded.def : null;
    if (action === "create") {
      const prompts = parsePrompts(body.prompts) ?? promptsFromGuide(def?.qualStudy ?? null);
      let s: GroupSession;
      try { s = newGroupSession({ id: "new", title: String(body.title ?? ""), mode: body.mode === "autonomous" ? "autonomous" : "moderated", prompts, settings: body.settings }); } catch (e) { return json({ error: (e as Error).message }, 400); }
      const id = await insertGroup(db, params.id, { title: s.title, joinCode: joinCode(randomBytes(24)), state: s }, gate.user.userId);
      await db.from("qual_group_sessions").update({ state: { ...s, id } }).eq("id", id);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "group.created", detail: `Set up the group session “${s.title}” (${s.mode}, ${s.prompts.length} prompts)`, ids: [id] }]);
      return json({ ok: true, id });
    }
    const id = String(body.id ?? "");
    if (!UUID.test(id)) return json({ error: "which group session (id)" }, 400);
    const row = await getGroup(db, params.id, id);
    if (!row) return json({ error: "no such group session" }, 404);
    const store = dbGroupStore(db, params.id);
    const names = (await loadSettings(db, params.id)).redactNames;
    if (action === "segment") {
      const pid = String(body.participantId ?? "");
      if (!UUID.test(pid) || !(await setParticipantSegment(db, params.id, id, pid, typeof body.segment === "string" && body.segment.trim() ? body.segment.trim().slice(0, 120) : null))) return json({ error: "no such participant" }, 404);
      return json({ ok: true });
    }
    if (action === "close") {
      if (row.state.status === "closed" && row.transcriptId) return json({ ok: true, transcriptId: row.transcriptId, already: true });
      const closed = applyModeratorOp(row.state, { op: "end" }, { now: now(), actor: gate.user.userId }).session;
      closed.status = "closed"; closed.closedAt = now();
      if (!(await store.saveState(id, closed, row.version))) return json({ error: "The session moved on at the same moment — try again.", code: "version_conflict" }, 409);
      const [people, answers, votes] = await Promise.all([store.participants(id), store.answers(id), store.votes(id)]);
      const tr = groupTranscript(closed, people, answers, votes);
      const qs = checkRow(await db.from("qual_sessions").insert({ survey_id: params.id, kind: "focus_group", title: closed.title.slice(0, 200), scheduled_at: closed.startedAt, moderator: closed.mode === "autonomous" ? "AI (autonomous, within the guide)" : (gate.user.fullName || gate.user.email || "Moderator"), participants: tr.participants, consent: { captured: true, recording: false, method: "accepted on the join page (text session, no recording)", at: closed.startedAt ?? now() }, notes: `Text group session run in Rescript: ${people.length} participants, ${answers.length} answers, ${votes.length} ratings.`, status: "completed", created_by: gate.user.userId, updated_by: gate.user.userId }).select("id").single(), "session") as { id: string };
      const t = checkRow(await db.from("qual_transcripts").insert({ survey_id: params.id, session_id: qs.id, title: tr.title.slice(0, 200), source: "import", format: "speaker", segments: tr.segments, speakers: tr.speakers, char_count: tr.segments.reduce((n, x) => n + x.text.length, 0), meta: tr.meta, status: "ready", created_by: gate.user.userId }).select("id").single(), "transcript") as { id: string };
      await linkGroup(db, params.id, id, t.id, qs.id);
      await enqueueAutoCode(db, params.id, t.id, gate.user.userId).catch(() => null);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "group.closed", detail: `Closed the group session “${closed.title}”: it is now a source (${tr.segments.length} turns from ${people.length} participants)`, ids: [id, t.id, qs.id] }]);
      return json({ ok: true, transcriptId: t.id, sessionId: qs.id });
    }
    const r = await moderate(store, row, body, { user: gate.user, surveyId: params.id, names, objectives: def?.qualStudy?.objectives ?? [], lease: () => claimGroupLease(db, params.id, id), release: () => releaseGroupLease(db, params.id, id) });
    if (r.detail) await recordEvents(db, gate, [{ actor: action === "ai" ? "ai" : gate.user.userId, action: `group.${action}`, detail: `“${row.state.title}”: ${r.detail}`, ids: [id] }]);
    return json(r.body, r.status);
  } catch (e) { return storeFailure(e); }
}

function parsePrompts(v: unknown): GroupPrompt[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, 60);
  return list.length ? list.map((text, i) => ({ id: `g${i + 1}`, text: text.slice(0, 600), source: "guide" as const })) : null;
}
