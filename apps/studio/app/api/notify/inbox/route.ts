import { NextRequest } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { notifyActor, noStore } from "@/lib/notify/access";
import { notifyDeps, notifyStore } from "@/lib/notify/server";
import { runDue } from "@/lib/notify/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MY ALERTS — the in-app bell (2026-10-22, G3). Rows of 0008's `notifications` whose action is `alert.<severity>`
 * (the sandbox: memory). Strictly the caller's own.
 *
 *   GET                       { alerts: [{ id, title, text, link, severity, createdAt, read }], unread }
 *   POST { ids? }             mark read (all, or the ones named)
 *
 * The bell polls, so it also gives the scheduled pass a nudge (retries and digests that are due), bounded and
 * best-effort: an installation without CRON_SECRET still sends its digests while someone has the Studio open.
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const store = notifyStore();
  await runDue(notifyDeps(store), { limit: 20 }).catch(() => null);
  const rows = await store.listInApp(actor.userId, 50).catch(() => []);
  return noStore({ ok: true, alerts: rows.map((r) => ({ id: r.id, surveyId: r.surveyId, title: r.title, text: r.text, link: r.link, severity: r.severity, createdAt: r.createdAt, read: !!r.readAt })), unread: rows.filter((r) => !r.readAt).length });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).slice(0, 200) : undefined;
  await notifyStore().markInAppRead(actor.userId, ids);
  return noStore({ ok: true });
}
