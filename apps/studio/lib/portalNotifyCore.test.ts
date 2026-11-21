import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { messageNotice, noticeMail, planReminders, readReply, requestAnsweredNotice, type EnrolmentFacts } from "./portalNotifyCore.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const at = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const def = (portal: Record<string, unknown> | null) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T", version: "1", schemaVersion: 1, status: "live" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Q" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  ...(portal ? { portal } : {}),
});
const e = (id: string, over: Partial<EnrolmentFacts> = {}): EnrolmentFacts => ({ id, accountId: `acc-${id}`, accessFrom: null, accessUntil: null, suspended: false, lastCompletedAt: null, completions: 0, maxAttempts: null, ...over });
const weekly = def({ enabled: true, template: "wellbeing_checkin", series: { id: "w", label: "Weekly", repeatEveryDays: 7 } });

test("due: once per due date, in the template's word; not when paused, closed, not yet open or out of attempts", () => {
  const plans = planReminders("sv", "Weekly check-in", weekly, [
    e("due", { lastCompletedAt: at(-8), completions: 1 }),
    e("not-yet", { lastCompletedAt: at(-3), completions: 1 }),
    e("never", {}),
    e("paused", { lastCompletedAt: at(-8), completions: 1, suspended: true }),
    e("closed", { lastCompletedAt: at(-8), completions: 1, accessUntil: at(-1) }),
    e("future", { lastCompletedAt: at(-8), completions: 1, accessFrom: at(2) }),
    e("used-up", { lastCompletedAt: at(-8), completions: 3, maxAttempts: 3 }),
  ], NOW);
  assert.deepEqual(plans.map((p) => [p.enrolmentId, p.kind, p.title, p.dedupe]), [["due", "due", "Your next check-in is due: Weekly check-in", `due:due:${at(-1).slice(0, 10)}`]]);
  /* the job running again an hour later plans the SAME notice (the same dedupe), so the person is told once */
  assert.equal(planReminders("sv", "Weekly check-in", weekly, [e("due", { lastCompletedAt: at(-8), completions: 1 })], NOW + 3_600_000)[0]!.dedupe, plans[0]!.dedupe);
});

test("closing: within two days, only for someone who has not completed it; once per closing time", () => {
  const live = def({ enabled: true });
  const plans = planReminders("sv", "Onboarding", live, [e("soon", { accessUntil: at(1) }), e("later", { accessUntil: at(5) }), e("done", { accessUntil: at(1), completions: 1, lastCompletedAt: at(-1) }), e("open-ended", {})], NOW);
  assert.deepEqual(plans.map((p) => [p.enrolmentId, p.kind, p.dedupe]), [["soon", "closing", `closing:soon:${at(1)}`]]);
  assert.match(plans[0]!.title, /^Closing soon: Onboarding$/); assert.match(plans[0]!.body!, /^This assessment closes on .* UTC\.$/);
});

test("no portal, a portal that is off, a survey that is not live: nobody is reminded", () => {
  const people = [e("a", { lastCompletedAt: at(-30), completions: 1, accessUntil: at(1) })];
  assert.deepEqual(planReminders("sv", "T", def(null), people, NOW), []);
  assert.deepEqual(planReminders("sv", "T", def({ enabled: false, series: { id: "w", label: "W", repeatEveryDays: 7 } }), people, NOW), []);
  assert.deepEqual(planReminders("sv", "T", null, people, NOW), []);
});

test("a notice names the assessment and says something happened — never an answer, a score or a message's text", () => {
  const a = requestAnsweredNotice({ accountId: "acc", surveyId: "sv", enrolmentId: "e1", requestId: "r1" }, "Wellbeing 2026");
  assert.deepEqual([a.kind, a.title, a.dedupe], ["request_answered", "Your request has been answered: Wellbeing 2026", "request:r1"]);
  const m = messageNotice({ accountId: "acc", surveyId: "sv", enrolmentId: "e1", messageId: "m1" }, "Wellbeing 2026");
  assert.deepEqual([m.kind, m.title, m.body, m.dedupe], ["message", "You have a new message: Wellbeing 2026", null, "message:m1"]);
  const mail = noticeMail(m, "Ana", "https://take.example.org/portal");
  assert.equal(mail.subject, "You have a new message: Wellbeing 2026");
  assert.match(mail.text, /^Hello Ana,\n\nYou have a new message: Wellbeing 2026\.\n\nSign in to your portal to see it:\n\nhttps:\/\/take\.example\.org\/portal\n\nFor your privacy this email contains no answers or results\.$/);
  assert.match(noticeMail(a, null, "u").text, /^Hello,\n/);
});

test("a staff reply: to one respondent, not empty, not over-long", () => {
  const id = "c0000000-0000-0000-0000-0000000106e1";
  assert.deepEqual(readReply({ enrolmentId: id, text: "  On Monday.  " }), { enrolmentId: id, text: "On Monday." });
  for (const bad of [{ enrolmentId: id, text: " " }, { enrolmentId: "1", text: "x" }, { enrolmentId: id, text: "x".repeat(4001) }, null]) assert.ok("error" in readReply(bad));
});
