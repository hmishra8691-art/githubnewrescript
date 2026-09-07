import { test } from "node:test";
import assert from "node:assert/strict";
import {
  routeRecipient, redirectNotice, escapeHtml, summarise, describeSend,
  estimateSeconds, isEmail, type SentOutcome,
} from "./rules.js";
import {
  passwordResetEmail, projectInvitationEmail, respondentInvitationEmail, testEmail,
} from "./templates.js";

/* ============================================ the guarantee that matters */

test("production delivers to the real recipient", () => {
  const r = routeRecipient("ada@example.com", { tier: "production", redirectTo: null });
  assert.deepEqual(r, { deliverTo: "ada@example.com", redirected: false });
});

test("STAGING NEVER REACHES THE REAL RECIPIENT — even with a redirect set", () => {
  const r = routeRecipient("respondent@client.com", { tier: "staging", redirectTo: "me@agency.com" });
  assert.ok(!("blocked" in r));
  assert.equal(r.deliverTo, "me@agency.com");
  assert.equal(r.redirected, true);
});

test("and with NO redirect set, staging sends nowhere at all", () => {
  // the safe default: an unconfigured staging instance must not mail a client's list
  const r = routeRecipient("respondent@client.com", { tier: "staging", redirectTo: null });
  assert.deepEqual(r, { blocked: "suppressed" });
});

test("development behaves exactly as staging does", () => {
  assert.deepEqual(routeRecipient("a@b.co", { tier: "development", redirectTo: null }), { blocked: "suppressed" });
  const r = routeRecipient("a@b.co", { tier: "development", redirectTo: "dev@me.com" });
  assert.equal("deliverTo" in r && r.deliverTo, "dev@me.com");
});

test("a redirect address that is itself invalid suppresses rather than throwing", () => {
  // a typo in MAIL_DEV_REDIRECT must not become "send to the real person"
  assert.deepEqual(routeRecipient("a@b.co", { tier: "staging", redirectTo: "not-an-address" }), { blocked: "suppressed" });
});

test("a production redirect address is ignored — production is production", () => {
  const r = routeRecipient("real@client.com", { tier: "production", redirectTo: "dev@me.com" });
  assert.equal("deliverTo" in r && r.deliverTo, "real@client.com");
});

test("addresses are lowercased and trimmed, so a pasted list matches the delivery log", () => {
  const r = routeRecipient("  Ada@Example.COM ", { tier: "production", redirectTo: null });
  assert.equal("deliverTo" in r && r.deliverTo, "ada@example.com");
});

