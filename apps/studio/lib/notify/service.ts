import { randomUUID } from "node:crypto";
import type { AlertChannelRef, AlertSettings } from "@rescript/schema";
import { AlertSettings as AlertSettingsSchema } from "@rescript/schema";
import {
  NOTIFY_EVENTS, normaliseNotifyInput, routeEvent, deliveryDecision, dedupeKeyOf, digestDueAt, retryDelayMs, retryableStatus, redactExcerpt,
  renderAlert, renderSlack, renderTeams, renderWebhook, renderEmail, renderDigest,
  type NotifyEvent, type NotifyEmitInput, type RoutedTarget,
} from "@rescript/engine";
import type { ChannelRec, DeliveryRec, EventRec, NotifyStore } from "./types.ts";

/**
 * THE NOTIFICATION SERVICE (2026-10-22, G3) — Studio server side, framework-free so it is tested without Next or a
 * database (`service.test.ts`). The routes build the dependencies (`server.ts`) and call:
 *
 *   emitNotifyEvent   an EVENT (distress, quota full, …): redacted, written to the outbox (idempotent), then routed by
 *                     the organisation's and the study's rules and delivered — immediately, or held for a digest
 *                     (hourly / daily, quiet hours, the hourly cap), or skipped as a duplicate
 *   sendNotification  a DIRECT message (a live-session invite, a reminder): one channel, one recipient, a template,
 *                     no rules — the API G2's live sessions use
 *   runDue            the scheduled pass (cron, and opportunistically on each event): retries whose backoff has
 *                     passed, digests that are due, outbox events nobody delivered (a crashed request)
 *   testChannel       the "Send test" button
 *
 * What reaches a channel is rendered by the engine (`notifyEvents.ts`): the study, the participant's pseudonymous
 * id, a REDACTED excerpt of at most 160 characters and a link — never full text or identity. Webhook URLs are
 * opened from their sealed blobs for the one request that needs them and never logged; the delivery log holds a
 * destination a screen may show ("#research-ops", an address, "user:<id>").
 */

export interface PostResult { status: number; text?: string }
export interface MailOutcome { status: "sent" | "not_configured" | "failed" | "duplicate" | "suppressed"; detail?: string }
export interface NotifyDeps {
  store: NotifyStore;
  now: () => number;
  /** POST a body to a user-named URL (the endpoint guard in production); throws on a network error or a refused address */
  post: (url: string, body: string, headers: Record<string, string>) => Promise<PostResult>;
  /** send one e-mail (lib/mail.ts in production) */
  mail: (m: { to: string; subject: string; text: string; html: string; dedupeKey: string; surveyId: string | null; customerId: string | null; kind: "alert" | "live_session_invite" | "live_session_reminder" }) => Promise<MailOutcome>;
  /** open a channel's sealed { url, signingSecret } (the envelope, INTEGRATIONS_SECRET_KEY) */
  openChannel: (c: ChannelRec) => { url: string; signingSecret?: string };
  /** sign a webhook body: `t=…,v1=…` */
  signWebhook: (secret: string, body: string, nowMs: number) => string;
  studioUrl: string | null;
  rand?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "[address]").slice(0, 300);

/* ------------------------------------------------------------ the event */

export type { NotifyEmitInput as EmitInput } from "@rescript/engine";
export { normaliseNotifyInput as normaliseEvent } from "@rescript/engine";
type EmitInput = NotifyEmitInput;

const asEvent = (e: EventRec): NotifyEvent => ({ id: e.id, type: e.type, surveyId: e.surveyId ?? "", customerId: e.customerId, studyTitle: e.payload.studyTitle ?? null, ref: e.ref, participant: e.payload.participant ?? null, excerpt: e.payload.excerpt ?? null, link: e.payload.link ?? null, detail: e.payload.detail ?? {}, at: e.payload.at, isTest: e.isTest });

