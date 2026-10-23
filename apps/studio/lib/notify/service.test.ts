import test from "node:test";
import assert from "node:assert/strict";
import { AlertSettings } from "@rescript/schema";
import { sealEnvelope, openEnvelope, signedHeader, verifySignedHeader } from "@rescript/ai";
import { memoryNotifyStore, emptyNotifyState } from "./memoryStore.ts";
import { emitNotifyEvent, runDue, sendNotification, testChannel, normaliseEvent, renderTemplate, studioLink, type NotifyDeps } from "./service.ts";
import type { ChannelRec } from "./types.ts";

const KEY = { INTEGRATIONS_SECRET_KEY: "11".repeat(32) };
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);

function setup(opts: { status?: number[]; mail?: "sent" | "not_configured" } = {}) {
  const state = emptyNotifyState();
  let now = T0;
  const store = memoryNotifyStore(state, { now: () => now });
  const posts: { url: string; body: any; headers: Record<string, string> }[] = [];
  const mails: { to: string; subject: string; text: string }[] = [];
  const statuses = [...(opts.status ?? [])];
  const deps: NotifyDeps = {
    store, now: () => now, studioUrl: "https://studio.example.com", rand: () => 0.5,
    async post(url, body, headers) { posts.push({ url, body: JSON.parse(body), headers }); return { status: statuses.length ? statuses.shift()! : 200 }; },
    async mail(m) { mails.push(m); return { status: opts.mail ?? "sent" }; },
    openChannel: (c) => JSON.parse(openEnvelope(c.sealed!, `notify-channel|${c.customerId}|${c.id}`, KEY)),
    signWebhook: (s, b, n) => signedHeader(s, b, n),
  };
  const channel = (kind: ChannelRec["kind"], name: string, url: string, signingSecret?: string): ChannelRec => {
    const id = `ch-${kind}-${state.channels.length}`;
    const c: ChannelRec = { id, customerId: "org1", kind, name, config: {}, sealed: sealEnvelope(JSON.stringify({ url, ...(signingSecret ? { signingSecret } : {}) }), `notify-channel|org1|${id}`, KEY).sealed, keyId: "k", hint: "x", enabled: true, lastTestAt: null, lastStatus: null, createdBy: null, createdAt: new Date(T0).toISOString() };
    state.channels.push(c);
    return c;
  };
  state.projects.s1 = { surveyId: "s1", customerId: "org1", title: "Broadband switching", ownerId: "u-owner", alerts: null, team: [{ userId: "u-owner", email: "owner@example.com" }, { userId: "u-2", email: "two@example.com" }] };
  return { state, store, deps, posts, mails, channel, tick: (ms: number) => { now += ms; } };
}
const DISTRESS = { type: "ai_interview.distress", surveyId: "s1", ref: "int-1", participant: "P3", excerpt: "I can't cope any more. My name is Priya Shah, priya@example.com, +91 98765 43210", link: studioLink("s1", { tab: "qualitative", qual: "ai", interview: "int-1" }), source: "runtime" as const };

