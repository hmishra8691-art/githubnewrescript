import { NextRequest } from "next/server";
import { aiProviderName, completeJson } from "@rescript/ai";
import {
  applyQualOp, coerceQualOp, codingBatches, codingEstimate, codingPrompt, fakeCodingReply, mergeCoding, readCodingReply, redactionSummary, selectSegments, QualOpError,
  QUAL_CODING_SCHEMA, QUAL_CODING_SYSTEM, CODING_MAX_TOKENS,
  type CodingBatch, type CodingOptions, type CodingRead, type QualSegment, type QualState, type QualHistoryEntry,
} from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser, type AuthedUser } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";
import { supabaseService } from "@/lib/authServer";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { allSegments, parseCodingRequest, readSettings, toWorkspace } from "@/lib/qual/qualWorkspace";
import { hasPii, json, loadRows, loadWorkspace, recordEvents, refuse, saveCoding, saveSettings, storeFailure } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * CODING (2026-10-18). POST, by `action`:
 *
 *   "ai"        { mode: inductive|deductive, framework?, sourceIds?, segmentKeys?, version }
 *               AI codebook proposal and coding — the segments REDACTED (emails, phones, the
 *               names list), cut into bounded batches (≤ 12,000 characters / 80 segments, ≤ 10
 *               batches a run), ONE metered model call per batch (AI_REQUEST, operation
 *               `qual_coding`, ≤ 2,500 output tokens), the structured reply read with every quote
 *               located in its segment — a paraphrase is rejected and reported — and mapped back to
 *               the exact span of the original. Everything lands `ai_suggested`. Data view +
 *               Analytics edit.
 *   "op"        { op: {…}, version }  one review operation (accept / reject / edit / merge / split /
 *               rename / reassign / add a code, theme, relationship or excerpt), with its history
 *               entry. Data view + Analytics edit; a hand-made excerpt needs unredacted text.
 *   "settings"  { redactNames: [...] }  the names replaced before AI and for members without
 *               contact details. Data edit + contact details.
 *
 * `version` is the codebook version the caller is looking at; a write on top of a change they have
 * not seen is 409 (`version_conflict`) and the caller reloads — two coders never overwrite each other.
 *
 * THE SANDBOX (no database), against the FAKE provider only, may send its own `state` and
 * `segments` and gets the merged state back without anything being stored — so the browser suite
 * runs the real reader, the real substring check and the real merge.
 */
const FAKE_NOW = () => new Date().toISOString();

