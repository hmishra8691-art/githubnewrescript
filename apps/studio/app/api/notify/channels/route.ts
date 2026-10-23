import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { mailConfig } from "@/lib/mail";
import { notifyActor, noStore, refuseManage } from "@/lib/notify/access";
import { channelAad, checkWebhookUrl, maskSecretUrl, notifyDeps, notifyStore, sealSecret, secretsStatus } from "@/lib/notify/server";
import { testChannel } from "@/lib/notify/service";
import { channelView, type ChannelKind, type ChannelRec } from "@/lib/notify/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AN ORGANISATION'S ALERT CHANNELS (2026-10-22, G3) — Settings → Alerts, and the Channels box of Research Tools →
 * Qualitative → Alerts & panels.
 *
 *   GET                                       the channels (masked: never a webhook URL), whether secrets can be
 *                                             stored here (INTEGRATIONS_SECRET_KEY) and whether e-mail is configured
 *   POST { kind: slack|teams|webhook, name, url }   add one: the URL is checked (https, a public address) and SEALED;
 *                                             a webhook also gets a signing secret, shown ONCE in this answer
 *   POST { kind: email, name, to: [addresses] }     an e-mail list (not secret)
 *   POST { action: "test", id }               send a test message now and record it in the delivery log
 *   PATCH { id, enabled?, name?, url?, to? }  change one (a new URL is sealed again)
 *   DELETE ?id=                               remove one
 *
 * Reading: the organisation's members; changing: programmers, researchers and administrators (lib/notify/access.ts).
 */

const KINDS: ChannelKind[] = ["slack", "teams", "webhook", "email"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const store = notifyStore();
  const channels = actor.customerId ? await store.listChannels(actor.customerId) : [];
  return noStore({ ok: true, channels: channels.map(channelView), secrets: secretsStatus(), mail: { configured: mailConfig().configured }, canManage: actor.canManage, sandbox: actor.sandbox });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return noStore({ error: "Send the channel as JSON." }, 400);
  const store = notifyStore();

  if (body.action === "test") {
    const ch = await store.getChannel(String(body.id ?? ""));
    if (!ch || ch.customerId !== actor.customerId) return noStore({ error: "No such channel." }, 404);
    const d = await testChannel(notifyDeps(store), ch, { surveyId: typeof body.surveyId === "string" ? body.surveyId : null });
    return noStore({ ok: d.status === "sent", status: d.status, error: d.status === "sent" ? undefined : d.lastError ?? d.reason ?? d.status, delivery: { id: d.id, status: d.status, responseStatus: d.responseStatus } });
  }

  const kind = String(body.kind ?? "") as ChannelKind;
  if (!KINDS.includes(kind)) return noStore({ error: "kind is slack, teams, webhook or email" }, 400);
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) return noStore({ error: "Give the channel a name (a Slack channel like #research-ops, or what the webhook is for)." }, 400);
  const id = randomUUID();
  const base: ChannelRec = { id, customerId: actor.customerId, kind, name: kind === "slack" ? `#${name.replace(/^#+/, "")}` : name, config: {}, sealed: null, keyId: null, hint: null, enabled: true, lastTestAt: null, lastStatus: null, createdBy: actor.sandbox ? null : actor.userId, createdAt: new Date().toISOString() };
  let signingSecret: string | undefined;
  if (kind === "email") {
    const to = (Array.isArray(body.to) ? body.to : String(body.to ?? "").split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (!to.length || to.length > 50 || to.some((x) => !EMAIL.test(x))) return noStore({ error: "An e-mail list needs 1–50 valid addresses." }, 400);
    base.config = { to: [...new Set(to)] };
  } else {
    const st = secretsStatus();
    if (!st.ready) return noStore({ error: `${st.reason} A webhook address is a secret and is never stored unencrypted.`, code: "secrets_not_configured" }, 503);
    const u = checkWebhookUrl(String(body.url ?? ""));
    if (!u.ok) return noStore({ error: u.message }, 400);
    if (kind === "slack" && !/^https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\//.test(u.url) && !actor.sandbox) return noStore({ error: "A Slack incoming-webhook address starts with https://hooks.slack.com/services/ — create one in Slack (Apps → Incoming Webhooks) for the channel." }, 400);
    if (kind === "webhook") signingSecret = `whsec_${randomBytes(24).toString("base64url")}`;
    const sealed = sealSecret(JSON.stringify({ url: u.url, ...(signingSecret ? { signingSecret } : {}) }), channelAad(base));
    base.sealed = sealed.sealed; base.keyId = sealed.keyId; base.hint = maskSecretUrl(u.url);
  }
  try { await store.insertChannel(base); }
  catch (e) { if ((e as { code?: string }).code === "duplicate") return noStore({ error: (e as Error).message }, 409); throw e; }
  if (!actor.sandbox) await audit({ action: "notify.channel_added", userId: actor.userId, customerId: actor.customerId, entity: "notify_channel", entityId: id, detail: { kind, name: base.name } }).catch(() => {});
  return noStore({ ok: true, channel: channelView(base), ...(signingSecret ? { signingSecret, note: "Copy the signing secret now — it is not shown again. Verify X-Rescript-Signature (t=…,v1=HMAC-SHA256 of “t.body”) with it." } : {}) });
}

export async function PATCH(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const store = notifyStore();
  const ch = body ? await store.getChannel(String(body.id ?? "")) : null;
  if (!ch || ch.customerId !== actor.customerId) return noStore({ error: "No such channel." }, 404);
  const patch: Partial<ChannelRec> = {};
  if (typeof body!.enabled === "boolean") patch.enabled = body!.enabled;
  if (typeof body!.name === "string" && body!.name.trim()) patch.name = body!.name.trim().slice(0, 80);
  if (ch.kind === "email" && body!.to !== undefined) {
    const to = (Array.isArray(body!.to) ? body!.to : String(body!.to).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (!to.length || to.some((x) => !EMAIL.test(x))) return noStore({ error: "An e-mail list needs valid addresses." }, 400);
    patch.config = { to };
  }
  if (ch.kind !== "email" && typeof body!.url === "string") {
    const u = checkWebhookUrl(body!.url);
    if (!u.ok) return noStore({ error: u.message }, 400);
    const prev = ch.sealed ? (() => { try { return notifyDeps(store).openChannel(ch); } catch { return null; } })() : null;
    const sealed = sealSecret(JSON.stringify({ url: u.url, ...(prev?.signingSecret ? { signingSecret: prev.signingSecret } : {}) }), channelAad(ch));
    patch.sealed = sealed.sealed; patch.keyId = sealed.keyId; patch.hint = maskSecretUrl(u.url);
  }
  await store.updateChannel(ch.id, patch);
  return noStore({ ok: true, channel: channelView({ ...ch, ...patch }) });
}

export async function DELETE(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const store = notifyStore();
  const ch = await store.getChannel(req.nextUrl.searchParams.get("id") ?? "");
  if (!ch || ch.customerId !== actor.customerId) return noStore({ error: "No such channel." }, 404);
  await store.deleteChannel(ch.id);
  if (!actor.sandbox) await audit({ action: "notify.channel_removed", userId: actor.userId, customerId: actor.customerId, entity: "notify_channel", entityId: ch.id, detail: { kind: ch.kind, name: ch.name } }).catch(() => {});
  return noStore({ ok: true });
}
