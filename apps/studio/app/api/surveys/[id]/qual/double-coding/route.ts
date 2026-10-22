import { NextRequest } from "next/server";
import {
  newAssignment, coderView, applyCoderOp, assignmentAgreement, disagreements, resolve, mergeResolved, bothSubmitted, isCoderOf,
  codingBatches, codingPrompt, readCodingReply, mergeCoding, fakeCodingReply, selectSegments, QUAL_CODING_SYSTEM, QUAL_CODING_SCHEMA, CODING_MAX_TOKENS,
  redactText, type CodingAssignment, type CoderSet, type QualExcerpt, type CodingRead,
} from "@rescript/analytics";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { hasPii, json, recordEvents, refuse, saveCoding, storeFailure, UUID } from "@/lib/qual/qualStore";
import { parseAssignmentCreate, parseCoderOp } from "@/lib/qual/synthesisWorkspace";
import { coderSets, getAssignment, insertAssignment, listAssignments, modelRunner, saveAssignment, saveCoderSet } from "@/lib/qual/synthesisStore";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * BLIND DOUBLE-CODING (2026-10-22). Data view + Analytics edit.
 *
 *   GET                                         the assignments as THIS member may see them: a coder sees their own
 *                                               coding only until both have submitted; the lead sees progress; then
 *                                               κ and α per code, pooled and mean, and the disagreements
 *   POST { action: "create", coderA?, coderB, overlapPct, sourceIds?, name? }  a seeded, stratified sample of
 *                                               participant segments; the codes in scope = the live codebook
 *   POST { action: "code", assignmentId, op }   a coder applies / removes a code on a unit (their private set)
 *   POST { action: "ai_code", assignmentId }    the AI codes the units deductively (one metered call per batch) as its
 *                                               coder, and submits
 *   POST { action: "submit", assignmentId }     a coder locks their coding
 *   POST { action: "resolve", assignmentId, unit, codeId, decision, note? }   apply / do not apply, with a note
 *   POST { action: "merge", assignmentId }      agreed + resolved codings → reviewed excerpts in the main coding
 *   POST { action: "cancel", assignmentId }
 *
 * The coders' sets live in qual_assignment_codings, which no member can read directly (RLS); only this route
 * reveals them, and only when both have submitted. The sandbox runs the same pure functions in the page.
 */
