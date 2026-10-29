import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { taskStoreFor } from "@/lib/copilot/taskStore";
import { runSlice, stepBuilderFor, RECLAIM_SECONDS } from "@/lib/copilot/runner";
import type { ExecTask } from "@rescript/engine";
import { backgroundContextFor, isRefused, refusalMessage } from "@/lib/copilot/background";
import { checkDeliverable } from "@/lib/copilot/deliverable";
/*
 * Imported for its side effect: this is what registers the item path with
 * the runner. Without it `stepBuilderFor` returns null, the job reports that
 * it skipped, and nothing is ever built in the background.
 */
import { loadDefinition } from "@/lib/copilot/backgroundBuild";
/*
 * THE HANDLER TASKS (2026-10-29): a task planned by a registered planner is
 * built by its step handlers under the background's meter; a plan-item task
 * keeps the item path above. One builder decides which, by the rows.
 */
import { backgroundBuilderForTask, backgroundCheck, isHandlerTask } from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A CONTINUATION PATH THAT IS NOT THE BROWSER.
 *
 * Until now a long generation only ever advanced while a tab was open: the
 * page held the checkpoint, the page sent the next request, and a closed
 * laptop was the end of the work. The durable task rows fix where the work
 * LIVES; this job fixes who PUSHES it. A task left `running` or `pending`
 * past its reclaim window — the worker was recycled mid-slice, the request
 * was cut off, the researcher closed the tab — is picked up here and given
 * another slice.
 *
 * The browser, when it is there, still drives the next slice immediately.
 * That is now a FAST PATH, not the only path, and the two cannot collide:
 * `store.claim` takes each step with a lease (`for update skip locked` and a
 * reclaim window), and a committed step carries the idempotency key that
 * makes a second delivery a no-op. Two runners racing one task therefore
 * build each step once and bill it once.
 *
 * Deliberately bounded: a slice per task, a few tasks per run, a time budget
 * well inside the function's own limit, and the next run picks up the rest.
 * Nothing here knows HOW an item is built — the item path is registered by
 * the module that owns it (`setStepBuilder`); with nothing registered the job
 * reports that it skipped, and never pretends to have done work.
 */

const BUDGET_MS = 45_000;
/** a task is only this job's business once no worker has touched it for a reclaim window */
const STALE_MS = RECLAIM_SECONDS * 1000;
/** one task's slice, well inside BUDGET_MS so a second task still gets a turn */
const SLICE_MS = 20_000;
const TASKS = 10;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  /* no secret, no run — the same rule as the other jobs */
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });

  const startedAt = Date.now();
  let advanced = 0;
  let built = 0;
  let skipped = 0;
  let paused = 0;
  let more = false;
  const problems: { task: string; error: string }[] = [];

  try {
    /* the sweep is across surveys, so it asks for the store with no survey of its own; each task's slice then uses its own survey's store (RLS, billing attribution) */
    const sweep = await taskStoreFor("");
    const stale = await sweep.stale(STALE_MS, TASKS);
    for (const t of stale) {
      if (Date.now() - startedAt > BUDGET_MS - SLICE_MS) { more = true; break; }
      try {
        const store = await taskStoreFor(t.surveyId);
        const task = await store.load(t.id);
        if (!task) { skipped++; continue; }
        /*
         * MAY THIS TASK BE ADVANCED AT ALL, RIGHT NOW? Three questions, asked
         * before anything is spent: does its author still hold the edit right
         * on this project, is this the platform's key rather than a person's
         * own, and can the wallet cover another slice within the task's
         * ceiling. A no PAUSES the task with a sentence for the researcher —
         * `needs_attention`, not `failed`, because every step already built is
         * intact and it finishes as soon as the obstacle is gone.
         */
        const allowed = await backgroundContextFor(task);
        if (isRefused(allowed)) {
          /* an UNVERIFIED refusal is a missing answer, not a decided one: leave the task alone and ask again next sweep */
          if (!allowed.refused.unverified) {
            await store.pause(t.id, { reason: allowed.refused.kind, message: refusalMessage(allowed.refused) }).catch(() => undefined);
            paused++;
          } else skipped++;
          continue;
        }
        const handlerTask = isHandlerTask(task);
        const buildStep = handlerTask ? await backgroundBuilderForTask(task, { meter: allowed.meter, ctx: allowed.ctx }) : await stepBuilderFor(task);
        /* no item path registered in this process: say so, do not invent one */
        if (!buildStep) { skipped++; continue; }
        /*
         * The deliverable is the ONLY gate on `completed` (§9). The runner
         * refuses to complete a task without one, deliberately, so the cron
         * supplies the same check the turn route uses.
         */
        /*
         * No definition, no verdict. `runSlice` with no `check` leaves the
         * task `running` — which is the honest answer when the thing the
         * deliverable is about could not be read.
         */
        const def = handlerTask ? null : await loadDefinition(t.surveyId);
        const r = await runSlice(t.id, {
          budgetMs: SLICE_MS, store, buildStep,
          ...(handlerTask ? { check: (cur: ExecTask) => backgroundCheck(cur) } : def ? { check: async (cur: ExecTask) => checkDeliverable(cur.deliverable, def) } : {}),
        });
        advanced++;
        built += r.built.length;
        /* the provider asked us to come back: the next task would meet the same wall, so the rest is the next run's */
        if (r.retryAfterMs) { more = true; break; }
      } catch (e) {
        problems.push({ task: t.id, error: ((e as Error)?.message ?? "").slice(0, 200) });
      }
    }
    if (stale.length >= TASKS) more = true;
    if (advanced || skipped || paused || problems.length) {
      console.info("[rescript:intelligent-tasks] slices run", { stale: stale.length, advanced, built, skipped, paused, failed: problems.length, more, ms: Date.now() - startedAt });
    }
    return NextResponse.json({ ok: true, stale: stale.length, advanced, built, skipped, paused, failed: problems.length, more });
  } catch (e) {
    console.error("[rescript:intelligent-tasks] sweep failed", { error: (e as Error).message });
    return NextResponse.json({ ok: false, advanced, built, error: (e as Error).message }, { status: 503 });
  }
}