export async function emitNotifyEvent(deps: NotifyDeps, input: EmitInput): Promise<{ ok: true; eventId: string; inserted: boolean; deliveries: DeliveryRec[] } | { ok: false; error: string }> {
  const n = normaliseNotifyInput(input, deps.now());
  if ("error" in n) return { ok: false, error: n.error };
  const project = await deps.store.project(input.surveyId);
  const { event, inserted } = await deps.store.insertEvent({ idempotencyKey: n.idempotencyKey, customerId: input.customerId ?? project?.customerId ?? null, surveyId: input.surveyId, type: n.type, ref: input.ref ?? null, payload: { ...n.payload, studyTitle: n.payload.studyTitle ?? project?.title ?? null }, source: input.source ?? "studio", isTest: !!input.isTest });
  if (!inserted) return { ok: true, eventId: event.id, inserted: false, deliveries: [] };
  const claimed = await deps.store.claimEvents(1, event.id);
  const deliveries = claimed.length ? await processEvent(deps, claimed[0]) : [];
  return { ok: true, eventId: event.id, inserted: true, deliveries };
}

/* ------------------------------------------------------------ routing → destinations */

interface Destination { kind: AlertChannelRef["kind"]; destination: string; channel?: ChannelRec; email?: string; userId?: string; missing?: string }

