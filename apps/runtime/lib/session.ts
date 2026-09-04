import "server-only";
import { supabaseAdmin } from "./admin";
import type { LoadedDeployment } from "./deployment";
import type { QuotaCounts } from "@rescript/engine";
import { hashIdentifier } from "@rescript/quality/server";

/** Per-survey salt for pseudonymous identifiers (QUALITY_HASH_SALT env, else the survey id). */
export function qualitySalt(surveyId: string): string {
  return `${process.env.QUALITY_HASH_SALT ?? "rescript"}:${surveyId}`;
}

export async function createSession(
  dep: LoadedDeployment,
  opts: {
    isTest: boolean;
    respondentToken?: string;
    userAgent?: string;
    /** the client IP — hashed with the survey's salt before storage, never stored raw */
    ip?: string | null;
    /**
     * Test mode only: mint a throwaway respondent for unique-link and
     * invitation surveys instead of refusing the session. Without this a
     * programmer could not test those two access modes at all — the test link
     * dead-ended on "requires a personal invitation link", which reads as a
     * broken survey rather than as a missing token.
     */
    allowTokenless?: boolean;
  },
): Promise<{ sessionId: string; seed: number; respondentId?: string } | { error: string }> {
  const db = supabaseAdmin();
  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const seed = Math.floor(Math.random() * 2 ** 31);

  let respondentId: string | undefined;
  const access = dep.definition.deployment.access;
  if (access.mode === "unique_links" || access.mode === "invitation") {
    if (!opts.respondentToken && opts.isTest && opts.allowTokenless) {
      // a disposable respondent, so test runs exercise the real token path
      const { data: made } = await db
        .from("respondents")
        .insert({
          survey_id: dep.surveyId,
          status: "started",
          meta: { test: true, createdBy: "test-runtime" },
        })
        .select("id")
        .single();
      respondentId = made?.id;
      const { error: insErr } = await db.from("responses").insert({
        survey_id: dep.surveyId,
        version_id: dep.versionId,
        session_id: sessionId,
        respondent_id: respondentId ?? null,
        is_test: true,
        seed,
        user_agent: opts.userAgent?.slice(0, 500) ?? null,
      });
      if (insErr) return { error: "Could not start the survey session." };
      return { sessionId, seed, respondentId };
    }
    if (!opts.respondentToken) return { error: "This survey requires a personal invitation link." };
    const { data: r } = await db
      .from("respondents")
      .select("id, status")
      .eq("survey_id", dep.surveyId)
      .eq("token", opts.respondentToken)
      .maybeSingle();
    if (!r) return { error: "Invalid invitation link." };
    if (!access.allowRetake && ["complete", "screened", "quota_full", "terminated"].includes(r.status))
      return { error: "This invitation link has already been used." };
    respondentId = r.id;
    await db.from("respondents").update({ status: "started" }).eq("id", r.id);
  }

  // network telemetry is opt-out per survey; the hash is salted per survey so
  // the same address never yields the same value across studies
  const telemetry = dep.definition.quality?.telemetry;
  const ipHash = telemetry?.network === false ? null : hashIdentifier(qualitySalt(dep.surveyId), opts.ip ?? null);
  const { error } = await db.from("responses").insert({
    survey_id: dep.surveyId,
    version_id: dep.versionId,
    session_id: sessionId,
    respondent_id: respondentId ?? null,
    is_test: opts.isTest,
    seed,
    user_agent: opts.userAgent?.slice(0, 500) ?? null,
    ip_hash: ipHash,
  });
  if (error) return { error: "Could not start the survey session." };
  return { sessionId, seed, respondentId };
}

export async function loadQuotaCounts(surveyId: string, includeTest: boolean): Promise<QuotaCounts> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("quota_counts")
    .select("quota_id, cell_id, count")
    .eq("survey_id", surveyId);
  const counts: QuotaCounts = {};
  for (const row of data ?? []) {
    counts[row.quota_id] = counts[row.quota_id] ?? {};
    counts[row.quota_id][row.cell_id] = row.count;
  }
  void includeTest;
  return counts;
}
