import "server-only";
import { normaliseNotifyInput, type NotifyEmitInput } from "@rescript/engine";
import { aiProviderName, deriveKey, signedHeader } from "@rescript/ai";
import { supabaseAdmin } from "@/lib/admin";

/**
 * ALERT EVENTS FROM THE RESPONDENT RUNTIME (2026-10-22, G3) — an AI interview's distress / abuse / injection flag,
 * its completion, a quota / target / budget reached, a provider fallback, a group-session flag. The runtime does not
 * deliver alerts (the webhook URLs are the Studio's secrets); it hands the event over:
 *
 *   with a database   the event is written to the 0072 OUTBOX here (redacted first — the participant's words never
 *                     reach a table unredacted), then the Studio is told to deliver it now: POST
 *                     {STUDIO_INTERNAL_URL}/api/notify/ingest {eventId}, signed with a sub-key of INTEGRATIONS_SECRET_KEY.
 *                     If that call fails (or the variables are not set), the Studio's scheduled pass delivers it.
 *   the sandbox       (no database, the fake provider, not production) the event goes to the Studio's sandbox
 *                     server to server (STUDIO_SANDBOX_URL, default http://localhost:3000), as group sessions do.
 *
 * Never throws and never holds a participant up for more than ~3 seconds: an alert that cannot be handed over is
 * logged, and the interview carries on.
 */
const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const sandbox = () => !dbConfigured() && aiProviderName() === "fake" && process.env.NODE_ENV !== "production";
const studioBase = () => (process.env.STUDIO_INTERNAL_URL ?? process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

export async function emitFromRuntime(input: NotifyEmitInput): Promise<void> {
  try {
    if (sandbox()) {
      const base = (process.env.STUDIO_SANDBOX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
      await fetch(`${base}/api/notify/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: { ...input, source: "runtime" } }), cache: "no-store", signal: AbortSignal.timeout(20000) }); /* a cold dev compile of the ingest route */
      return;
    }
    if (!dbConfigured()) return;
    const n = normaliseNotifyInput(input, Date.now());
    if ("error" in n) { console.warn("[rescript:notify] event refused", JSON.stringify({ type: input.type, error: n.error })); return; }
    const db = supabaseAdmin();
    let customerId = input.customerId ?? null;
    if (!customerId) { const { data } = await db.from("surveys").select("customer_id, title").eq("id", input.surveyId).maybeSingle(); customerId = (data?.customer_id as string) ?? null; if (!n.payload.studyTitle) n.payload.studyTitle = (data?.title as string) ?? null; }
    const ins = await db.from("notify_events").insert({ idempotency_key: n.idempotencyKey, customer_id: customerId, survey_id: input.surveyId, type: n.type, ref: input.ref ?? null, payload: n.payload, source: "runtime", is_test: !!input.isTest }).select("id").single();
    if (ins.error) { if (!/duplicate|unique/i.test(ins.error.message)) console.warn("[rescript:notify] outbox write failed", JSON.stringify({ type: n.type, error: ins.error.message.slice(0, 160) })); return; }
    const key = deriveKey("notify-ingest");
    const base = studioBase();
    if (!key || !base) return;
    const body = JSON.stringify({ eventId: ins.data.id });
    await fetch(`${base}/api/notify/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-rescript-ingest": signedHeader(key, body) }, body, cache: "no-store", signal: AbortSignal.timeout(3000) }).catch(() => null);
  } catch (e) {
    console.warn("[rescript:notify] event not handed over", JSON.stringify({ type: input.type, error: (e as Error).message.slice(0, 160) }));
  }
}

/** a Studio path to a project's tab, for an alert's link (the sandbox has its own page) */
export function studioPath(surveyId: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return surveyId === "sandbox" ? `/sandbox?mode=studio${q ? `&${q}` : ""}` : `/studio/${encodeURIComponent(surveyId)}${q ? `?${q}` : ""}`;
}

/**
 * SURVEY FIELDWORK ALERTS (G3): a respondent ended on QUOTA FULL (once per survey per day — the idempotency key is
 * the day's) and completes MILESTONES — 25 / 50 / 75 / 100 % of the research design's sample size, each once. One
 * count query per live complete, only when the study states a sample size. Never throws, never blocks the save.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function surveyFieldworkEvents(db: any, a: { surveyId: string; status: string; isTest: boolean; sampleSize?: number | null; title?: string | null }): Promise<void> {
  if (a.isTest) return;
  try {
    const link = studioPath(a.surveyId, { tab: "fieldwork" });
    if (a.status === "quota_full") {
      const day = new Date().toISOString().slice(0, 10);
      await emitFromRuntime({ type: "survey.quota_full", surveyId: a.surveyId, studyTitle: a.title ?? null, ref: `quota:${day}`, idempotencyKey: `survey.quota_full:${a.surveyId}:${day}`, link, detail: { day } });
      return;
    }
    if (a.status !== "complete" || !a.sampleSize || a.sampleSize < 4) return;
    const { count } = await db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", a.surveyId).eq("status", "complete").eq("is_test", false).is("deleted_at", null);
    const n = Number(count ?? 0);
    for (const pct of [25, 50, 75, 100]) {
      if (n === Math.ceil((a.sampleSize * pct) / 100)) await emitFromRuntime({ type: "survey.milestone", surveyId: a.surveyId, studyTitle: a.title ?? null, ref: `milestone:${pct}`, idempotencyKey: `survey.milestone:${a.surveyId}:${pct}`, link, detail: { completes: n, target: a.sampleSize, percent: pct } });
    }
  } catch { /* an alert is never worth a failed save */ }
}
