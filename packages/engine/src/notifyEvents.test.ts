import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFY_EVENTS, redactExcerpt, routeEvent, deliveryDecision, inQuietHours, retryDelayMs, retryableStatus, renderSlack, renderTeams, renderWebhook, renderEmail, renderAlert, renderDigest, dedupeKeyOf,
  type NotifyEvent,
} from "./notifyEvents.js";
import { AlertSettings } from "@rescript/schema";

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({ id: "e1", type: "ai_interview.distress", surveyId: "s1", studyTitle: "Broadband <b>switching</b>", ref: "int-1", participant: "P3", excerpt: "I feel hopeless. My name is Priya Sharma, mail priya@example.com or call +91 98765 43210, see https://x.example/a", link: "/studio/s1?tab=qualitative&qual=ai&interview=int-1", at: "2026-10-22T10:00:00Z", ...over });

test("redaction: contact details, links, long numbers, a self-introduced name, markup; one line, bounded", () => {
  const r = redactExcerpt("I feel hopeless.\nMy name is Priya Sharma, mail priya@example.com or call +91 98765 43210, see https://x.example/a <!channel> `x` acct 1234 5678 9012");
  assert.doesNotMatch(r, /Priya|Sharma|priya@|98765|https:|<!channel>|`|1234 5678/);
  assert.match(r, /\[name\]/); assert.match(r, /\[email\]/); assert.match(r, /\[phone\]|\[number\]/); assert.match(r, /\[link\]/);
  assert.doesNotMatch(r, /\n/);
  const long = redactExcerpt("word ".repeat(200));
  assert.ok(long.length <= 160 && long.endsWith("…"));
  assert.equal(redactExcerpt(null), "");
  assert.equal(redactExcerpt("the price is 499 a month"), "the price is 499 a month", "ordinary numbers stay");
});

test("routing: study and org rules both apply, categories, the default bell, critical never digested", () => {
  const org = AlertSettings.parse({ rules: [{ id: "o1", events: ["ai_interview.*"], channels: [{ kind: "email", to: "ops@example.com" }], digest: "hourly" }] });
  const study = AlertSettings.parse({ rules: [{ id: "r1", events: ["ai_interview.distress"], channels: [{ kind: "slack", to: "#research-ops" }, { kind: "email", to: "ops@example.com" }] }] });
  const t = routeEvent(ev(), [{ scope: "org", settings: org }, { scope: "study", settings: study }]);
  assert.deepEqual(t.map((x) => `${x.ref.kind}:${x.ref.to}:${x.digest}`).sort(), ["email:ops@example.com:immediate", "slack:#research-ops:immediate"], "the same address once; critical overrides the hourly digest");
  const abuse = routeEvent(ev({ type: "ai_interview.abuse" }), [{ scope: "org", settings: org }]);
  assert.equal(abuse[0].digest, "hourly", "a non-critical event keeps the rule's digest");
  const none = routeEvent(ev({ type: "study.cost_cap" }), []);
  assert.deepEqual(none.map((x) => [x.ref.kind, x.ref.to, x.scope]), [["in_app", "@team", "default"]], "no rule anywhere: the team's bell");
  assert.deepEqual(routeEvent(ev({ type: "survey.milestone" }), []), [], "low events are not defaulted");
  const done = routeEvent(ev({ type: "ai_interview.completed" }), [{ scope: "study", settings: AlertSettings.parse({ rules: [{ id: "r", events: ["*"], channels: [{ kind: "in_app", to: "@me" }] }] }) }]);
  assert.equal(done[0].digest, "hourly", "completions are digested by default");
  assert.deepEqual(routeEvent(ev({ type: "notify.test" }), [{ scope: "study", settings: study }]), []);
  const off = AlertSettings.parse({ rules: [{ id: "r", events: ["*"], channels: [{ kind: "in_app", to: "@me" }], enabled: false }] });
  assert.equal(routeEvent(ev(), [{ scope: "study", settings: off }])[0].scope, "default", "a disabled rule is no rule");
});

test("dedupe, the hourly cap, quiet hours (critical bypasses)", () => {
  const s = AlertSettings.parse({ dedupeMinutes: 15, maxPerHour: 3, quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" } });
  const imm = { digest: "immediate" as const };
  assert.deepEqual(deliveryDecision(ev(), imm, { lastSameAt: "2026-10-22T09:50:00Z", sentLastHour: 0 }, s), { action: "skip", reason: "duplicate" });
  assert.deepEqual(deliveryDecision(ev(), imm, { lastSameAt: "2026-10-22T09:40:00Z", sentLastHour: 0 }, s), { action: "send" });
  const abuse = ev({ type: "ai_interview.abuse" });
  assert.deepEqual(deliveryDecision(abuse, imm, { sentLastHour: 3 }, s), { action: "digest", reason: "rate_limited" });
  assert.deepEqual(deliveryDecision(ev(), imm, { sentLastHour: 99 }, s), { action: "send" }, "distress is never rate-limited");
  /* 18:00Z = 23:30 in Kolkata */
  assert.ok(inQuietHours(s.quietHours, new Date("2026-10-22T18:00:00Z")));
  assert.ok(!inQuietHours(s.quietHours, new Date("2026-10-22T06:00:00Z")));
  assert.deepEqual(deliveryDecision({ ...abuse, at: "2026-10-22T18:00:00Z" }, imm, { sentLastHour: 0 }, s), { action: "digest", reason: "quiet_hours" });
  assert.deepEqual(deliveryDecision(ev({ at: "2026-10-22T18:00:00Z" }), imm, { sentLastHour: 0 }, s), { action: "send" }, "critical bypasses quiet hours");
  assert.deepEqual(deliveryDecision(abuse, { digest: "daily" }, { sentLastHour: 0 }, s), { action: "digest", reason: "digest" });
  assert.equal(dedupeKeyOf(ev()), "ai_interview.distress:s1:int-1");
});

test("retries: exponential backoff with jitter, give up after 5; which statuses retry", () => {
  const d = [1, 2, 3, 4].map((a) => retryDelayMs(a, () => 0.5));
  assert.deepEqual(d, [30_000, 120_000, 480_000, 1_920_000]);
  assert.equal(retryDelayMs(5), null);
  assert.ok(retryDelayMs(1, () => 0)! >= 24_000 && retryDelayMs(1, () => 1)! <= 36_000);
  assert.ok(retryableStatus(429) && retryableStatus(503) && !retryableStatus(400) && !retryableStatus(404));
});

test("rendering: Slack Block Kit (plain_text only for participant words), Teams card, webhook JSON, e-mail — never the raw text", () => {
  const ctx = { studioUrl: "https://studio.example.com" };
  const slack = renderSlack(ev(), ctx);
  const s = JSON.stringify(slack);
  assert.doesNotMatch(s, /Priya|priya@|98765|x\.example/);
  assert.match(s, /"type":"header".*URGENT: Distress flagged/);
  const blocks = slack.blocks as { type: string; elements?: { type: string; url?: string; text?: unknown }[]; text?: { type: string } }[];
  assert.ok(blocks.every((b) => !b.text || b.text.type === "plain_text"), "no mrkdwn anywhere");
  assert.equal(blocks.find((b) => b.type === "actions")!.elements![0].url, "https://studio.example.com/studio/s1?tab=qualitative&qual=ai&interview=int-1");
  assert.match(s, /participant P3/);
  assert.doesNotMatch(s, /<b>/, "markup in a study title is dropped");
  const teams = renderTeams(ev(), ctx);
  assert.equal((teams.attachments as { contentType: string }[])[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.doesNotMatch(JSON.stringify(teams), /Priya|priya@/);
  const hook = renderWebhook(ev({ detail: { segment: "Payers", turns: 7 } }), ctx);
  assert.equal(hook.type, "ai_interview.distress"); assert.equal(hook.severity, "critical"); assert.equal(hook.participant, "P3");
  assert.doesNotMatch(String(hook.excerpt), /Priya/);
  assert.deepEqual(hook.detail, { segment: "Payers", turns: 7 });
  const mail = renderEmail(ev(), ctx);
  assert.match(mail.subject, /^\[Rescript\] URGENT: Distress flagged in an AI interview — Broadband/);
  assert.doesNotMatch(mail.html + mail.text, /Priya|priya@/);
  assert.doesNotMatch(mail.html, /<b>switching/);
  assert.equal(renderAlert(ev({ link: "javascript:alert(1)" }), ctx).link, null, "only Studio paths or https links");
  assert.equal(renderAlert(ev(), {}).link, "/studio/s1?tab=qualitative&qual=ai&interview=int-1", "relative without a Studio URL (in-app)");
  const dg = renderDigest([ev({ type: "ai_interview.completed", excerpt: null }), ev({ type: "ai_interview.completed", excerpt: null, ref: "int-2" })]);
  assert.match(dg.title, /2 × ai interview completed/);
  assert.ok(Object.keys(NOTIFY_EVENTS).includes("live_session.no_show"));
});

test("digests are due at the next hour, 08:00 for daily, or when the quiet hours end", async () => {
  const { digestDueAt } = await import("./notifyEvents.js");
  const now = new Date("2026-10-22T10:17:30Z");
  assert.equal(digestDueAt("digest", "hourly", now, null).toISOString(), "2026-10-22T11:00:00.000Z");
  assert.equal(digestDueAt("rate_limited", "immediate", now, null).toISOString(), "2026-10-22T11:00:00.000Z");
  assert.equal(digestDueAt("digest", "daily", now, null).toISOString(), "2026-10-23T08:00:00.000Z");
  const q = { quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Kolkata", bypassCritical: true } };
  /* 18:00Z is 23:30 in Kolkata; 07:00 IST is 01:30Z */
  assert.equal(digestDueAt("quiet_hours", "immediate", new Date("2026-10-22T18:00:00Z"), q).toISOString(), "2026-10-23T01:30:00.000Z");
});
