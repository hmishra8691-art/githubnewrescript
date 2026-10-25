import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { redactForClient, taskStoreFor } from "@/lib/copilot/taskStore";

export const dynamic = "force-dynamic";

/**
 * THE TASK A RESEARCHER CAN SEE (§10).
 *
 *   GET ?surveyId=            the survey's open task, or null
 *   GET ?surveyId=&id=        one task by id
 *
 * Until now the durable rows had no reader at all: the execution panel took a
 * task as a prop and nothing supplied one, so a reload — let alone a reload
 * on another device — showed nothing, which is the whole thing §10 asked for.
 *
 * WHAT COMES BACK IS `redactForClient`, NEVER AN `ExecTask`. That is the
 * rule the store's header states and this is its first subject: the raw row
 * carries the researcher's request verbatim and every step's model output,
 * and neither belongs in a client payload. The redacted shape keeps the
 * status, the progress counts, the spend and the per-step state, with titles
 * and failure messages scrubbed.
 *
 * READ RIGHT ONLY (`project.read`). Seeing what a generation is doing is not
 * editing it, so this deliberately does not require the editing lock the way
 * /api/copilot/record does.
 *
 * `durable: false` says the rows are in this server's memory: the sandbox, or
 * an installation that has not applied migration 0074. The panel says so to
 * the researcher rather than implying the work is safely stored.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  const surveyId = (req.nextUrl.searchParams.get("surveyId") ?? "").trim();
  if (!surveyId) return NextResponse.json({ error: "surveyId is required" }, { status: 400 });

  if (surveyId !== "sandbox") {
    if (isFailure(user)) return user.response;
    const ctx = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
  }

  try {
    const store = await taskStoreFor(surveyId);
    const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
    const task = id ? await store.load(id) : await store.openFor(surveyId);
    /* a task of another survey is not this caller's to read, whatever id they sent */
    if (task && task.surveyId !== surveyId) return NextResponse.json({ task: null, durable: store.durable });
    return NextResponse.json({ task: task ? redactForClient(task) : null, durable: store.durable });
  } catch (e) {
    /*
     * The table may not exist yet. That is not an error the researcher needs
     * to see: the panel simply has nothing to show.
     */
    console.warn("[rescript:copilot]", JSON.stringify({ event: "the task could not be read", error: ((e as Error)?.message ?? "").slice(0, 200) }));
    return NextResponse.json({ task: null, durable: false });
  }
}
