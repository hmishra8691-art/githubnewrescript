import type { AlertChannelKind, AlertChannelRef, AlertQuietHours, AlertRule, AlertSettings } from "@rescript/schema";
import { AlertSettings as AlertSettingsSchema } from "@rescript/schema";
import { maskContactDetails } from "./aiInterviewSafety.js";

/**
 * ALERTS — THE PURE HALF (2026-10-22, engineer G3). No I/O: the Studio's notification service
 * (apps/studio/lib/notify) stores, sends, retries and logs; this decides WHAT and HOW IT READS.
 *
 *   NOTIFY_EVENTS     the catalogue: type, words, severity, digest by default
 *   routeEvent        an event + the organisation's and the study's settings → the destinations, each with
 *                     immediate / hourly / daily delivery (no rule anywhere: high and critical events go to the
 *                     project team's in-app bell, so an unconfigured study is never silent about distress)
 *   deliveryDecision  dedupe (the same event about the same thing within N minutes is one message), the hourly
 *                     cap per destination (the rest waits for the digest), quiet hours (held, except critical)
 *   redactExcerpt     what a participant said, made safe for a channel: e-mails and phone numbers masked (the
 *                     interview's own masking), links, long numbers and "my name is …" removed, one line, ≤ 160
 *                     characters — NO channel ever receives full participant text or identity
 *   render*           the message per channel: Slack Block Kit (participant text only as plain_text, so no
 *                     <!channel> or link markup can ride in it), a Teams Adaptive Card, the generic webhook's
 *                     JSON, e-mail (text + escaped HTML), the in-app row
 */

export type NotifySeverity = "critical" | "high" | "normal" | "low";

export const NOTIFY_EVENTS = {
  "ai_interview.distress": { label: "Distress flagged in an AI interview", severity: "critical", digest: false, category: "ai_interview" },
  "ai_interview.abuse": { label: "Abuse in an AI interview", severity: "high", digest: false, category: "ai_interview" },
  "ai_interview.injection": { label: "Prompt-injection attempt flagged", severity: "high", digest: false, category: "ai_interview" },
  "ai_interview.completed": { label: "AI interview completed", severity: "low", digest: true, category: "ai_interview" },
  "ai_interview.quota_full": { label: "AI interview quota full", severity: "normal", digest: false, category: "ai_interview" },
  "study.target_reached": { label: "Study target reached", severity: "normal", digest: false, category: "study" },
  "study.cost_cap": { label: "Study AI budget reached", severity: "high", digest: false, category: "study" },
  "ai.provider_fallback": { label: "AI provider failed — fallback engaged", severity: "normal", digest: false, category: "ai" },
  "group_session.flag": { label: "Group session flag", severity: "high", digest: false, category: "group_session" },
  "live_session.no_show": { label: "Live session no-show", severity: "normal", digest: false, category: "live_session" },
  "survey.quota_full": { label: "Survey quota full", severity: "normal", digest: false, category: "survey" },
  "survey.milestone": { label: "Fieldwork milestone", severity: "low", digest: false, category: "survey" },
  "panel.target_reached": { label: "Panel completes target reached", severity: "normal", digest: false, category: "panel" },
  "panel.duplicate_entry": { label: "Duplicate panel entry refused", severity: "low", digest: true, category: "panel" },
  "notify.test": { label: "Test alert", severity: "normal", digest: false, category: "notify" },
} as const satisfies Record<string, { label: string; severity: NotifySeverity; digest: boolean; category: string }>;
export type NotifyEventType = keyof typeof NOTIFY_EVENTS;
export const NOTIFY_EVENT_TYPES = Object.keys(NOTIFY_EVENTS) as NotifyEventType[];
export const isNotifyEventType = (t: unknown): t is NotifyEventType => typeof t === "string" && t in NOTIFY_EVENTS;

export interface NotifyEvent {
  /** idempotency: the same id is delivered once per destination */
  id: string;
  type: NotifyEventType;
  surveyId: string;
  customerId?: string | null;
  studyTitle?: string | null;
  /** what the event is about (an interview id, a group session, a quota) — the dedupe key's subject */
  ref?: string | null;
  /** a PSEUDONYMOUS participant id (P3, a panel id) — never a name or e-mail */
  participant?: string | null;
  /** raw participant words — always redacted before rendering */
  excerpt?: string | null;
  /** a Studio path ("/studio/…") or an absolute https link */
  link?: string | null;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
  isTest?: boolean;
}

