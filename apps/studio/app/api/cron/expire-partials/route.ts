import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseService } from "@/lib/authServer";
import { planPartialExpiry, inactiveSinceFilter } from "@/lib/partialExpiry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * ABANDONED PARTIALS EXPIRE (RUNTIME-07, audit 2026-10-16).
 *
 * Nothing ever closed an `in_progress` response, so a respondent who walked
 * away on page 3 was "in progress" for ever — in fieldwork counts, in the
 * in-progress filter, and holding any List Fill slot their session claimed
 * (the 0007 header expected a release for abandoned sessions; nothing called
 * it). This job marks an `in_progress` row whose last activity (last save,
 * else start) is older than its survey's window as `abandoned` (status added
 * by migration 0056) and releases its List Fill claims through
 * `rescript_release_listfill` — the same call a screen-out makes on save.
 *
 * The window is per survey (`partialExpiryDays`, default 30; 0 = never) —
 * see lib/partialExpiry.ts for where it is read and why 30. Surveys are
 * grouped by window, so the usual case (everyone on the default) is a handful
 * of statements however many surveys there are.
 *
 * Every write is a compare-and-swap on `status = 'in_progress'` AND the same
 * inactivity filter, so a respondent who saves between our read and our
 * write keeps their session. Bounded in slices and time; the next run (hourly)
 * picks up what this one did not reach.
 */

const BUDGET_MS = 45_000;
const SLICE = 500;
const SURVEY_PAGE = 1000;
const IN_CHUNK = 100;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  /* no secret, no run — the same rule as the other jobs */
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

type SettingsPaths = { dep?: unknown; set?: unknown; ext?: unknown; lf?: unknown };

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const db = supabaseService();
  const startedAt = Date.now();
  const now = new Date();
  const overBudget = () => Date.now() - startedAt > BUDGET_MS;

  try {
    /* 1. every survey, with the raw settings paths of its draft (fallback) */
    const surveys: { id: string; versionId: string | null; draft: SettingsPaths }[] = [];
    for (let from = 0; ; from += SURVEY_PAGE) {
      const { data, error } = await db.from("surveys")
        .select("id, current_version_id, dep:draft_definition->deployment, set:draft_definition->settings, ext:draft_definition->meta_extensions, lf:draft_definition->listFills")
        .order("id").range(from, from + SURVEY_PAGE - 1);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        surveys.push({ id: String(r.id), versionId: (r.current_version_id as string | null) ?? null, draft: { dep: r.dep, set: r.set, ext: r.ext, lf: r.lf } });
      }
      if ((data ?? []).length < SURVEY_PAGE) break;
    }

    /* 2. the published version's settings win over the draft's — that is what respondents run */
    const published = new Map<string, SettingsPaths>();
    for (const ids of chunks([...new Set(surveys.map((s) => s.versionId).filter((v): v is string => !!v))], IN_CHUNK)) {
      const { data, error } = await db.from("survey_versions")
        .select("id, dep:definition->deployment, set:definition->settings, ext:definition->meta_extensions, lf:definition->listFills")
        .in("id", ids);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Record<string, unknown>[]) published.set(String(r.id), { dep: r.dep, set: r.set, ext: r.ext, lf: r.lf });
    }
    const pathsOf = (s: (typeof surveys)[number]): SettingsPaths => (s.versionId && published.get(s.versionId)) || s.draft;
    const hasListFill = new Set(surveys.filter((s) => { const lf = pathsOf(s).lf; return Array.isArray(lf) && lf.length > 0; }).map((s) => s.id));

    const plan = planPartialExpiry(
      surveys.map((s) => { const p = pathsOf(s); return { id: s.id, definition: { deployment: p.dep, settings: p.set, meta_extensions: p.ext } }; }),
      now,
    );

    /* 3. group by cutoff (same window → same cutoff), then sweep in slices */
    const byCutoff = new Map<string, string[]>();
    for (const p of plan) byCutoff.set(p.cutoff, [...(byCutoff.get(p.cutoff) ?? []), p.surveyId]);

    let abandoned = 0;
    let released = 0;
    let more = false;
    outer: for (const [cutoff, surveyIds] of byCutoff) {
      const inactive = inactiveSinceFilter(cutoff);
      for (const ids of chunks(surveyIds, IN_CHUNK)) {
        for (;;) {
          if (overBudget()) { more = true; break outer; }
          const { data: rows, error: selErr } = await db.from("responses")
            .select("id")
            .in("survey_id", ids).eq("status", "in_progress").is("deleted_at", null)
            .or(inactive)
            .limit(SLICE);
          if (selErr) throw new Error(selErr.message);
          const rowIds = (rows ?? []).map((r) => (r as { id: string }).id);
          if (!rowIds.length) break;
          const { data: changed, error: updErr } = await db.from("responses")
            .update({ status: "abandoned" })
            .in("id", rowIds).eq("status", "in_progress")
            .or(inactive)
            .select("survey_id, session_id");
          if (updErr) throw new Error(updErr.message);
          abandoned += changed?.length ?? 0;
          for (const r of (changed ?? []) as { survey_id: string; session_id: string }[]) {
            if (!hasListFill.has(r.survey_id)) continue;
            const { error: lfErr } = await db.rpc("rescript_release_listfill", { p_survey: r.survey_id, p_session: r.session_id });
            if (lfErr) console.error("[rescript:expire-partials] list fill release failed", { session: r.session_id.slice(0, 8), error: lfErr.message });
            else released++;
          }
          if (rowIds.length < SLICE) break;
        }
      }
    }
    if (abandoned) console.info("[rescript:expire-partials] partials abandoned", { abandoned, released, more, ms: Date.now() - startedAt });
    return NextResponse.json({ ok: true, surveys: surveys.length, expiring: plan.length, abandoned, released, more });
  } catch (e) {
    console.error("[rescript:expire-partials] sweep failed", { error: (e as Error).message });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
