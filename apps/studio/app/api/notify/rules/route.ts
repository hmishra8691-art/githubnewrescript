import { NextRequest } from "next/server";
import { AlertSettings } from "@rescript/schema";
import { NOTIFY_EVENTS } from "@rescript/engine";
import { isFailure, requireUser } from "@/lib/guard";
import { notifyActor, noStore, refuseManage } from "@/lib/notify/access";
import { notifyStore } from "@/lib/notify/server";

export const dynamic = "force-dynamic";

/**
 * AN ORGANISATION'S ALERT RULES (2026-10-22, G3) — Settings → Alerts. A study adds its own rules on its definition
 * (`definition.alerts`, Research Tools → Qualitative → Alerts & panels, or Intelligent Mode's configure_alerts);
 * both apply, so a study cannot switch off the organisation's distress alert.
 *
 *   GET          { settings, events } — the event catalogue for the editor
 *   PUT { settings }   replace (AlertSettings: rules, quiet hours, the hourly cap, the dedupe window)
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const settings = actor.customerId ? await notifyStore().orgSettings(actor.customerId) : null;
  return noStore({ ok: true, settings: settings ?? AlertSettings.parse({}), events: Object.entries(NOTIFY_EVENTS).filter(([t]) => t !== "notify.test").map(([type, m]) => ({ type, label: m.label, severity: m.severity, digest: m.digest })), canManage: actor.canManage });
}

export async function PUT(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const body = (await req.json().catch(() => null)) as { settings?: unknown } | null;
  const parsed = AlertSettings.safeParse(body?.settings);
  if (!parsed.success) return noStore({ error: `The alert settings are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}` }, 400);
  for (const r of parsed.data.rules) for (const c of r.channels) if (/^https?:\/\//i.test(c.to)) return noStore({ error: "A rule names a channel by its name; webhook addresses belong in the channel (they are secrets)." }, 400);
  await notifyStore().saveOrgSettings(actor.customerId, parsed.data, actor.sandbox ? null : actor.userId);
  return noStore({ ok: true, settings: parsed.data });
}
