import { NextRequest } from "next/server";
import { AlertSettings } from "@rescript/schema";
import { NOTIFY_EVENTS, isNotifyEventType } from "@rescript/engine";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { mailConfig } from "@/lib/mail";
import { notifyActor, noStore, SANDBOX_ORG, SANDBOX_USER } from "@/lib/notify/access";
import { notifyDeps, notifySandbox, notifyStore, sandboxMemory, persistSandbox, secretsStatus } from "@/lib/notify/server";
import { emitNotifyEvent, studioLink } from "@/lib/notify/service";
import { channelView } from "@/lib/notify/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ONE STUDY'S ALERTS (2026-10-22, G3) — Research Tools → Qualitative → Alerts & panels. The study's rules are on its
 * definition (`definition.alerts`, saved with the project); this answers what the tab needs around them:
 *
 *   GET                         the organisation's channels (masked) for the rule editor, the study's delivery log,
 *                               whether secrets / e-mail are configured, the event catalogue, who "me" is
 *   POST { action: "try", type }   send a SAMPLE event through the study's rules now (deploy.manage) — what the
 *                               "Try the rules" button does; labelled test, a made-up participant, no real words
 *   POST { action: "sync", alerts, title }   THE SANDBOX only: the definition lives in the browser there, so the tab
 *                               hands the dispatcher the study's rules
 *
 * Reading: the project's responses.read (the log names participants by pseudonym); trying: deploy.manage.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const sandbox = params.id === "sandbox" && notifySandbox();
  if (!sandbox) {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, "responses.read");
    if (isFailure(gate)) return gate.response;
  }
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const store = notifyStore();
  const [channels, deliveries] = await Promise.all([
    actor.customerId ? store.listChannels(actor.customerId) : Promise.resolve([]),
    store.listDeliveries({ surveyId: params.id, limit: 100 }),
  ]);
  return noStore({
    ok: true, sandbox, me: actor.userId, canManage: actor.canManage,
    channels: channels.map(channelView), secrets: secretsStatus(), mail: { configured: mailConfig().configured },
    events: Object.entries(NOTIFY_EVENTS).filter(([t]) => t !== "notify.test").map(([type, m]) => ({ type, label: m.label, severity: m.severity })),
    deliveries: deliveries.map((d) => ({ id: d.id, eventType: d.eventType, channel: d.channelKind, destination: d.destination, status: d.status, reason: d.reason, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, responseStatus: d.responseStatus, error: d.lastError, test: d.isTest, createdAt: d.createdAt, sentAt: d.sentAt })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const sandbox = params.id === "sandbox" && notifySandbox();
  let title = "";
  if (!sandbox) {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, "deploy.manage");
    if (isFailure(gate)) return gate.response;
    title = gate.survey.title;
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStore({ error: "expected JSON" }, 400);
  if (body.action === "sync") {
    if (!sandbox) return noStore({ error: "Saved projects read their alert rules from the saved definition." }, 400);
    const alerts = body.alerts == null ? null : AlertSettings.safeParse(body.alerts);
    if (alerts && !alerts.success) return noStore({ error: "the alert settings are not valid" }, 400);
    sandboxMemory().projects.sandbox = { surveyId: "sandbox", customerId: SANDBOX_ORG, title: String(body.title ?? "Sandbox study").slice(0, 200), ownerId: SANDBOX_USER, alerts: alerts ? alerts.data : null, team: [{ userId: SANDBOX_USER, email: null }] };
    persistSandbox();
    return noStore({ ok: true });
  }
  if (body.action === "try") {
    const type = String(body.type ?? "ai_interview.distress");
    if (!isNotifyEventType(type) || type === "notify.test") return noStore({ error: "unknown event type" }, 400);
    const r = await emitNotifyEvent(notifyDeps(), {
      type, surveyId: params.id, studyTitle: title || null, ref: `try-${Date.now()}`, participant: "P0", isTest: true,
      excerpt: type === "ai_interview.distress" ? "(sample) I don't feel I can go on with this." : null,
      link: studioLink(params.id, { tab: "qualitative", qual: "alerts" }), detail: { sample: true },
    });
    if (!r.ok) return noStore({ error: r.error }, 400);
    return noStore({ ok: true, deliveries: r.deliveries.map((d) => ({ channel: d.channelKind, destination: d.destination, status: d.status, reason: d.reason, error: d.lastError })) });
  }
  return noStore({ error: "action is try or sync" }, 400);
}
