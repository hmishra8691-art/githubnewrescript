import "server-only";
import { supabaseAdmin } from "./admin";
import type { LoadedDeployment } from "./deployment";
import type { QuotaCounts } from "@rescript/engine";
import { hashIdentifier } from "@rescript/quality/server";

/** Per-survey salt for pseudonymous identifiers (QUALITY_HASH_SALT env, else the survey id). */
export function qualitySalt(surveyId: string): string {
  return `${process.env.QUALITY_HASH_SALT ?? "rescript"}:${surveyId}`;
}

/**
 * The two §23 columns, omitted entirely when the link carried nothing — so a
 * survey nobody fields through a panel writes exactly the row it always did.
 */
function sampleColumns(opts: { sampleSource?: string | null; sampleSourceRespondent?: string | null }) {
  const out: Record<string, string> = {};
  if (opts.sampleSource) out.sample_source = opts.sampleSource;
  if (opts.sampleSourceRespondent) out.sample_source_respondent = opts.sampleSourceRespondent;
  return out;
}

/**
 * Insert the response row, and never lose an interview over a missing column.
 *
 * `responses.sample_source` arrived in migration 0012. A deployment running
 * this code against a database that has not been migrated yet would fail
 * every session that arrived with `?src=` — a survey that works for direct
 * links and dies for panel traffic, which is the worst possible way to find
 * out. So the insert retries once without the source columns and says so in
 * the log, exactly as the quota counters fall back for pre-0006 databases.
 */
async function insertResponseRow(
  db: ReturnType<typeof supabaseAdmin>,
  row: Record<string, unknown>,
): Promise<{ error: string } | null> {
  const { error } = await db.from("responses").insert(row);
  if (!error) return null;
  const hasSample = "sample_source" in row || "sample_source_respondent" in row;
  if (hasSample && /sample_source/.test(error.message ?? "")) {
    const { sample_source, sample_source_respondent, ...rest } = row;
    console.warn(
      "[rescript:session] this database predates migration 0012, so the sample source was not recorded",
      JSON.stringify({ sampleSource: sample_source ?? null }),
    );
    const retry = await db.from("responses").insert(rest);
    if (!retry.error) return null;
  }
  return { error: "Could not start the survey session." };
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
    /**
     * §23: which supplier sent this respondent, and their own id for the
     * person, read from the invitation URL. Captured at session start because
     * that is the only moment the URL exists — a respondent who reaches page
     * three has long since lost the parameter, and it cannot be recovered
     * afterwards from anything the platform stores.
     */
    sampleSource?: string | null;
    sampleSourceRespondent?: string | null;
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
      const insErr = await insertResponseRow(db, {
        survey_id: dep.surveyId,
        version_id: dep.versionId,
        session_id: sessionId,
        respondent_id: respondentId ?? null,
        is_test: true,
        seed,
        user_agent: opts.userAgent?.slice(0, 500) ?? null,
        ...sampleColumns(opts),
      });
      if (insErr) return insErr;
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
  const insErr = await insertResponseRow(db, {
    survey_id: dep.surveyId,
    version_id: dep.versionId,
    session_id: sessionId,
    respondent_id: respondentId ?? null,
    is_test: opts.isTest,
    seed,
    user_agent: opts.userAgent?.slice(0, 500) ?? null,
    ip_hash: ipHash,
    ...sampleColumns(opts),
  });
  if (insErr) return insErr;
  return { sessionId, seed, respondentId };
}

/**
 * The quota counters for ONE environment.
 *
 * `isTest` is the environment being run, not a widening flag: a test session
 * is closed by test counters and a live session by live ones (migration
 * 0006). This used to ignore the argument and sum both, which meant a busy
 * test link could close a live quota — the one thing the response-management
 * work said must never happen. The unfiltered read stays only as the
 * fallback for a database where 0006 has not been applied.
 */
export async function loadQuotaCounts(surveyId: string, isTest: boolean): Promise<QuotaCounts> {
  const db = supabaseAdmin();
  let { data, error } = (await db
    .from("quota_counts")
    .select("quota_id, cell_id, count")
    .eq("survey_id", surveyId)
    .eq("is_test", isTest)) as { data: { quota_id: string; cell_id: string; count: number }[] | null; error: { message: string } | null };
  if (error && /is_test/.test(error.message)) {
    ({ data } = (await db
      .from("quota_counts")
      .select("quota_id, cell_id, count")
      .eq("survey_id", surveyId)) as typeof data extends never ? never : { data: { quota_id: string; cell_id: string; count: number }[] | null });
  }
  const counts: QuotaCounts = {};
  for (const row of data ?? []) {
    counts[row.quota_id] = counts[row.quota_id] ?? {};
    counts[row.quota_id][row.cell_id] = row.count;
  }
  return counts;
}