test("a distress event with no rule goes to the team's bell; with a study rule to Slack and a signed webhook — redacted, linked, once", async () => {
  const a = setup();
  const r0 = await emitNotifyEvent(a.deps, DISTRESS);
  assert.ok(r0.ok);
  assert.deepEqual(r0.ok && r0.deliveries.map((d) => [d.channelKind, d.destination, d.status]), [["in_app", "user:u-owner", "sent"], ["in_app", "user:u-2", "sent"]]);
  assert.match(a.state.inApp[0].title, /URGENT: Distress flagged/);
  assert.doesNotMatch(JSON.stringify(a.state), /Priya|priya@|98765/, "nothing stored holds the raw words");

  const b = setup();
  b.channel("slack", "#research-ops", "https://hooks.slack.com/services/T/B/x");
  b.channel("webhook", "ops-hook", "https://hooks.example.com/rescript", "whsec_1");
  b.state.projects.s1.alerts = AlertSettings.parse({ rules: [{ id: "r1", events: ["ai_interview.distress"], channels: [{ kind: "slack", to: "#research-ops" }, { kind: "webhook", to: "ops-hook" }, { kind: "email", to: "@me" }] }] });
  const r = await emitNotifyEvent(b.deps, DISTRESS);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.deliveries.map((d) => [d.channelKind, d.destination, d.status]), [["slack", "slack:#research-ops", "sent"], ["webhook", "webhook:ops-hook", "sent"], ["email", "owner@example.com", "sent"]]);
  const slack = b.posts.find((p) => p.url.includes("slack"))!;
  const s = JSON.stringify(slack.body);
  assert.doesNotMatch(s, /Priya|priya@|98765/);
  assert.match(s, /participant P3/); assert.match(s, /\[name\]/);
  assert.match(s, /"url":"https:\/\/studio\.example\.com\/studio\/s1\?tab=qualitative&qual=ai&interview=int-1"/);
  const hook = b.posts.find((p) => p.url.includes("hooks.example.com"))!;
  assert.ok(verifySignedHeader("whsec_1", hook.headers["x-rescript-signature"], JSON.stringify(hook.body), T0), "the webhook is signed over the exact body");
  assert.equal(hook.headers["x-rescript-event"], "ai_interview.distress");
  assert.ok(hook.headers["idempotency-key"].startsWith("ai_interview.distress:s1:int-1|"));
  assert.equal(b.mails[0].to, "owner@example.com", "@me is the owner until the rule is claimed");
  assert.doesNotMatch(b.mails[0].text, /Priya/);
  /* the same event again (a replayed request) is one event; the same thing within 15 min is skipped */
  const again = await emitNotifyEvent(b.deps, DISTRESS);
  assert.ok(again.ok && !again.inserted && again.deliveries.length === 0);
  const dup = await emitNotifyEvent(b.deps, { ...DISTRESS, idempotencyKey: "other-key" });
  assert.deepEqual(dup.ok && dup.deliveries.map((d) => d.status), ["skipped", "skipped", "skipped"]);
  assert.equal(b.posts.length, 2, "no second message");
});

test("burst: past the hourly cap the rest wait for the digest; the digest goes out as one message; retries back off and give up", async () => {
  const a = setup();
  a.channel("slack", "alerts", "https://hooks.slack.com/services/T/B/y");
  a.state.projects.s1.alerts = AlertSettings.parse({ maxPerHour: 2, rules: [{ id: "r1", events: ["ai_interview.abuse"], channels: [{ kind: "slack", to: "alerts" }] }] });
  for (let i = 0; i < 5; i++) await emitNotifyEvent(a.deps, { type: "ai_interview.abuse", surveyId: "s1", ref: `int-${i}`, participant: `P${i}` });
  assert.equal(a.posts.length, 2, "two immediate");
  assert.deepEqual(a.state.deliveries.map((d) => d.status), ["sent", "sent", "digest_pending", "digest_pending", "digest_pending"]);
  a.tick(61 * 60_000);
  const due = await runDue(a.deps);
  assert.equal(due.digests, 1);
  assert.equal(a.posts.length, 3, "one digest message");
  assert.match(a.posts[2].body.text, /3 × abuse in an ai interview/i);
  assert.deepEqual(a.state.deliveries.map((d) => d.status), ["sent", "sent", "digested", "digested", "digested"]);

  const b = setup({ status: [503, 500, 502, 503, 504] });
  b.channel("webhook", "flaky", "https://hooks.example.com/flaky");
  b.state.projects.s1.alerts = AlertSettings.parse({ rules: [{ id: "r1", events: ["study.cost_cap"], channels: [{ kind: "webhook", to: "flaky" }] }] });
  await emitNotifyEvent(b.deps, { type: "study.cost_cap", surveyId: "s1", ref: "budget" });
  let d = b.state.deliveries[0];
  assert.equal(d.status, "retrying"); assert.equal(d.attempts, 1); assert.equal(d.nextAttemptAt, new Date(T0 + 30_000).toISOString());
  for (const wait of [30_000, 120_000, 480_000, 1_920_000]) { b.tick(wait); await runDue(b.deps); }
  d = b.state.deliveries[0];
  assert.equal(d.status, "failed"); assert.equal(d.attempts, 5); assert.equal(b.posts.length, 5);
  assert.equal(new Set(b.posts.map((p) => p.headers["idempotency-key"])).size, 1, "every retry carries the same idempotency key");
  const c = setup({ status: [404] });
  c.channel("teams", "Research", "https://x.webhook.office.com/abc");
  c.state.projects.s1.alerts = AlertSettings.parse({ rules: [{ id: "r1", events: ["*"], channels: [{ kind: "teams", to: "Research" }] }] });
  await emitNotifyEvent(c.deps, { type: "study.target_reached", surveyId: "s1", ref: "t" });
  assert.equal(c.state.deliveries[0].status, "failed", "a 404 is not retried");
});

