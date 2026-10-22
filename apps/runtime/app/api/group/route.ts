import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { participantAction, supabaseGroupStore } from "@rescript/analytics";
import { supabaseAdmin } from "@/lib/admin";

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
    const r = await participantAction(supabaseGroupStore(supabaseAdmin(), {}), body, { now: () => new Date().toISOString(), hash: sha, newToken });
    return reply(r.body, r.status);
  } catch (e) {
    console.warn("[rescript:group] participant request failed", JSON.stringify({ error: (e as Error).message }));
    return reply({ error: "Something went wrong — your answer may not have been saved. Try again." }, 500);
  }
}