test("the rubbish in a pasted list is refused before it becomes a failed send", () => {
  for (const bad of ["", "   ", "ada", "ada@", "@example.com", "ada@example", "ada example@x.com", "ada@ex ample.com"]) {
    assert.deepEqual(
      routeRecipient(bad, { tier: "production", redirectTo: null }),
      { blocked: "invalid_recipient" },
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("isEmail agrees with the router", () => {
  assert.ok(isEmail("ada@example.com"));
  assert.ok(isEmail("  ada@example.co.uk "));
  assert.ok(!isEmail(""));
  assert.ok(!isEmail(null));
  assert.ok(!isEmail("ada@example"));
});

test("a redirected message says who it was really for, and that nobody else got it", () => {
  const n = redirectNotice("respondent@client.com", "staging");
  assert.match(n, /STAGING/);
  assert.match(n, /respondent@client\.com/);
  assert.match(n, /Nobody else received it/i);
});

/* ================================================= summarising a bulk send */

const outcome = (o: SentOutcome) => ({ result: o });

test("a clean send counts as sent", () => {
  const s = summarise([outcome({ sent: true }), outcome({ sent: true })]);
  assert.equal(s.total, 2);
  assert.equal(s.sent, 2);
  assert.equal(s.failed, 0);
});

test("every reason is counted separately, because they mean different things", () => {
  const s = summarise([
    outcome({ sent: true }),
    outcome({ sent: false, reason: "duplicate" }),
    outcome({ sent: false, reason: "invalid_recipient" }),
    outcome({ sent: false, reason: "provider_error" }),
    outcome({ sent: false, reason: "suppressed" }),
    outcome({ sent: false, reason: "not_configured" }),
  ]);
  assert.deepEqual(s, { total: 6, sent: 1, duplicate: 1, invalid: 1, failed: 1, suppressed: 1, notConfigured: 1 });
});

test("a duplicate is not a failure — they already have their link", () => {
  const s = summarise([outcome({ sent: false, reason: "duplicate" })]);
  assert.equal(s.failed, 0);
  assert.equal(s.duplicate, 1);
  assert.doesNotMatch(describeSend(s), /failed/);
});

test("only a real failure tells the person to try again, and says why that is safe", () => {
  const s = summarise([outcome({ sent: true }), outcome({ sent: false, reason: "provider_error" })]);
  const text = describeSend(s);
  assert.match(text, /1 failed/);
  assert.match(text, /stay marked unsent/);
  assert.match(text, /sending again will pick them up/);
});

test("an empty send says so rather than claiming success", () => {
  assert.match(describeSend(summarise([])), /nobody to send to/i);
});

test("a wave's duration is predictable, so a button can warn before it is pressed", () => {
  assert.equal(estimateSeconds(1), 1);
  assert.equal(estimateSeconds(400, 2), 200);
  assert.equal(estimateSeconds(0), 0);
});

/* ============================================================== templates */

test("every template writes its own plain text — never stripped from HTML", () => {
  const all = [
    passwordResetEmail({ url: "https://x.test/reset?token=t", expiresInMinutes: 60 }),
    projectInvitationEmail({ inviterName: "Ada", projectTitle: "Tracker", projectCode: "T1", roleLabel: "Editor", url: "https://x.test/signup?invite=i", hasAccount: false }),
    respondentInvitationEmail({ senderName: "Acme", surveyTitle: "Two questions", url: "https://x.test/s/a/b?token=t" }),
    testEmail({ tier: "production", database: "abc", from: "no-reply@x.test", requestedBy: "ada@x.test" }),
  ];
  for (const m of all) {
    assert.ok(m.subject.length > 0 && m.subject.length < 120, `bad subject: ${m.subject}`);
    assert.ok(m.text.length > 40, "the text part is too thin to be the real one");
    assert.doesNotMatch(m.text, /<[a-z/][^>]*>/i, `HTML leaked into the text part: ${m.subject}`);
    assert.match(m.html, /<div/, "no HTML part");
  }
});

test("every link appears as readable text as well as an anchor", () => {
  // a link only behind "click here" is indistinguishable from phishing, and
  // corporate mail clients rewrite anchors anyway
  const url = "https://survey.example.com/s/acme/study-001?token=abc123";
  const m = respondentInvitationEmail({ senderName: "Acme", surveyTitle: "S", url });
  assert.ok(m.text.includes(url), "the URL is not in the plain text");
  assert.equal((m.html.match(/abc123/g) ?? []).length >= 2, true, "the URL should be both the href and the visible text");
});

test("a respondent is told the link is personal and single-use", () => {
  const m = respondentInvitationEmail({ senderName: "Acme", surveyTitle: "S", url: "https://x.test/s/a/b?token=t" });
  assert.match(m.text, /do not forward/i);
  assert.match(m.text, /only works once/i);
  assert.match(m.html, /do not forward/i);
});

test("the respondent subject leads with the client's name, not ours", () => {
  const m = respondentInvitationEmail({ senderName: "Acme Foods", surveyTitle: "Shopping habits", url: "https://x.test/s/a/b?token=t" });
  assert.ok(m.subject.startsWith("Acme Foods"), m.subject);
  assert.doesNotMatch(m.subject, /Rescript/);
});

test("the reset email reassures rather than alarms, and never names the account in the subject", () => {
  const m = passwordResetEmail({ name: "Ada Lovelace", url: "https://x.test/reset?token=t", expiresInMinutes: 60 });
  assert.match(m.text, /Hello Ada Lovelace/);
  assert.match(m.text, /nothing has changed/i);
  assert.match(m.text, /current password still works/i);
  assert.match(m.text, /60 minutes/);
  /* subjects show on lock screens */
  assert.doesNotMatch(m.subject, /Ada|@/);
});

test("the reset email works for an account with no name on it", () => {
  const m = passwordResetEmail({ name: null, url: "https://x.test/reset?token=t", expiresInMinutes: 60 });
  assert.match(m.text, /^Hello,/);
});

test("an invitation says what the role is and that it is scoped to one project", () => {
  const m = projectInvitationEmail({
    inviterName: "Ada", projectTitle: "Brand tracker", projectCode: "BT-4",
    roleLabel: "Programmer", url: "https://x.test/signup?invite=i",
    expiresAt: "2026-04-01T00:00:00Z", hasAccount: false,
  });
  assert.match(m.subject, /Ada invited you/);
  assert.match(m.text, /Brand tracker/);
  assert.match(m.text, /BT-4/);
  assert.match(m.text, /Programmer/);
  assert.match(m.text, /does not change anything else/i);
  assert.match(m.text, /1 April 2026/);
});

test("the invitation tells someone with no account to create one", () => {
  const withOut = projectInvitationEmail({ inviterName: "A", projectTitle: "P", projectCode: "C", roleLabel: "Editor", url: "https://x/y", hasAccount: false });
  const withIn = projectInvitationEmail({ inviterName: "A", projectTitle: "P", projectCode: "C", roleLabel: "Editor", url: "https://x/y", hasAccount: true });
  assert.match(withOut.text, /Create your account/i);
  assert.match(withIn.text, /Open it here/i);
});

test("the test email says what it does NOT prove — the mistake that costs a fieldwork day", () => {
  const m = testEmail({ tier: "staging", database: "abc", from: "no-reply@x.test", requestedBy: "ada@x.test" });
  assert.match(m.text, /does not prove your DNS/i);
  assert.match(m.text, /SPF and DKIM/);
  assert.match(m.text, /filtered as spam/i);
  assert.match(m.subject, /staging/);
});

/* ================================================================ escaping */

test("a name from a client's spreadsheet cannot inject markup into the HTML part", () => {
  const m = respondentInvitationEmail({
    name: '<img src=x onerror="alert(1)">',
    senderName: '</div><script>alert(2)</script>',
    surveyTitle: "S & S",
    url: "https://x.test/s/a/b?token=t",
  });
  assert.doesNotMatch(m.html, /<script/i);
  assert.doesNotMatch(m.html, /onerror=/i);
  assert.match(m.html, /&lt;script/);
  assert.match(m.html, /S &amp; S/);
});

test("a url with an ampersand survives into a working href", () => {
  const url = "https://x.test/s/a/b?token=t&lang=fr";
  const m = respondentInvitationEmail({ senderName: "A", surveyTitle: "S", url });
  assert.match(m.html, /token=t&amp;lang=fr/);
  assert.ok(m.text.includes(url));
});

test("escapeHtml covers the five characters that matter", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});