export const severityOf = (t: NotifyEventType): NotifySeverity => NOTIFY_EVENTS[t]?.severity ?? "normal";
const SEV_RANK: Record<NotifySeverity, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/* ------------------------------------------------------------ redaction */

/**
 * A participant's words, safe for an alert. Contact details are masked by the interview's own rules; links,
 * handles, long digit runs (ids, card or account numbers) and a self-introduced name are removed; markup
 * characters are dropped; one line; at most `max` characters, cut at a word.
 */
export function redactExcerpt(text: string | null | undefined, max = 160): string {
  let t = maskContactDetails(String(text ?? "")).text;
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/(^|\s)@[A-Za-z0-9_.]{2,}/g, "$1[handle]")
    .replace(/\d[\d\s-]{5,}\d/g, "[number]")
    .replace(/(\b[Mm]y name is|\b[Mm]y name's|\bI am called|\bI'm called|\b[Cc]all me|मेरा नाम)\s+[^\s,.!?]+(?:\s+[A-Z][^\s,.!?]*)?/g, "$1 [name]")
    .replace(/[<>`*~|{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) { const cut = t.slice(0, max - 1); t = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6)))}…`; }
  return t;
}

/* ------------------------------------------------------------ routing */

export interface RoutedTarget { ref: AlertChannelRef; digest: "immediate" | "hourly" | "daily"; ruleId: string; scope: "org" | "study" | "default" }

const ruleMatches = (r: AlertRule, type: NotifyEventType) => r.enabled && r.events.some((e) => e === "*" || e === type || (e.endsWith(".*") && type.startsWith(e.slice(0, -1))) || e === NOTIFY_EVENTS[type].category);

/** the default when NO rule anywhere names this event: the team's bell for anything that matters */
export const DEFAULT_ROUTE: AlertRule = { id: "default", events: ["*"], channels: [{ kind: "in_app", to: "@team" }], digest: "immediate", enabled: true };

/**
 * The destinations for an event. Study rules and organisation rules both apply (a study cannot switch off the
 * organisation's distress alert); the same destination named twice is one, with the more immediate delivery.
 * `notify.test` never routes (the test button names its channel).
 */
export function routeEvent(event: Pick<NotifyEvent, "type">, settings: { scope: "org" | "study"; settings: AlertSettings | null | undefined }[]): RoutedTarget[] {
  if (event.type === "notify.test") return [];
  const meta: { severity: NotifySeverity; digest: boolean } = NOTIFY_EVENTS[event.type];
  const out = new Map<string, RoutedTarget>();
  let any = false;
  for (const s of settings) {
    if (!s.settings) continue;
    for (const r of s.settings.rules) {
      if (!ruleMatches(r, event.type)) continue;
      any = true;
      for (const ref of r.channels) {
        const key = `${ref.kind}:${ref.to.toLowerCase()}`;
        const digest = meta.severity === "critical" ? "immediate" : r.digest;
        const prev = out.get(key);
        if (!prev || rankDigest(digest) < rankDigest(prev.digest)) out.set(key, { ref, digest, ruleId: r.id, scope: s.scope });
      }
    }
  }
  if (!any && SEV_RANK[meta.severity] >= SEV_RANK.normal) out.set("in_app:@team", { ref: DEFAULT_ROUTE.channels[0], digest: meta.digest ? "hourly" : "immediate", ruleId: "default", scope: "default" });
  if (meta.digest) for (const [k, t] of out) if (t.digest === "immediate" && meta.severity !== "critical") out.set(k, { ...t, digest: "hourly" });
  return [...out.values()];
}
const rankDigest = (d: RoutedTarget["digest"]) => (d === "immediate" ? 0 : d === "hourly" ? 1 : 2);