const now = () => new Date().toISOString();

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  try {
    const db = supabaseService();
    const ctx = await synthesisContext(db, params.id);
    const me = gate.user.userId;
    const red = hasPii(gate) ? (x: QualExcerpt) => x : (x: QualExcerpt) => ({ ...x, quote: redactText(x.quote, { names: ctx.names }).text });
    const out = [];
    for (const a of await listAssignments(db, params.id)) {
      const sets = await coderSets(db, params.id, a.id);
      const v = coderView(a, sets, me);
      const open = bothSubmitted(a);
      out.push({ ...a, role: v.role, blind: v.blind, progress: v.progress, mine: v.mine.map(red), other: v.other ? v.other.map(red) : null, ...(open ? { agreement: assignmentAgreement(a, sets, ctx.state.codebook), disagreements: disagreements(a, sets, ctx.state.codebook).map((d) => ({ ...d, ...(d.quoteA ? { quoteA: hasPii(gate) ? d.quoteA : redactText(d.quoteA, { names: ctx.names }).text } : {}), ...(d.quoteB ? { quoteB: hasPii(gate) ? d.quoteB : redactText(d.quoteB, { names: ctx.names }).text } : {}) })) } : {}) });
    }
    return json({ ok: true, me, assignments: out, people: ctx.full.people });
  } catch (e) { return storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");
  const me = gate.user.userId;
  const db = supabaseService();
  try {
    const ctx = await synthesisContext(db, params.id);
    if (action === "create") {
      const p = parseAssignmentCreate(body, me);
      if (!p.ok) return json({ error: p.error }, 400);
      let a: CodingAssignment;
      try { a = newAssignment({ id: "new", name: p.value.name, coderA: p.value.coderA, coderB: p.value.coderB, segments: ctx.segments, overlapPct: p.value.overlapPct, sourceIds: p.value.sourceIds, codebook: ctx.state.codebook, actor: me, now: now() }); }
      catch (e) { return json({ error: (e as Error).message }, 400); }
      const id = await insertAssignment(db, params.id, a, me);
      await recordEvents(db, gate, [{ actor: me, action: "double_coding.created", detail: `Set up blind double-coding “${a.name}”: ${a.units.length} segments (${a.overlapPct}% of each source), ${a.codeIds.length} codes, coders ${ctx.full.people[a.coderA] ?? a.coderA} and ${ctx.full.people[a.coderB] ?? a.coderB}`, ids: [id] }]);
      return json({ ok: true, id });
    }
    const id = String(body.assignmentId ?? "");
    if (!UUID.test(id)) return json({ error: "which assignment (assignmentId)" }, 400);
    const a = await getAssignment(db, params.id, id);
    if (!a) return json({ error: "no such assignment" }, 404);
    const sets = await coderSets(db, params.id, id);
    const setOf = (c: string) => sets.find((s) => s.coder === c) ?? { coder: c, excerpts: [], version: 0 };
    const segment = (src: string, sid: string) => ctx.segments.find((s) => s.sourceId === src && s.id === sid);
    const lead = a.createdBy === me || !isCoderOf(a, me);

    if (action === "code") {
      if (!isCoderOf(a, me)) return json({ error: "only the two coders code an assignment" }, 403);
      if (!hasPii(gate)) return json({ error: "Coding needs the text as recorded, and your access shows it redacted (no contact details).", code: "insufficient_role" }, 403);
      const op = parseCoderOp(body.op);
      if (typeof op === "string") return json({ error: op }, 400);
      const cur = setOf(me);
      let next: CoderSet;
      try { next = applyCoderOp(a, cur, op, ctx.state.codebook, { now: now(), segment }); } catch (e) { return json({ error: (e as Error).message }, 400); }
      if (!(await saveCoderSet(db, params.id, id, next, cur.version))) return json({ error: "Your coding changed in another tab — reload.", code: "version_conflict" }, 409);
      return json({ ok: true, mine: next.excerpts });
    }
    if (action === "ai_code") {
      if (a.coderA !== "ai" && a.coderB !== "ai") return json({ error: "the AI is not a coder of this assignment" }, 400);
      if (a.submitted.ai) return json({ error: "the AI has coded this assignment already" }, 409);
      const codebook = { ...ctx.state.codebook, codes: ctx.state.codebook.codes.filter((c) => a.codeIds.includes(c.id) && c.status !== "rejected") };
      const selected = selectSegments(ctx.segments, { segmentKeys: a.units });
      const { batches } = codingBatches(selected, { redact: { names: ctx.names } });
      const runner = await modelRunner(gate.user, params.id, "qual_coding");
      if ("response" in runner) return runner.response;
      const opts = { mode: "deductive" as const, codebook, objectives: ctx.study.objectives, redact: { names: ctx.names } };
      const reads: CodingRead[] = [];
      for (const [i, b] of batches.entries()) {
        const r = await runner.run({ system: QUAL_CODING_SYSTEM, prompt: (nonce) => codingPrompt(b, { ...opts, nonce }), maxTokens: CODING_MAX_TOKENS, schema: QUAL_CODING_SCHEMA, schemaName: "qual_coding", fake: () => fakeCodingReply(b, opts), seed: `dc:${id}:${i}` });
        if (!r.ok) return r.response;
        reads.push(readCodingReply(r.value, b, opts));
      }
      /* deductive: only codes in scope; a proposed new code is not part of a reliability test */
      const merged = mergeCoding({ codebook, excerpts: [] }, reads.map((r) => ({ ...r, codes: [], themes: [], relationships: [] })), { coder: "ai", now: now(), mode: "deductive", segmentCount: selected.length });
      const aiSet: CoderSet = { coder: "ai", excerpts: merged.state.excerpts.filter((e) => a.codeIds.includes(e.codeId)).map((e) => ({ ...e, coder: "ai" })) };
      const cur = setOf("ai");
      if (!(await saveCoderSet(db, params.id, id, aiSet, cur.version))) return json({ error: "the AI's coding changed at the same moment — reload", code: "version_conflict" }, 409);
      const next = { ...a, submitted: { ...a.submitted, ai: now() } };
      await saveAssignment(db, params.id, next, a.version);
      await recordEvents(db, gate, [{ actor: "ai", action: "double_coding.ai_coded", detail: `The AI coded “${a.name}” blind (${aiSet.excerpts.length} codings on ${a.units.length} segments, ${runner.calls} model call${runner.calls === 1 ? "" : "s"}; ${merged.rejected.length} quote(s) rejected as not verbatim)`, ids: [id] }]);
      return json({ ok: true, calls: runner.calls, coded: aiSet.excerpts.length });
    }
    if (action === "submit") {
      if (!isCoderOf(a, me)) return json({ error: "only a coder submits" }, 403);
      if (a.submitted[me]) return json({ error: "you have submitted already" }, 409);
      const next = { ...a, submitted: { ...a.submitted, [me]: now() } };
      next.status = bothSubmitted(next) ? "review" : a.status;
      if (!(await saveAssignment(db, params.id, next, a.version))) return json({ error: "The assignment changed — reload.", code: "version_conflict" }, 409);
      await recordEvents(db, gate, [{ actor: me, action: "double_coding.submitted", detail: `Submitted my coding of “${a.name}”${bothSubmitted(next) ? " — both coders have submitted; agreement is available" : ""}`, ids: [id] }]);
      return json({ ok: true });
    }
    if (action === "resolve") {
      if (!lead && !isCoderOf(a, me)) return json({ error: "only the lead or a coder resolves" }, 403);
      try {
        const r = resolve(a, { unit: String(body.unit ?? ""), codeId: String(body.codeId ?? ""), decision: body.decision as "apply" | "not_apply", note: typeof body.note === "string" ? body.note : undefined }, { actor: me, now: now() });
        if (!(await saveAssignment(db, params.id, r.assignment, a.version))) return json({ error: "The assignment changed — reload.", code: "version_conflict" }, 409);
        await recordEvents(db, gate, [{ ...r.entry, actor: me }]);
        return json({ ok: true });
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (action === "merge") {
      const full = ctx.full;
      try {
        const m = mergeResolved(full.state, a, sets, { actor: me, now: now() });
        const saved = await saveCoding(db, params.id, m.state, full.version, me);
        if (saved === null) return json({ error: "The coding changed at the same moment — reload, then merge again.", code: "version_conflict" }, 409);
        await saveAssignment(db, params.id, { ...a, status: "merged" }, a.version);
        await recordEvents(db, gate, [{ ...m.entry, actor: me }]);
        return json({ ok: true, added: m.added });
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (action === "cancel") {
      if (!lead) return json({ error: "only the person who set it up cancels it" }, 403);
      await saveAssignment(db, params.id, { ...a, status: "cancelled" }, a.version);
      await recordEvents(db, gate, [{ actor: me, action: "double_coding.cancelled", detail: `Cancelled “${a.name}”`, ids: [id] }]);
      return json({ ok: true });
    }
    return json({ error: "action is create, code, ai_code, submit, resolve, merge or cancel" }, 400);
  } catch (e) { return storeFailure(e); }
}
