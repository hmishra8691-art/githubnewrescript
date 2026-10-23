import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { participantAction, supabaseGroupStore } from "@rescript/analytics";
import { supabaseAdmin } from "@/lib/admin";
import { panelParams, runtimePanels } from "@/lib/panels";
import { detectAbuse, detectDistress, scanUntrusted } from "@rescript/engine";
import { emitFromRuntime, studioPath } from "@/lib/notifyEmit";

export const dynamic = "force-dynamic";

/**
 * A PARTICIPANT IN A TEXT GROUP SESSION (2026-10-22) — POST { action: "join" | "view" | "answer" | "vote", code, token?, … }.
 *
 * Who may call: anyone holding the session's link (`/g/<code>`, a random 24-character code) — like a survey link.
 * Joining needs explicit consent and gives a handle (P1, P2 …) and a random token kept only in the participant's
 * browser; the database keeps its SHA-256 hash. Every later request proves the token. A participant can answer
 * the open question, rate the answers in their own sample (never their own), and read the current question and
 * their sample — never anyone's identity, never the moderator's view. Nothing a participant sends changes the
 * session's prompts or phase (the session's own clock may advance on any poll, in autonomous mode).
 *
 * The orchestration is `@rescript/analytics` qual/groupService.ts, over the 0070 tables (service role). Without a
 * database (a developer machine running the Studio's sandbox against the FAKE provider, never production), the
 * request is forwarded server-to-server to the Studio's sandbox, whose address comes from the environment only.
 */
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return reply({ error: "bad json" }, 400); }
  if (!body || typeof body !== "object") return reply({ error: "bad request" }, 400);
  /* G3 2026-10-22: panel recruitment around the conversation (entry + dedupe on join; the end link once it has ended) */
  const r = await withPanels(body, () => participant(body));
  /* G3: an answer that reads as distress, abuse or instructions to an AI is a group-session flag for the team (once per participant and kind) */
  if (r.status === 200 && body.action === "answer" && typeof body.text === "string") await groupFlag(body, (r.body as { view?: { handle?: string } } | null)?.view?.handle ?? null);
  return reply(r.body, r.status);
}

async function participant(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const reply = (b: unknown, status: number) => ({ status, body: b });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (process.env.AI_API_URL === "fake:" && process.env.NODE_ENV !== "production") {
      const studio = (process.env.STUDIO_SANDBOX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
      try {
        const r = await fetch(`${studio}/api/surveys/sandbox/qual/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, role: "participant" }), cache: "no-store" });
        return reply(await r.json().catch(() => ({ error: "the sandbox did not answer" })), r.status);
      } catch { return reply({ error: "The conversation service is not reachable." }, 503); }
    }
    return reply({ error: "Group sessions are not available on this installation." }, 503);
  }
  try {
    const { params: _p, ...rest } = body;
    const r = await participantAction(supabaseGroupStore(supabaseAdmin(), {}), rest, { now: () => new Date().toISOString(), hash: sha, newToken });
    return reply(r.body, r.status);
  } catch (e) {
    console.warn("[rescript:group] participant request failed", JSON.stringify({ error: (e as Error).message }));
    return reply({ error: "Something went wrong — your answer may not have been saved. Try again." }, 500);
  }
}

/**
 * G3: a group session's panel participants. JOIN: the link's parameters → the study's panel (by its id parameter):
 * refused without the id, refused as a duplicate when that panel id already took part, sent back as over quota when
 * the panel's completes are met; an admitted entry is tied to the participant (by the hash of their token — the token
 * itself is never stored). VIEW: once the conversation has ended, the panel's end link (complete) and code.
 */
async function withPanels(body: Record<string, unknown>, run: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }> {
  const panels = runtimePanels();
  const action = String(body.action ?? "view");
  if (!panels || (action !== "join" && action !== "view")) return run();
  const code = String(body.code ?? "");
  if (action === "join") {
    const surveyId = await surveyOf(code);
    if (!surveyId) return run();
    const entry = await panels.enter({ surveyId, target: "group_session", targetRef: code.slice(0, 64), params: panelParams(body.params), isTest: false });
    if (entry.kind === "refused" || entry.kind === "duplicate") return { status: 409, body: { error: entry.message, code: `panel_${entry.kind}` } };
    if (entry.kind === "over_quota") return { status: 409, body: { error: entry.message, code: "panel_over_quota", panel: { url: entry.redirect.url, code: entry.redirect.showCode ? entry.redirect.code : null } } };
    const r = await run();
    const token = (r.body as { token?: string } | null)?.token;
    if (entry.kind === "admitted" && r.status === 200 && token) await panels.attach(entry.entryId, `grp:${sha(token)}`);
    return r;
  }
  const r = await run();
  const v = (r.body as { view?: { status?: string; phase?: string } } | null)?.view;
  const token = typeof body.token === "string" ? body.token : "";
  if (r.status === 200 && v && (v.status === "closed" || v.phase === "ended") && token) {
    const out = await panels.exit({ sessionRef: `grp:${sha(token)}`, outcome: "complete", status: "group_closed" });
    if (out) return { status: 200, body: { ...(r.body as object), panel: { url: out.url, code: out.showCode ? out.code : null } } };
  }
  return r;
}

async function surveyOf(code: string): Promise<string | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return "sandbox";
  const { data } = await supabaseAdmin().from("qual_group_sessions").select("survey_id").eq("join_code", code).maybeSingle();
  return (data?.survey_id as string) ?? null;
}

async function groupFlag(body: Record<string, unknown>, handle: string | null): Promise<void> {
  const text = String(body.text ?? "").slice(0, 1500);
  const kind = detectDistress(text) ? "distress" : detectAbuse(text) ? "abuse" : scanUntrusted(text).flagged ? "instructions to an AI" : null;
  if (!kind) return;
  const code = String(body.code ?? "");
  const surveyId = await surveyOf(code).catch(() => null);
  if (!surveyId) return;
  const who = typeof body.token === "string" ? sha(body.token).slice(0, 16) : "anon";
  await emitFromRuntime({ type: "group_session.flag", surveyId, ref: `${code.slice(0, 12)}:${who}:${kind}`, idempotencyKey: `group_session.flag:${code.slice(0, 24)}:${who}:${kind}`, participant: handle && /^P\d+$/.test(handle) ? handle : null, excerpt: text, link: studioPath(surveyId, { tab: "qualitative", qual: "groups" }), detail: { kind } });
}