async function runAi(user: AuthedUser | null, surveyId: string, state: QualState, segments: QualSegment[], req: { mode: "inductive" | "deductive"; framework?: string; sourceIds?: string[]; segmentKeys?: string[] }, names: string[], scripted: unknown[] | null, objectives: string[]) {
  const selected = selectSegments(segments, req);
  const opts: CodingOptions = { mode: req.mode, framework: req.framework, codebook: state.codebook, objectives, redact: { names } };
  if (req.mode === "deductive" && !state.codebook.codes.some((c) => c.status !== "rejected") && !req.framework) return { error: json({ error: "Deductive coding needs codes or a framework — propose a codebook first (inductive), add codes, or paste the framework." }, 400) };
  const { batches, skipped } = codingBatches(selected, { redact: { names } });
  if (!batches.length) return { error: json({ error: "There is nothing to code — import a transcript or add open-ended answers first." }, 400) };
  if (!(await aiReadyFor(user, surveyId, "qual_coding"))) return { error: json({ error: "No AI provider is configured for this project, so codes cannot be proposed. Codes can still be added and applied by hand.", code: "ai_unconfigured" }, 503) };
  const billing = await billingProjectFor(user, surveyId, "analytics.edit");
  if ("response" in billing) return { error: billing.response };
  const fake = aiProviderName() === "fake";
  const reads: CodingRead[] = [];
  const started = Date.now();
  let notRun = 0;
  for (const [i, batch] of batches.entries()) {
    /* a batch that cannot finish inside the function's time is reported, not started */
    if (Date.now() - started > 200_000) { notRun += batches.length - i; break; }
    const user2 = codingPrompt(batch, opts);
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: QUAL_CODING_SYSTEM + user2, maxTokens: CODING_MAX_TOKENS, operation: "qual_coding" }, async () =>
      fake ? (scripted?.[i] ?? fakeCodingReply(batch, opts)) : completeJson(QUAL_CODING_SYSTEM, user2, CODING_MAX_TOKENS, { schema: { name: "qual_coding", schema: QUAL_CODING_SCHEMA }, timeoutMs: 90_000, operation: "qual_coding", deadline: started + 280_000 }));
    if (!m.ok) return { error: refusalResponse(m) };
    reads.push(readCodingReply(m.value, batch as CodingBatch, opts));
  }
  const merged = mergeCoding(state, reads, { now: FAKE_NOW(), mode: req.mode, framework: req.framework, segmentCount: selected.length });
  const redaction = redactionSummary(batches.flatMap((b) => b.items.map((it) => it.redacted)));
  return { merged, meta: { calls: reads.length, batches: batches.length, skippedSegments: skipped, notRunBatches: notRun, rejected: merged.rejected.slice(0, 100), problems: reads.flatMap((r) => r.problems).slice(0, 50), redaction, estimate: codingEstimate(batches, opts), provider: fake ? "fake" : "configured" } };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");

  /* ---------------------------------------------------- the sandbox: compute only, fake provider only */
  if (params.id === "sandbox") {
    if (aiProviderName() !== "fake") return isFailure(authed) ? authed.response : json({ error: "the sandbox codes only against the fake provider" }, 403);
    const state = body.state as QualState | undefined;
    const segments = Array.isArray(body.segments) ? (body.segments as QualSegment[]).filter((s) => s && typeof s.text === "string" && typeof s.id === "string" && typeof s.sourceId === "string").slice(0, 5000) : [];
    if (!state?.codebook || !Array.isArray(state.excerpts)) return json({ error: "send the sandbox's state and segments" }, 400);
    if (action !== "ai") return json({ error: "the sandbox applies review operations in the browser" }, 400);
    const r = parseCodingRequest(body);
    if (!r.ok) return json({ error: r.error }, 400);
    const names = readSettings(body.settings).redactNames;
    const out = await runAi(isFailure(authed) ? null : authed, "sandbox", state, segments, r.value, names, Array.isArray(body.fake) ? body.fake : null, Array.isArray(body.objectives) ? body.objectives.map(String).slice(0, 10) : []);
    if ("error" in out) return out.error!;
    return json({ ok: true, state: out.merged.state, entry: out.merged.entry, added: out.merged.added, ...out.meta });
  }

  if (isFailure(authed)) return authed.response;
  const opName = action === "settings" ? "settings" : "code";
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(opName));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, opName);
  if (refused) return refused;
  const db = supabaseService();
  try {
    if (action === "settings") {
      const s = readSettings(body);
      await saveSettings(db, params.id, s, gate.user.userId);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "settings.redaction", detail: `Set the redaction list (${s.redactNames.length} name${s.redactNames.length === 1 ? "" : "s"})`, ids: [] }]);
      return json({ ok: true, workspace: await loadWorkspace(db, gate) });
    }
    const rows = await loadRows(db, params.id);
    const full = toWorkspace(rows, { pii: true });
    const version = Number(body.version);
    if (!Number.isInteger(version) || version !== full.version) return json({ error: "The codebook has changed since you loaded it — reload to see the latest, then try again.", code: "version_conflict", version: full.version }, 409);
    const names = readSettings(rows.coding?.settings).redactNames;
    let next: QualState, entries: Omit<QualHistoryEntry, "at">[], extra: Record<string, unknown> = {};
    if (action === "ai") {
      const r = parseCodingRequest(body);
      if (!r.ok) return json({ error: r.error }, 400);
      const def = await objectivesOf(db, params.id);
      const out = await runAi(gate.user, params.id, full.state, allSegments(full), r.value, names, null, def);
      if ("error" in out) return out.error!;
      next = out.merged.state; entries = [out.merged.entry]; extra = { added: out.merged.added, ...out.meta };
    } else if (action === "op") {
      const op = coerceQualOp(body.op);
      if (typeof op === "string") return json({ error: op }, 400);
      if (op.op === "add_excerpt" && !hasPii(gate)) return json({ error: "Coding by hand needs the transcript as recorded, and your access shows it redacted (no contact details). Ask for contact-details access, or review the AI's excerpts instead.", code: "insufficient_role" }, 403);
      const segs = allSegments(full);
      try {
        const r = applyQualOp(full.state, op, { actor: gate.user.userId, now: new Date().toISOString(), segment: (src, id) => segs.find((s) => s.sourceId === src && s.id === id) });
        next = r.state; entries = [r.entry];
      } catch (e) {
        if (e instanceof QualOpError) return json({ error: e.message }, e.status);
        throw e;
      }
    } else return json({ error: "action is ai, op or settings" }, 400);
    const saved = await saveCoding(db, params.id, next, version, gate.user.userId);
    if (saved === null) return json({ error: "Another coder saved a change at the same moment — reload, then try again.", code: "version_conflict" }, 409);
    await recordEvents(db, gate, entries);
    return json({ ok: true, version: saved, ...extra, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}

/** the study's objectives, for the model's context (the guide's, else the research design's) */
async function objectivesOf(db: ReturnType<typeof supabaseService>, surveyId: string): Promise<string[]> {
  const loaded = await loadDefinition(db, surveyId).catch(() => null);
  const def = loaded && !("error" in loaded) ? loaded.def : null;
  const out = def?.qualStudy?.objectives?.length ? def.qualStudy.objectives : [def?.research?.objective, ...(def?.research?.researchQuestions ?? [])].filter((x): x is string => typeof x === "string" && !!x);
  return out.slice(0, 10).map((x) => String(x).slice(0, 300));
}

