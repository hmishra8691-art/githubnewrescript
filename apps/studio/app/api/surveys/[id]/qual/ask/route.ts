import { NextRequest } from "next/server";
import { aiProviderName } from "@rescript/ai";
import { retrieveForQuestion, askPrompt, readAskReply, fakeAskReply, noEvidenceAnswer, ASK_SYSTEM, ASK_SCHEMA, ASK_MAX_TOKENS, redactText, type QualSegment, type QualState, type SourceMeta, type AskAnswer } from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { hasPii, json, recordEvents, refuse, storeFailure } from "@/lib/qual/qualStore";
import { parseAskRequest } from "@/lib/qual/synthesisWorkspace";
import { modelRunner } from "@/lib/qual/synthesisStore";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * ASK THE QUALITATIVE DATA (2026-10-22) — POST { question } ("what did Gen Z say about price?").
 *
 * Retrieval is the code's (the groups the question names, then its words against the excerpts, their codes and
 * themes); nothing relevant → "not enough evidence" with NO model call; otherwise one metered call with the
 * retrieved excerpts (redacted, fenced), and every sentence of the answer must cite them — or it is dropped.
 * The answer carries the cited excerpts (redacted for a member without contact details). Data view + Analytics
 * edit (a model call is spent). The sandbox (fake provider) sends its state.
 */
function withQuotes(a: AskAnswer, state: QualState, sources: Record<string, SourceMeta>, redact: (t: string) => string) {
  const cited = [...new Set(a.claims.flatMap((c) => c.excerptIds))].map((id) => state.excerpts.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => ({ id: e.id, quote: redact(e.quote), sourceId: e.sourceId, source: sources[e.sourceId]?.title ?? "", speaker: e.speaker, start: e.start, segmentId: e.segmentId }));
  return { ...a, claims: a.claims.map((c) => ({ ...c, text: redact(c.text) })), quotes: cited };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const q = parseAskRequest(body);

  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox asks only the fake provider" }, 403);
    if (!q.ok) return json({ error: q.error }, 400);
    const state = body.state as QualState | undefined;
    const segments = (Array.isArray(body.segments) ? body.segments : []) as QualSegment[];
    if (!state?.codebook) return json({ error: "send the sandbox's state and segments" }, 400);
    const sources = (body.sources && typeof body.sources === "object" ? body.sources : {}) as Record<string, SourceMeta>;
    const names = Array.isArray(body.redactNames) ? body.redactNames.map(String) : [];
    const r = retrieveForQuestion(q.value.question, state, segments, { sources, redact: { names } });
    if (!r.items.length) return json({ ok: true, answer: withQuotes(noEvidenceAnswer(r), state, sources, (t) => t), calls: 0 });
    const runner = await modelRunner(isFailure(authed) ? null : authed, "sandbox", "qual_ask", "analytics.edit", Array.isArray(body.fake) ? body.fake : null);
    if ("response" in runner) return runner.response;
    const m = await runner.run({ system: ASK_SYSTEM, prompt: (nonce) => askPrompt(r, { nonce, redact: { names } }), maxTokens: ASK_MAX_TOKENS, schema: ASK_SCHEMA, schemaName: "qual_ask", fake: () => fakeAskReply(r), seed: `ask:${q.value.question}` });
    if (!m.ok) return m.response;
    const groups = [...new Set(segments.map((s) => s.group).filter((g): g is string => !!g))];
    return json({ ok: true, answer: withQuotes(readAskReply(m.value, r, groups), state, sources, (t) => t), calls: runner.calls });
  }

  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  if (!q.ok) return json({ error: q.error }, 400);
  try {
    const db = supabaseService();
    const ctx = await synthesisContext(db, params.id);
    const redact = hasPii(gate) ? (t: string) => t : (t: string) => redactText(t, { names: ctx.names }).text;
    const r = retrieveForQuestion(q.value.question, ctx.state, ctx.segments, { sources: ctx.sources, redact: { names: ctx.names } });
    if (!r.items.length) return json({ ok: true, answer: withQuotes(noEvidenceAnswer(r), ctx.state, ctx.sources, redact), calls: 0 });
    const runner = await modelRunner(gate.user, params.id, "qual_ask");
    if ("response" in runner) return runner.response;
    const m = await runner.run({ system: ASK_SYSTEM, prompt: (nonce) => askPrompt(r, { nonce, redact: { names: ctx.names } }), maxTokens: ASK_MAX_TOKENS, schema: ASK_SCHEMA, schemaName: "qual_ask", fake: () => fakeAskReply(r), seed: `ask:${q.value.question}` });
    if (!m.ok) return m.response;
    const groups = [...new Set(ctx.segments.map((s) => s.group).filter((g): g is string => !!g))];
    const answer = readAskReply(m.value, r, groups);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "synthesis.asked", detail: `Asked “${q.value.question.slice(0, 160)}”: ${answer.notEnoughEvidence ? "not enough evidence" : `${answer.claims.length} cited sentence(s)`}`, ids: [] }]);
    return json({ ok: true, answer: withQuotes(answer, ctx.state, ctx.sources, redact), calls: runner.calls });
  } catch (e) { return storeFailure(e); }
}