/* ------------------------------------------------------------ quiet hours, dedupe, rate limit */

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h % 24) * 60 + (m % 60); };
/** minutes since local midnight in a time zone (UTC when the zone is unknown) */
export function localMinutes(at: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
      const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0"), m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
      return (h % 24) * 60 + m;
    } catch { /* unknown zone: UTC */ }
  }
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}
export function inQuietHours(q: AlertQuietHours | undefined | null, at: Date): boolean {
  if (!q) return false;
  const now = localMinutes(at, q.timeZone), s = minutesOf(q.start), e = minutesOf(q.end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export interface DeliveryHistory {
  /** when the same dedupe key was last delivered (or queued) to this destination, if ever */
  lastSameAt?: string | null;
  /** immediate messages to this destination in the last hour */
  sentLastHour: number;
}
export type DeliveryDecision = { action: "send" } | { action: "skip"; reason: "duplicate" } | { action: "digest"; reason: "rate_limited" | "quiet_hours" | "digest" };

export const dedupeKeyOf = (e: Pick<NotifyEvent, "type" | "surveyId" | "ref">) => `${e.type}:${e.surveyId}:${e.ref ?? ""}`;

export function deliveryDecision(event: Pick<NotifyEvent, "type" | "at">, target: Pick<RoutedTarget, "digest">, history: DeliveryHistory, settings: Pick<AlertSettings, "dedupeMinutes" | "maxPerHour" | "quietHours"> | null | undefined): DeliveryDecision {
  const s = AlertSettingsSchema.parse(settings ?? {});
  const at = new Date(event.at);
  const critical = severityOf(event.type) === "critical";
  if (history.lastSameAt && s.dedupeMinutes > 0 && at.getTime() - new Date(history.lastSameAt).getTime() < s.dedupeMinutes * 60_000) return { action: "skip", reason: "duplicate" };
  if (target.digest !== "immediate") return { action: "digest", reason: "digest" };
  if (inQuietHours(s.quietHours, at) && !(critical && s.quietHours?.bypassCritical !== false)) return { action: "digest", reason: "quiet_hours" };
  if (!critical && history.sentLastHour >= s.maxPerHour) return { action: "digest", reason: "rate_limited" };
  return { action: "send" };
}

/**
 * When a held delivery goes out: an hourly digest at the top of the next hour; a daily one at 08:00 in the
 * quiet-hours time zone (UTC without one); a quiet-hours hold when the quiet hours end; a rate-limited one with
 * the next hourly digest.
 */
export function digestDueAt(reason: "digest" | "rate_limited" | "quiet_hours", digest: "immediate" | "hourly" | "daily", now: Date, settings: Pick<AlertSettings, "quietHours"> | null | undefined): Date {
  const q = settings?.quietHours;
  const local = localMinutes(now, q?.timeZone);
  const plus = (min: number) => new Date(Math.floor(now.getTime() / 60_000) * 60_000 + min * 60_000);
  if (reason === "quiet_hours" && q) return plus(((minutesOf(q.end) - local) + 1440) % 1440 || 1440);
  if (digest === "daily") return plus(((8 * 60 - local) + 1440) % 1440 || 1440);
  return plus(60 - (local % 60));
}

/** retry with exponential backoff and jitter: attempt 1 → ~30 s, 2 → ~2 min, 3 → ~8 min, 4 → ~30 min; null = give up */
export function retryDelayMs(attempt: number, rand: () => number = Math.random): number | null {
  if (attempt >= 5) return null;
  const base = 30_000 * Math.pow(4, Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * rand()));
}
/** should this HTTP status be retried? (timeouts / network errors are, too) */
export const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

/* ------------------------------------------------------------ rendering */

export interface RenderContext {
  /** absolute base for Studio links ("https://studio.example.com"); without it links stay relative (in-app only) */
  studioUrl?: string | null;
}
export interface RenderedAlert {
  title: string;
  severity: NotifySeverity;
  /** one or two plain lines */
  text: string;
  excerpt: string | null;
  link: string | null;
}

const absolute = (link: string | null | undefined, base: string | null | undefined): string | null => {
  if (!link) return null;
  if (/^https:\/\//i.test(link)) return link;
  if (!link.startsWith("/")) return null;
  return base ? `${base.replace(/\/+$/, "")}${link}` : link;
};
const cleanLine = (s: string | null | undefined, max = 120) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function renderAlert(e: NotifyEvent, ctx: RenderContext = {}): RenderedAlert {
  const meta = NOTIFY_EVENTS[e.type];
  const study = cleanLine(e.studyTitle, 100) || "a study";
  const who = e.participant ? cleanLine(e.participant, 40) : null;
  const facts = Object.entries(e.detail ?? {}).filter(([, v]) => v !== null && v !== "").slice(0, 6).map(([k, v]) => `${k.replace(/_/g, " ")}: ${cleanLine(String(v), 60)}`);
  const text = [`${meta.label}${e.isTest ? " (test)" : ""} — ${study}${who ? ` · participant ${who}` : ""}.`, facts.length ? facts.join(" · ") : ""].filter(Boolean).join(" ");
  return { title: `${meta.severity === "critical" ? "URGENT: " : ""}${meta.label}`, severity: meta.severity, text, excerpt: e.excerpt ? redactExcerpt(e.excerpt) || null : null, link: absolute(e.link, ctx.studioUrl) };
}

/** Slack incoming webhook body (Block Kit) — participant text only as plain_text */
export function renderSlack(e: NotifyEvent, ctx: RenderContext = {}): Record<string, unknown> {
  const r = renderAlert(e, ctx);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: r.title.slice(0, 150), emoji: false } },
    { type: "section", text: { type: "plain_text", text: r.text.slice(0, 2900), emoji: false } },
  ];
  if (r.excerpt) blocks.push({ type: "context", elements: [{ type: "plain_text", text: `“${r.excerpt}” (redacted)`, emoji: false }] });
  if (r.link && /^https?:\/\//.test(r.link)) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: e.type.startsWith("ai_interview.") ? "Open the live view" : "Open in Rescript" }, url: r.link, ...(r.severity === "critical" ? { style: "danger" } : {}) }] });
  return { text: `${r.title}: ${r.text}`.slice(0, 3000), blocks };
}