async function destinationsFor(deps: NotifyDeps, ref: AlertChannelRef, ctx: { customerId: string | null; surveyId: string | null; claimedBy?: string | null }): Promise<Destination[]> {
  const project = ctx.surveyId ? await deps.store.project(ctx.surveyId) : null;
  const me = ctx.claimedBy ?? project?.ownerId ?? null;
  const team = project?.team ?? [];
  if (ref.kind === "in_app") {
    const ids = ref.to === "@team" ? team.map((t) => t.userId) : ref.to === "@me" ? (me ? [me] : []) : [ref.to];
    if (!ids.length) return [{ kind: "in_app", destination: `in_app:${ref.to}`, missing: "nobody to notify on this project" }];
    return [...new Set(ids)].map((id) => ({ kind: "in_app" as const, destination: `user:${id}`, userId: id }));
  }
  if (ref.kind === "email") {
    let addresses: string[] = [];
    if (ref.to === "@team") addresses = team.map((t) => t.email).filter((x): x is string => !!x);
    else if (ref.to === "@me") { const e = me ? (team.find((t) => t.userId === me)?.email ?? await deps.store.userEmail(me)) : null; if (e) addresses = [e]; }
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref.to)) addresses = [ref.to];
    else {
      /* an organisation e-mail channel (a list) by name */
      const ch = ctx.customerId ? (await deps.store.listChannels(ctx.customerId)).find((c) => c.kind === "email" && c.enabled && (c.id === ref.to || c.name.toLowerCase() === ref.to.toLowerCase())) : undefined;
      if (ch) addresses = ch.config.to ?? [];
      else return [{ kind: "email", destination: `email:${ref.to}`, missing: `no e-mail list named “${ref.to}” in Settings → Alerts` }];
    }
    if (!addresses.length) return [{ kind: "email", destination: `email:${ref.to}`, missing: "no e-mail address for this recipient" }];
    return [...new Set(addresses.map((a) => a.toLowerCase()))].map((a) => ({ kind: "email" as const, destination: a, email: a }));
  }
  /* slack / teams / webhook: an organisation channel by name or id */
  const want = ref.to.replace(/^#/, "").toLowerCase();
  const ch = ctx.customerId ? (await deps.store.listChannels(ctx.customerId)).find((c) => c.kind === ref.kind && (c.id === ref.to || c.name.replace(/^#/, "").toLowerCase() === want)) : undefined;
  const label = `${ref.kind}:${ref.kind === "slack" ? `#${want}` : ref.to}`;
  if (!ch) return [{ kind: ref.kind, destination: label, missing: `no ${ref.kind === "slack" ? "Slack" : ref.kind === "teams" ? "Teams" : "webhook"} channel named “${ref.to}” is connected (Settings → Alerts)` }];
  if (!ch.enabled) return [{ kind: ref.kind, destination: label, channel: ch, missing: "the channel is switched off" }];
  return [{ kind: ref.kind, destination: label, channel: ch }];
}

/** the settings that govern dedupe / cap / quiet hours for an event: the study's, else the organisation's */
const governing = (study: AlertSettings | null, org: AlertSettings | null): AlertSettings => AlertSettingsSchema.parse(study ?? org ?? {});

export async function processEvent(deps: NotifyDeps, ev: EventRec): Promise<DeliveryRec[]> {
  const out: DeliveryRec[] = [];
  try {
    const project = ev.surveyId ? await deps.store.project(ev.surveyId) : null;
    const customerId = ev.customerId ?? project?.customerId ?? null;
    const org = customerId ? await deps.store.orgSettings(customerId) : null;
    const study = project?.alerts ?? null;
    const settings = governing(study, org);
    const event = asEvent(ev);
    const targets = routeEvent(event, [{ scope: "org", settings: org }, { scope: "study", settings: study }]);
    const claimedBy = (rid: string) => [...(study?.rules ?? []), ...(org?.rules ?? [])].find((r) => r.id === rid)?.claimedBy ?? null;
    for (const t of targets) {
      for (const d of await destinationsFor(deps, t.ref, { customerId, surveyId: ev.surveyId, claimedBy: claimedBy(t.ruleId) })) {
        const r = await deliverOne(deps, ev, event, t, d, settings, customerId);
        if (r) out.push(r);
      }
    }
    await deps.store.finishEvent(ev.id, "processed");
  } catch (e) {
    console.error("[rescript:notify] event not processed", JSON.stringify({ event: ev.id.slice(0, 8), type: ev.type, error: errText(e) }));
    await deps.store.finishEvent(ev.id, "failed").catch(() => {});
  }
  return out;
}

async function deliverOne(deps: NotifyDeps, ev: EventRec, event: NotifyEvent, t: RoutedTarget, d: Destination, settings: AlertSettings, customerId: string | null): Promise<DeliveryRec | null> {
  const now = deps.now();
  const dedupeKey = dedupeKeyOf(event);
  const base = { eventId: ev.id, customerId, surveyId: ev.surveyId, eventType: ev.type, channelKind: d.kind, channelId: d.channel?.id ?? null, destination: d.destination, dedupeKey, idempotencyKey: `${ev.idempotencyKey}|${d.destination}`.slice(0, 400), attempts: 0, responseStatus: null, lastError: null, isTest: ev.isTest, sentAt: null };
  if (d.missing) {
    const { delivery } = await deps.store.insertDelivery({ ...base, status: "not_configured", reason: d.missing, digest: null, nextAttemptAt: null });
    return delivery;
  }
  const history = {
    lastSameAt: settings.dedupeMinutes > 0 ? await deps.store.lastSame(dedupeKey, d.destination, iso(now - settings.dedupeMinutes * 60_000), ev.id) : null,
    sentLastHour: await deps.store.countSent(d.destination, iso(now - 3_600_000)),
  };
  const decision = deliveryDecision(event, t, history, settings);
  if (decision.action === "skip") {
    const { delivery } = await deps.store.insertDelivery({ ...base, status: "skipped", reason: "the same alert was sent within the dedupe window", digest: null, nextAttemptAt: null });
    return delivery;
  }
  if (decision.action === "digest") {
    const due = digestDueAt(decision.reason, t.digest, new Date(now), settings);
    const digest = t.digest === "daily" ? "daily" : "hourly";
    const reason = decision.reason === "quiet_hours" ? "held for quiet hours" : decision.reason === "rate_limited" ? `over ${settings.maxPerHour} messages this hour: in the next digest` : `${digest} digest`;
    const { delivery } = await deps.store.insertDelivery({ ...base, status: "digest_pending", reason, digest, nextAttemptAt: iso(due.getTime()) });
    return delivery;
  }
  const { delivery, inserted } = await deps.store.insertDelivery({ ...base, status: "queued", reason: null, digest: null, nextAttemptAt: null });
  if (!inserted) return null;
  return attempt(deps, delivery, [event], d);
}

/* ------------------------------------------------------------ sending */

type Rendered = { slack: Record<string, unknown>; teams: Record<string, unknown>; webhook: Record<string, unknown>; email: { subject: string; text: string; html: string }; inApp: { title: string; text: string; link: string | null; severity: string } };

function renderAll(events: NotifyEvent[], studioUrl: string | null): Rendered {
  const ctx = { studioUrl };
  if (events.length === 1) {
    const e = events[0];
    const r = renderAlert(e, ctx);
    return { slack: renderSlack(e, ctx), teams: renderTeams(e, ctx), webhook: renderWebhook(e, ctx), email: renderEmail(e, ctx), inApp: { title: r.title, text: `${r.text}${r.excerpt ? ` “${r.excerpt}”` : ""}`, link: renderAlert(e, {}).link, severity: r.severity } };
  }
  const dg = renderDigest(events, ctx);
  const text = dg.text.slice(0, 2900);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    slack: { text: dg.title.slice(0, 3000), blocks: [{ type: "header", text: { type: "plain_text", text: dg.title.slice(0, 150), emoji: false } }, { type: "section", text: { type: "plain_text", text, emoji: false } }] },
    teams: { type: "message", summary: dg.title, attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text: dg.title, weight: "Bolder", wrap: true }, { type: "TextBlock", text, wrap: true }] } }] },
    webhook: { type: "digest", count: events.length, events: events.map((e) => renderWebhook(e, ctx)) },
    email: { subject: `[Rescript] ${dg.title}`.slice(0, 200), text: `${dg.title}\n\n${dg.text}`, html: `<div style="font:14px/1.5 system-ui,sans-serif"><h2 style="font-size:16px">${esc(dg.title)}</h2><pre style="white-space:pre-wrap;font:inherit">${esc(dg.text)}</pre></div>` },
    inApp: { title: dg.title.slice(0, 200), text: dg.lines.slice(0, 5).join(" "), link: null, severity: "normal" },
  };
}

