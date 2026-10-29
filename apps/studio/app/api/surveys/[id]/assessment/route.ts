import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { can } from "@rescript/access";
import { isAssessment, type AssessmentAnalytics } from "@rescript/engine";
import { exportAssessmentDocx } from "@rescript/exporters";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { dbConfigured } from "@/lib/copilot/durable";
import { docxName, researcherAssessment, type CompletedResponse, type StoredAssessmentRow } from "@/lib/assessmentResults";

export const dynamic = "force-dynamic";

/**
 * ASSESSMENT RESULTS FOR THE RESEARCHER (K4 2026-10-25, ported 2026-10-29 step 4B; docs/ASSESSMENTS-2026-10-29.md part B)
 * — what Data Analytics → Assessment results draws.
 *
 *   GET ?env=live|test               n, re-scored count, analytics (distribution, pass rate, topics, item analysis)
 *   GET ?env=live|test&format=docx   the answer-key sheet + marking + the distribution and item analysis, as Word
 *
 * Gate: `requireUser` → `requireProjectFor(…, "project.read")`, then `responses.read` (the scores are response data;
 * the answer key is in the Word file, which a project reader can already see in the Studio). Completed, not deleted
 * responses of the environment; each one's server score from `assessment_results` (0076) when it was scored against
 * the current key, otherwise re-scored from its answers (`lib/assessmentResults.ts`). Before 0076 is applied every
 * row is re-scored.
 *
 * SANDBOX (no database only; 403 elsewhere): the paper lives in the runtime's memory (`/api/assessment/sandbox`).
 *   POST { action: "launch", definition }   → { takeUrl (absolute /x/<token>), observerKey }
 *   GET  /sandbox/assessment?key=<observer>[&format=docx]   that paper's attempts → the same analytics / Word
 * The observer key (128-bit, returned only to the launcher) is the credential.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const sandboxRuntime = async (body: Record<string, unknown>) => {
  try {
    const r = await fetch(`${runtimeBaseUrl()}/api/assessment/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (e) {
    return { status: 502, body: { error: `the respondent runtime could not be reached (${(e as Error).message})` } };
  }
};
const docx = (buf: Buffer, title: string) => new NextResponse(new Uint8Array(buf), {
  headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="${docxName(title)}"`, "cache-control": "no-store" },
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const format = req.nextUrl.searchParams.get("format");
  if (params.id === "sandbox") {
    if (dbConfigured()) return json({ error: "the sandbox exists only without a database" }, 403);
    const key = req.nextUrl.searchParams.get("key") ?? "";
    if (!/^[0-9a-f]{32}$/.test(key)) return json({ ok: true, sandbox: true, assessment: false, n: 0, analytics: null });
    const r = await sandboxRuntime({ action: "responses", observerKey: key, withDefinition: format === "docx" });
    if (r.status !== 200 || !r.body) return json(r.body ?? { error: "unavailable" }, r.status === 200 ? 502 : r.status);
    const analytics = (r.body.analytics ?? null) as AssessmentAnalytics | null;
    if (format === "docx") {
      const def = SurveyDefinition.safeParse(r.body.definition);
      if (!def.success) return json({ error: "the sandbox paper is gone (the runtime restarted) — take the test again" }, 404);
      return docx(await exportAssessmentDocx(def.data, { analytics }), def.data.meta.title);
    }
    return json({ ok: true, sandbox: true, assessment: true, title: r.body.title ?? null, n: analytics?.n ?? 0, rescored: 0, analytics });
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  if (!can(gate.grant, "responses.read")) return json({ error: "Your role on this project does not include reading responses, and assessment scores are response data." }, 403);
  const db = supabaseService();
  const loaded = await loadDefinition(db, params.id);
  if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
  const def = loaded.def;
  if (!isAssessment(def)) return json({ ok: true, assessment: false, n: 0, analytics: null });
  const isTest = req.nextUrl.searchParams.get("env") === "test";
  const { data, error } = await db.from("responses").select("session_id, completed_at, answers")
    .eq("survey_id", params.id).eq("is_test", isTest).eq("status", "complete").is("deleted_at", null)
    .order("completed_at", { ascending: true }).limit(5000);
  if (error) return json({ error: "the responses could not be read" }, 500);
  const responses = (data ?? []) as CompletedResponse[];
  let stored: StoredAssessmentRow[] = [];
  if (responses.length) {
    /* 0076 not applied yet → an error here: every response is re-scored from its answers */
    const s = await db.from("assessment_results").select("session_id, key_fingerprint, result").eq("survey_id", params.id).eq("is_test", isTest).limit(5000);
    if (!s.error) stored = (s.data ?? []) as StoredAssessmentRow[];
  }
  const out = researcherAssessment(def, responses, stored);
  if (format === "docx") return docx(await exportAssessmentDocx(def, { analytics: out.analytics }), def.meta.title);
  return json({ ok: true, assessment: true, env: isTest ? "test" : "live", n: out.n, rescored: out.rescored, keyFingerprint: out.keyFingerprint, analytics: out.analytics });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (params.id !== "sandbox") {
    if (isFailure(authed)) return authed.response;
    return json({ error: "a saved project's paper is taken through its Test Survey or live link; read the results with GET" }, 400);
  }
  if (dbConfigured()) return json({ error: "the sandbox exists only without a database" }, 403);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.action !== "launch") return json({ error: "expected { action: \"launch\", definition }" }, 400);
  const r = await sandboxRuntime({ action: "launch", definition: body.definition });
  if (r.status !== 200 || !r.body) return json(r.body ?? { error: "unavailable" }, r.status === 200 ? 502 : r.status);
  return json({ ok: true, observerKey: r.body.observerKey, takeUrl: `${runtimeBaseUrl()}${String(r.body.takeUrl ?? "")}`, validation: r.body.validation ?? null });
}