/** Microsoft Teams incoming webhook / Workflows body — an Adaptive Card */
export function renderTeams(e: NotifyEvent, ctx: RenderContext = {}): Record<string, unknown> {
  const r = renderAlert(e, ctx);
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: r.title, weight: "Bolder", size: "Medium", wrap: true, ...(r.severity === "critical" ? { color: "Attention" } : {}) },
    { type: "TextBlock", text: r.text, wrap: true },
  ];
  if (r.excerpt) body.push({ type: "TextBlock", text: `“${r.excerpt}” (redacted)`, wrap: true, isSubtle: true });
  const card: Record<string, unknown> = { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body, ...(r.link && /^https?:\/\//.test(r.link) ? { actions: [{ type: "Action.OpenUrl", title: "Open in Rescript", url: r.link }] } : {}) };
  return { type: "message", summary: r.title, attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] };
}

/** the generic webhook's JSON (signed by the sender) */
export function renderWebhook(e: NotifyEvent, ctx: RenderContext = {}): Record<string, unknown> {
  const r = renderAlert(e, ctx);
  return {
    id: e.id, type: e.type, severity: r.severity, occurredAt: e.at, test: !!e.isTest,
    study: { id: e.surveyId, title: cleanLine(e.studyTitle, 200) || null },
    subject: e.ref ?? null, participant: e.participant ? cleanLine(e.participant, 40) : null,
    title: r.title, text: r.text, excerpt: r.excerpt, link: r.link,
    detail: Object.fromEntries(Object.entries(e.detail ?? {}).slice(0, 20).map(([k, v]) => [k.slice(0, 40), typeof v === "string" ? cleanLine(v, 200) : v])),
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function renderEmail(e: NotifyEvent, ctx: RenderContext = {}): { subject: string; text: string; html: string } {
  const r = renderAlert(e, ctx);
  const subject = `[Rescript] ${r.title} — ${cleanLine(e.studyTitle, 80) || "a study"}`;
  const lines = [r.text, r.excerpt ? `What was said (redacted): “${r.excerpt}”` : "", r.link ? `Open: ${r.link}` : "", "", "You receive this because an alert rule in Rescript sends this event to you. Change it under Research Tools → Qualitative → Alerts & panels, or Settings → Alerts."].filter((x, i) => x || i === 3);
  const html = `<div style="font:14px/1.5 system-ui,sans-serif;color:#111"><h2 style="font-size:16px;margin:0 0 8px;${r.severity === "critical" ? "color:#b91c1c" : ""}">${escapeHtml(r.title)}</h2><p>${escapeHtml(r.text)}</p>${r.excerpt ? `<blockquote style="margin:8px 0;padding:6px 10px;border-left:3px solid #ddd;color:#444">“${escapeHtml(r.excerpt)}” <em>(redacted)</em></blockquote>` : ""}${r.link && /^https?:\/\//.test(r.link) ? `<p><a href="${escapeHtml(r.link)}">Open in Rescript</a></p>` : ""}<p style="color:#666;font-size:12px">You receive this because an alert rule in Rescript sends this event to you.</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

/** one digest message for several events (hourly / daily) */
export function renderDigest(events: NotifyEvent[], ctx: RenderContext = {}): { title: string; text: string; lines: string[] } {
  const byType = new Map<NotifyEventType, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const lines = events.slice(0, 30).map((e) => { const r = renderAlert(e, ctx); return `• ${r.text}${r.excerpt ? ` “${r.excerpt}”` : ""}`; });
  if (events.length > 30) lines.push(`… and ${events.length - 30} more`);
  const title = `Rescript digest: ${[...byType].map(([t, n]) => `${n} × ${NOTIFY_EVENTS[t].label.toLowerCase()}`).join(", ")}`;
  return { title, text: lines.join("\n"), lines };
}

/* ------------------------------------------------------------ an event as it is stored */

/** what the outbox keeps of an event: the excerpt already redacted, the participant only as a pseudonym */
export interface NotifyPayload { studyTitle?: string | null; participant?: string | null; excerpt?: string | null; link?: string | null; detail?: Record<string, string | number | boolean | null>; at: string }

export interface NotifyEmitInput {
  type: NotifyEventType | string;
  surveyId: string;
  customerId?: string | null;
  studyTitle?: string | null;
  ref?: string | null;
  participant?: string | null;
  /** raw words — redacted here, before anything is stored */
  excerpt?: string | null;
  link?: string | null;
  detail?: Record<string, string | number | boolean | null>;
  /** idempotency: the same key is one event (default: type + survey + ref) */
  idempotencyKey?: string;
  source?: "studio" | "runtime" | "cron";
  isTest?: boolean;
  at?: string;
}

const PSEUDONYM = /^[A-Za-z0-9._:@~+=-]{1,40}$/;
/** what is stored: the excerpt redacted, the participant only when it is a pseudonymous id, details as scalars */
export function normaliseNotifyInput(input: NotifyEmitInput, nowMs: number): { error: string } | { type: NotifyEventType; payload: NotifyPayload; idempotencyKey: string } {
  if (!isNotifyEventType(input.type) || input.type === "notify.test") return { error: `unknown event type “${String(input.type).slice(0, 60)}”` };
  if (!input.surveyId) return { error: "surveyId is required" };
  const detail: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input.detail ?? {}).slice(0, 20)) if (/^[a-z][a-z0-9_]{0,39}$/i.test(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))) detail[k] = typeof v === "string" ? redactExcerpt(v, 120) : v;
  const participant = input.participant && PSEUDONYM.test(input.participant) && !/@.+\./.test(input.participant) ? input.participant : null;
  const link = typeof input.link === "string" && (/^\/(?!\/)/.test(input.link) || /^https:\/\//.test(input.link)) ? input.link.slice(0, 500) : null;
  return {
    type: input.type,
    idempotencyKey: (input.idempotencyKey ?? `${input.type}:${input.surveyId}:${input.ref ?? new Date(nowMs).toISOString()}`).slice(0, 200),
    payload: { studyTitle: input.studyTitle ? String(input.studyTitle).slice(0, 200) : null, participant, excerpt: input.excerpt ? redactExcerpt(input.excerpt) || null : null, link, detail, at: input.at ?? new Date(nowMs).toISOString() },
  };
}


/* ------------------------------------------------------------ settings helpers */

export const parseAlertSettings = (v: unknown): AlertSettings | null => { const r = AlertSettingsSchema.safeParse(v ?? {}); return r.success ? r.data : null; };
/** the channel kinds a settings object uses (the setup screen marks unconfigured ones) */
export function channelRefsOf(s: AlertSettings | null | undefined): AlertChannelRef[] {
  const seen = new Map<string, AlertChannelRef>();
  for (const r of s?.rules ?? []) for (const c of r.channels) seen.set(`${c.kind}:${c.to.toLowerCase()}`, c);
  return [...seen.values()];
}
export const CHANNEL_KIND_LABELS: Record<AlertChannelKind, string> = { email: "E-mail", in_app: "In-app", slack: "Slack", teams: "Microsoft Teams", webhook: "Webhook" };