test("quiet hours hold all but distress; an unknown channel is logged as not connected; e-mail not configured is said", async () => {
  const a = setup({ mail: "not_configured" });
  a.state.projects.s1.alerts = AlertSettings.parse({ quietHours: { start: "09:00", end: "18:00" }, rules: [{ id: "r1", events: ["*"], channels: [{ kind: "in_app", to: "@me" }, { kind: "slack", to: "#nowhere" }, { kind: "email", to: "ops@example.com" }] }] });
  await emitNotifyEvent(a.deps, { type: "ai_interview.abuse", surveyId: "s1", ref: "i1" });
  assert.deepEqual(a.state.deliveries.map((d) => [d.channelKind, d.status]), [["in_app", "digest_pending"], ["slack", "not_configured"], ["email", "digest_pending"]]);
  assert.match(a.state.deliveries[1].reason!, /no Slack channel named “#nowhere”/);
  assert.equal(a.state.deliveries[0].nextAttemptAt, "2026-10-22T18:00:00.000Z", "held until the quiet hours end");
  await emitNotifyEvent(a.deps, DISTRESS);
  assert.deepEqual(a.state.deliveries.slice(3).map((d) => [d.channelKind, d.status]), [["in_app", "sent"], ["slack", "not_configured"], ["email", "not_configured"]]);
});

test("normalising: unknown types refused; pseudonyms only; links only Studio paths or https", () => {
  assert.ok("error" in normaliseEvent({ type: "nope", surveyId: "s" }, T0));
  assert.ok("error" in normaliseEvent({ type: "notify.test", surveyId: "s" }, T0), "tests come from the button");
  const n = normaliseEvent({ type: "ai_interview.distress", surveyId: "s", participant: "priya@example.com", link: "javascript:alert(1)", detail: { note: "call 98765 43210", ok: true, "bad key!": 1 } }, T0);
  assert.ok(!("error" in n));
  if (!("error" in n)) { assert.equal(n.payload.participant, null); assert.equal(n.payload.link, null); assert.deepEqual(n.payload.detail, { note: "call [phone]", ok: true }); }
});

test("sendNotification (G2's API): invite by e-mail with a dedupe key; templates; the test button", async () => {
  const a = setup();
  const r = await sendNotification(a.deps, { channel: "email", to: "p1@example.com", template: "live_session_invite", data: { title: "Focus group: broadband", startsAt: "Tue 27 Oct, 18:00 IST", joinUrl: "https://r.example.com/live/abc", minutes: 60, senderName: "Acme Research" }, surveyId: "s1", dedupeKey: "live:1:p1:invite" });
  assert.equal(r.status, "sent");
  assert.match(a.mails[0].subject, /^Focus group: broadband — Tue 27 Oct, 18:00 IST$/);
  assert.match(a.mails[0].text, /Join here: https:\/\/r\.example\.com\/live\/abc/);
  const again = await sendNotification(a.deps, { channel: "email", to: "p1@example.com", template: "live_session_invite", data: {}, dedupeKey: "live:1:p1:invite" });
  assert.equal(again.status, "sent"); assert.equal(a.mails.length, 1, "one invite per key");
  assert.equal(renderTemplate("live_session_reminder", { title: "<b>x</b>", joinUrl: "javascript:alert(1)" }).html.includes("<b>"), false);
  assert.doesNotMatch(renderTemplate("live_session_reminder", { joinUrl: "javascript:alert(1)" }).text, /javascript/);
  const ch = a.channel("slack", "#tests", "https://hooks.slack.com/services/T/B/z");
  const t = await testChannel(a.deps, ch);
  assert.equal(t.status, "sent");
  assert.match(JSON.stringify(a.posts.at(-1)!.body), /Test alert/);
  assert.equal(a.state.channels.find((c) => c.id === ch.id)!.lastStatus, "ok");
  const bad = setup({ status: [500] });
  const ch2 = bad.channel("webhook", "down", "https://hooks.example.com/down");
  assert.equal((await testChannel(bad.deps, ch2)).status, "failed", "a test is not retried");
  assert.match(bad.state.channels[0].lastStatus!, /failed: the endpoint answered 500/);
});