/** one send of one delivery row (possibly a digest of several events); records the outcome and schedules a retry */
async function attempt(deps: NotifyDeps, delivery: DeliveryRec, events: NotifyEvent[], d?: Destination, opts: { markRows?: string[] } = {}): Promise<DeliveryRec> {
  const now = deps.now();
  const attempts = delivery.attempts + 1;
  const done = async (patch: Partial<DeliveryRec>): Promise<DeliveryRec> => {
    const full = { attempts, ...patch };
    await deps.store.updateDelivery(delivery.id, full);
    for (const id of opts.markRows ?? []) if (id !== delivery.id) await deps.store.updateDelivery(id, { status: patch.status === "sent" ? "digested" : delivery.status, ...(patch.status === "sent" ? { sentAt: patch.sentAt } : {}) });
    return { ...delivery, ...full };
  };
  const r = renderAll(events, deps.studioUrl);
  try {
    if (delivery.channelKind === "in_app") {
      const userId = d?.userId ?? delivery.destination.replace(/^user:/, "");
      await deps.store.insertInApp([{ userId, surveyId: delivery.surveyId, eventId: delivery.eventId, title: r.inApp.title, text: r.inApp.text, link: r.inApp.link, severity: r.inApp.severity }]);
      return done({ status: "sent", sentAt: iso(now), reason: null });
    }
    if (delivery.channelKind === "email") {
      const m = await deps.mail({ to: d?.email ?? delivery.destination, ...r.email, dedupeKey: `notify:${delivery.idempotencyKey}`.slice(0, 300), surveyId: delivery.surveyId, customerId: delivery.customerId, kind: "alert" });
      if (m.status === "sent" || m.status === "duplicate") return done({ status: "sent", sentAt: iso(now), reason: m.status === "duplicate" ? "already sent" : null });
      if (m.status === "not_configured") return done({ status: "not_configured", reason: "e-mail is not configured on this installation (RESEND_API_KEY, MAIL_FROM)" });
      if (m.status === "suppressed") return done({ status: "failed", reason: "suppressed: not production and MAIL_DEV_REDIRECT is not set, or not a valid address" });
      throw Object.assign(new Error(m.detail ?? "the mail provider refused it"), { retryable: true });
    }
    const ch = d?.channel ?? (delivery.channelId ? await deps.store.getChannel(delivery.channelId) : null);
    if (!ch) return done({ status: "not_configured", reason: "the channel was removed" });
    const secret = deps.openChannel(ch);
    let body: string, headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Rescript-Alerts/1.0" };
    if (delivery.channelKind === "slack") body = JSON.stringify(r.slack);
    else if (delivery.channelKind === "teams") body = JSON.stringify(r.teams);
    else {
      body = JSON.stringify({ ...r.webhook, delivery: delivery.id });
      headers = { ...headers, "x-rescript-event": events.length === 1 ? events[0].type : "digest", "x-rescript-delivery": delivery.id, "idempotency-key": delivery.idempotencyKey.slice(0, 200), ...(secret.signingSecret ? { "x-rescript-signature": deps.signWebhook(secret.signingSecret, body, now) } : {}) };
    }
    const res = await deps.post(secret.url, body, headers);
    if (res.status >= 200 && res.status < 300) return done({ status: "sent", sentAt: iso(now), responseStatus: res.status, reason: null, lastError: null });
    if (!retryableStatus(res.status)) return done({ status: "failed", responseStatus: res.status, lastError: `the endpoint answered ${res.status}${res.text ? `: ${res.text.slice(0, 120)}` : ""}`, nextAttemptAt: null });
    throw Object.assign(new Error(`the endpoint answered ${res.status}`), { retryable: true, status: res.status });
  } catch (e) {
    const refused = (e as { name?: string }).name === "EndpointRefused";
    const delay = refused ? null : retryDelayMs(attempts, deps.rand);
    return done({ status: delay === null ? "failed" : "retrying", lastError: errText(e), responseStatus: (e as { status?: number }).status ?? null, nextAttemptAt: delay === null ? null : iso(now + delay) });
  }
}

/* ------------------------------------------------------------ the scheduled pass */

/** retries due, digests due, and outbox events no request delivered */
export async function runDue(deps: NotifyDeps, opts: { limit?: number } = {}): Promise<{ retried: number; digests: number; events: number }> {
  const limit = opts.limit ?? 100;
  const nowIso = iso(deps.now());
  const due = await deps.store.dueDeliveries(nowIso, limit);
  let retried = 0, digests = 0;
  const groups = new Map<string, DeliveryRec[]>();
  for (const d of due) {
    if (d.status === "retrying") {
      const evs = d.eventId ? (await deps.store.eventsByIds([d.eventId])).map(asEvent) : [];
      if (evs.length) { await attempt(deps, d, evs); retried++; } else await deps.store.updateDelivery(d.id, { status: "failed", lastError: "its event is gone" });
      continue;
    }
    const key = `${d.channelKind}|${d.channelId ?? ""}|${d.destination}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const rows of groups.values()) {
    const evs = (await deps.store.eventsByIds(rows.map((r) => r.eventId).filter((x): x is string => !!x))).map(asEvent).sort((a, b) => a.at.localeCompare(b.at));
    if (!evs.length) { for (const r of rows) await deps.store.updateDelivery(r.id, { status: "failed", lastError: "its event is gone" }); continue; }
    const first = rows[0];
    const d: Destination = { kind: first.channelKind, destination: first.destination, ...(first.channelKind === "email" ? { email: first.destination } : {}), ...(first.channelKind === "in_app" ? { userId: first.destination.replace(/^user:/, "") } : {}) };
    const sent = await attempt(deps, { ...first, attempts: first.attempts }, evs, d, { markRows: rows.map((r) => r.id) });
    if (sent.status === "sent") { await deps.store.updateDelivery(first.id, { status: "digested", reason: `sent in a digest of ${evs.length}` }); digests++; }
    else if (sent.status === "retrying") for (const r of rows) await deps.store.updateDelivery(r.id, { status: "digest_pending", nextAttemptAt: sent.nextAttemptAt });
  }
  let events = 0;
  for (const ev of await deps.store.claimEvents(20)) { await processEvent(deps, ev); events++; }
  return { retried, digests, events };
}

/* ------------------------------------------------------------ direct messages (G2: live-session invites) */

export type NotificationTemplate = "live_session_invite" | "live_session_reminder" | "generic";
export interface SendNotificationInput {
  channel: "email" | "in_app" | "slack" | "teams" | "webhook";
  /** an e-mail address, a user id (in_app), or a channel id / name (slack / teams / webhook) */
  to: string;
  template: NotificationTemplate;
  data: Record<string, unknown>;
  surveyId?: string | null;
  customerId?: string | null;
  /** one message per key, ever */
  dedupeKey?: string;
}

const s = (v: unknown, max = 300) => (v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max));
/** the words of a direct message — plain values, escaped where HTML; a join URL must be https (or a Studio path) */
export function renderTemplate(t: NotificationTemplate, data: Record<string, unknown>): { subject: string; text: string; html: string; title: string } {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const url = /^https:\/\//.test(s(data.joinUrl ?? data.url, 1000)) ? s(data.joinUrl ?? data.url, 1000) : "";
  const title = s(data.title, 160) || "a research session";
  const sender = s(data.senderName, 80) || "The research team";
  const when = s(data.startsAt, 80);
  const mins = Number(data.minutes) > 0 ? `${Math.round(Number(data.minutes))} minutes` : "";
  const note = s(data.note, 600);
  if (t === "generic") {
    const subject = s(data.subject, 160) || title;
    const text = [s(data.text, 4000), url ? `\n${url}` : ""].join("");
    return { subject, title: subject, text, html: `<div style="font:14px/1.5 system-ui,sans-serif"><p>${esc(s(data.text, 4000))}</p>${url ? `<p><a href="${esc(url)}">${esc(url)}</a></p>` : ""}</div>` };
  }
  const reminder = t === "live_session_reminder";
  const subject = `${reminder ? "Reminder: " : ""}${title}${when ? ` — ${when}` : ""}`;
  const lines = [reminder ? `This is a reminder of your session: ${title}.` : `You are invited to take part in ${title}.`, when ? `When: ${when}${mins ? ` (${mins})` : ""}` : mins ? `It takes about ${mins}.` : "", url ? `Join here: ${url}` : "", "The link is personal — please do not share it.", note, `— ${sender}`].filter(Boolean);
  return { subject, title: subject, text: lines.join("\n"), html: `<div style="font:14px/1.5 system-ui,sans-serif">${lines.map((l) => (l.startsWith("Join here: ") && url ? `<p><a href="${esc(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Join the session</a></p>` : `<p>${esc(l)}</p>`)).join("")}</div>` };
}

export async function sendNotification(deps: NotifyDeps, input: SendNotificationInput): Promise<{ status: DeliveryRec["status"]; reason?: string | null; deliveryId: string }> {
  const r = renderTemplate(input.template, input.data ?? {});
  const now = deps.now();
  const idem = `direct:${input.dedupeKey ?? randomUUID()}|${input.channel}:${input.to}`.slice(0, 400);
  const destination = input.channel === "email" ? input.to.toLowerCase() : input.channel === "in_app" ? `user:${input.to}` : `${input.channel}:${input.to}`;
  const base = { eventId: null, customerId: input.customerId ?? null, surveyId: input.surveyId ?? null, eventType: `direct.${input.template}`, channelKind: input.channel, channelId: null, destination, dedupeKey: input.dedupeKey ?? null, idempotencyKey: idem, attempts: 0, responseStatus: null, lastError: null, isTest: false, sentAt: null, digest: null, nextAttemptAt: null, reason: null };
  const { delivery, inserted } = await deps.store.insertDelivery({ ...base, status: "queued" });
  if (!inserted) return { status: delivery.status === "queued" ? "skipped" : delivery.status, reason: "already sent with this key", deliveryId: delivery.id };
  const finish = async (patch: Partial<DeliveryRec>) => { await deps.store.updateDelivery(delivery.id, { attempts: 1, ...patch }); return { status: patch.status!, reason: patch.reason ?? patch.lastError ?? null, deliveryId: delivery.id }; };
  try {
    if (input.channel === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return finish({ status: "failed", reason: "not an e-mail address" });
      const m = await deps.mail({ to: input.to, subject: r.subject, text: r.text, html: r.html, dedupeKey: `notify:${idem}`.slice(0, 300), surveyId: base.surveyId, customerId: base.customerId, kind: input.template === "live_session_reminder" ? "live_session_reminder" : input.template === "live_session_invite" ? "live_session_invite" : "alert" });
      if (m.status === "sent" || m.status === "duplicate") return finish({ status: "sent", sentAt: iso(now) });
      if (m.status === "not_configured") return finish({ status: "not_configured", reason: "e-mail is not configured on this installation (RESEND_API_KEY, MAIL_FROM)" });
      return finish({ status: "failed", lastError: m.detail ?? m.status });
    }
    if (input.channel === "in_app") { await deps.store.insertInApp([{ userId: input.to, surveyId: base.surveyId, eventId: null, title: r.title, text: r.text.split("\n")[0], link: null, severity: "normal" }]); return finish({ status: "sent", sentAt: iso(now) }); }
    const ch = input.customerId ? (await deps.store.listChannels(input.customerId)).find((c) => c.kind === input.channel && (c.id === input.to || c.name.replace(/^#/, "").toLowerCase() === input.to.replace(/^#/, "").toLowerCase())) : await deps.store.getChannel(input.to);
    if (!ch) return finish({ status: "not_configured", reason: `no ${input.channel} channel “${input.to}”` });
    const secret = deps.openChannel(ch);
    const body = input.channel === "slack" ? JSON.stringify({ text: r.text, blocks: [{ type: "section", text: { type: "plain_text", text: r.text.slice(0, 2900), emoji: false } }] })
      : input.channel === "teams" ? JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text: r.text, wrap: true }] } }] })
      : JSON.stringify({ type: `direct.${input.template}`, subject: r.subject, text: r.text, delivery: delivery.id });
    const res = await deps.post(secret.url, body, { "content-type": "application/json", "user-agent": "Rescript-Alerts/1.0", ...(input.channel === "webhook" && secret.signingSecret ? { "x-rescript-signature": deps.signWebhook(secret.signingSecret, body, now), "idempotency-key": idem.slice(0, 200) } : {}) });
    return res.status >= 200 && res.status < 300 ? finish({ status: "sent", sentAt: iso(now), responseStatus: res.status }) : finish({ status: "failed", responseStatus: res.status, lastError: `the endpoint answered ${res.status}` });
  } catch (e) { return finish({ status: "failed", lastError: errText(e) }); }
}

/** a Studio path to a project's tab (the sandbox has its own page) */
export function studioLink(surveyId: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return surveyId === "sandbox" ? `/sandbox?mode=studio${q ? `&${q}` : ""}` : `/studio/${encodeURIComponent(surveyId)}${q ? `?${q}` : ""}`;
}

/* ------------------------------------------------------------ the test button */

export async function testChannel(deps: NotifyDeps, ch: ChannelRec, opts: { userId?: string | null; surveyId?: string | null } = {}): Promise<DeliveryRec> {
  const now = deps.now();
  const event: NotifyEvent = { id: `test-${now}`, type: "notify.test", surveyId: opts.surveyId ?? "", studyTitle: "Test alert from Rescript", participant: "P0", excerpt: "This is a test — no participant said this.", link: opts.surveyId ? studioLink(opts.surveyId, { tab: "qualitative", qual: "alerts" }) : null, detail: { channel: ch.name }, at: iso(now), isTest: true };
  const destination = ch.kind === "email" ? (ch.config.to ?? [])[0] ?? `email:${ch.name}` : `${ch.kind}:${ch.kind === "slack" ? `#${ch.name.replace(/^#/, "")}` : ch.name}`;
  const { delivery } = await deps.store.insertDelivery({ eventId: null, customerId: ch.customerId, surveyId: null, eventType: "notify.test", channelKind: ch.kind, channelId: ch.id, destination, dedupeKey: null, idempotencyKey: `test:${ch.id}:${now}:${randomUUID().slice(0, 8)}`, status: "queued", reason: null, digest: null, attempts: 0, nextAttemptAt: null, responseStatus: null, lastError: null, isTest: true, sentAt: null });
  const d: Destination = { kind: ch.kind, destination, channel: ch, ...(ch.kind === "email" ? { email: (ch.config.to ?? [])[0] } : {}) };
  const out = await attempt(deps, delivery, [event], d);
  /* a test is not retried: the person pressing the button wants the answer now */
  if (out.status === "retrying") { await deps.store.updateDelivery(out.id, { status: "failed", nextAttemptAt: null }); out.status = "failed"; }
  await deps.store.updateChannel(ch.id, { lastTestAt: iso(now), lastStatus: out.status === "sent" ? "ok" : `${out.status}${out.lastError ? `: ${out.lastError}` : out.reason ? `: ${out.reason}` : ""}`.slice(0, 300) });
  return out;
}

export { NOTIFY_EVENTS };
