/**
 * THE RESPONDENT PORTAL IN A REAL BROWSER (Respondent Intelligence Engine, phase 1 — runtime only, sandbox store).
 *
 * The runtime with no database and the stand-in provider serves the portal from its seeded in-memory store
 * (apps/runtime/lib/portal/sandbox.ts): Ana (three assessments), Ben (one), Cara (invited, no password yet).
 *
 *   1. signed out: the dashboard goes to sign-in; a wrong password and an unknown login read the same
 *   2. sign in with the Respondent ID → the dashboard: to do / in progress / completed, Ana's only; the session
 *      cookie is httpOnly (the page's own script cannot read it)
 *   3. start and continue: the server answers with the survey link (personal token; the resume id for the one in progress)
 *   4. a completed assessment: answers as words; the locked answer has no Change; an allowed one is changed and stays
 *      changed after a reload; a required rule still holds
 *   5. somebody else's assessment is "not found" by address and by API; changing their answer is refused
 *   6. a request without the portal header, or from another origin, is refused
 *   7. profile: name; password change (weak refused, then changed; the old one no longer signs in); sign out
 *   8. invitation link: shows the Respondent ID, sets a password, lands signed in; the link then no longer works
 *   9. forgotten password: the same answer for a real and an unknown login
 *  10. the pages work at a phone's width without sideways scrolling
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const PASSWORD = "sandbox portal password";
const INVITE = "sandbox-invitation-token-000000000000000000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: RUNTIME });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const api = (path, body, headers = { "x-rescript-portal": "1" }) => page.evaluate(async ([p, b, h]) => {
  const r = await fetch(`/api/portal/${p}`, { method: b ? "POST" : "GET", headers: b ? { "content-type": "application/json", ...h } : undefined, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [path, body ?? null, headers]);
const signIn = async (login, password) => {
  await page.goto("/portal/login");
  await page.fill('[data-testid="pt-login"]', login);
  await page.fill('[data-testid="pt-password"]', password);
  await page.click('[data-testid="pt-signin"]');
};

console.log("\n1 — signed out");
{
  await page.goto("/portal");
  await page.waitForURL(/\/portal\/login/);
  ok("the dashboard sends a signed-out visitor to sign-in");
  await signIn("RSP-SANDB0X1", "not the password");
  const wrong = await page.textContent('.pt-note.is-bad');
  await signIn("nobody@sandbox.test", "not the password");
  const unknown = await page.textContent('.pt-note.is-bad');
  assert.equal(wrong, unknown);
  assert.match(wrong, /do not match an account/);
  ok("a wrong password and an unknown login get the same sentence");
}

console.log("\n2 — sign in, the dashboard");
{
  await signIn("rsp-sandb0x1", PASSWORD);
  await page.waitForURL(/\/portal$/);
  await page.waitForSelector('[data-testid="pt-card-completed"]');
  await page.waitForFunction(() => /Welcome, Ana Silva/.test(document.querySelector("h1")?.textContent ?? ""));
  assert.match(await page.textContent('[data-testid="pt-who"]'), /RSP-SANDB0X1/);
  const titles = await page.$$eval(".pt-tile h3", (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles.sort(), ["Onboarding questionnaire", "Sleep diary", "Weekly wellbeing check"]);
  assert.equal(await page.locator('[data-testid="pt-card-in_progress"] [data-testid="pt-resume"]').count(), 1);
  assert.equal(await page.locator('[data-testid="pt-card-open"] [data-testid="pt-start"]').count(), 1);
  assert.ok(!(await page.content()).includes("Ben"), "nothing of another respondent is on the page");
  assert.ok(!(await page.content()).includes("sandbox-token-"), "no personal link token is in the page");
  const cookies = await context.cookies();
  const c = cookies.find((x) => x.name === "rescript_portal");
  assert.ok(c && c.httpOnly && c.sameSite === "Lax", JSON.stringify(c));
  assert.equal(await page.evaluate(() => document.cookie.includes("rescript_portal")), false);
  ok("the dashboard lists Ana's three assessments by state; the session cookie is httpOnly and SameSite=Lax");
}

console.log("\n3 — start and continue");
{
  const start = await api("assessments/e-open", { action: "start" });
  assert.equal(start.status, 200); assert.equal(start.body.url, "/s/sandbox/e-open?token=sandbox-token-e-open"); assert.equal(start.body.resumed, false);
  const resume = await api("assessments/e-running", { action: "start" });
  assert.equal(resume.body.resumed, true); assert.match(resume.body.url, /&r=sandbox-session-r-running-0000$/);
  const again = await api("assessments/e-done", { action: "start" });
  assert.equal(again.status, 409); assert.equal(again.body.code, "assessment_completed");
  ok("start gives the personal survey link; an unfinished attempt resumes; a completed one-attempt assessment is refused");
}

console.log("\n4 — my answers, and changing one");
{
  await page.click('[data-testid="pt-card-completed"] [data-testid="pt-view"]');
  await page.waitForSelector('[data-testid="pt-answers"]');
  const answers = await page.$$eval(".pt-answers .pt-a", (els) => els.map((e) => e.textContent));
  assert.deepEqual(answers, ["Well", "Went for a walk, Saw friends", "A calm week."]);
  assert.equal(await page.locator('[data-testid="pt-change-Q1"]').count(), 0, "the locked answer offers no Change");
  await page.click('[data-testid="pt-change-Q3"]');
  await page.fill('[data-testid="pt-editor"] textarea', "A calm week, and I slept better.");
  await page.click('[data-testid="pt-save"]');
  await page.waitForSelector('.pt-note.is-ok');
  await page.click('[data-testid="pt-change-Q2"]');
  await page.locator('[data-testid="pt-editor"] label', { hasText: "Slept well" }).click();
  await page.click('[data-testid="pt-save"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".pt-answers .pt-a")].some((e) => /Slept well/.test(e.textContent ?? "")));
  await page.reload();
  await page.waitForSelector('[data-testid="pt-answers"]');
  assert.deepEqual(await page.$$eval(".pt-answers .pt-a", (els) => els.map((e) => e.textContent)), ["Well", "Went for a walk, Saw friends, Slept well", "A calm week, and I slept better."]);
  const locked = await api("assessments/e-done", { action: "answer", responseId: "r-done", questionId: "q1", value: 1, revision: 2 });
  assert.equal(locked.status, 403); assert.equal(locked.body.code, "question_locked");
  const stale = await api("assessments/e-done", { action: "answer", responseId: "r-done", questionId: "q3", value: "from an old window", revision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "revision_conflict");
  assert.equal(await page.locator('[data-testid="pt-print"]').count(), 1);
  ok("answers are shown as words; a locked answer cannot be changed (page or API); allowed changes are saved and survive a reload; a stale window is refused");
}

console.log("\n5 — somebody else's assessment");
{
  const view = await api("assessments/e-ben");
  assert.equal(view.status, 404); assert.equal(view.body.code, "not_found");
  const edit = await api("assessments/e-ben", { action: "answer", responseId: "r-ben", questionId: "q3", value: "x", revision: 0 });
  assert.equal(edit.status, 404);
  const cross = await api("assessments/e-done", { action: "answer", responseId: "r-ben", questionId: "q3", value: "x", revision: 0 });
  assert.equal(cross.status, 404);
  await page.goto("/portal/assessments/e-ben");
  await page.waitForSelector('.pt-note.is-bad');
  assert.match(await page.textContent('.pt-note.is-bad'), /not found/);
  assert.ok(!(await page.content()).includes("private answer"));
  ok("another respondent's assessment is 'not found' by address and by API, and their answer cannot be changed");
}

console.log("\n6 — a change must come from the portal itself");
{
  const bare = await api("me", { action: "profile", name: "Mallory" }, {});
  assert.equal(bare.status, 403); assert.equal(bare.body.code, "bad_origin");
  const forged = await context.request.post(`${RUNTIME}/api/portal/me`, { data: { action: "profile", name: "Mallory" }, headers: { "x-rescript-portal": "1", origin: "https://evil.example" } });
  assert.equal(forged.status(), 403);
  ok("a change without the portal header, or from another origin, is refused");
}

console.log("\n7 — profile, password, sign out");
{
  await page.goto("/portal/account");
  await page.waitForSelector('[data-testid="pt-sessions"] tbody tr');
  assert.match(await page.textContent('[data-testid="pt-sessions"]'), /this one/);
  await page.fill('[data-testid="pt-name"]', "Ana M. Silva");
  await page.click('[data-testid="pt-save-name"]');
  await page.waitForSelector('.pt-note.is-ok');
  const weak = await api("me", { action: "password", current: PASSWORD, next: "short" });
  assert.equal(weak.status, 400); assert.equal(weak.body.code, "weak_password");
  await page.fill('[data-testid="pt-current-password"]', PASSWORD);
  await page.fill('[data-testid="pt-new-password"]', "a much better passphrase");
  await page.fill('[data-testid="pt-new-password-again"]', "a much better passphrase");
  await page.click('[data-testid="pt-change-password"]');
  await page.waitForFunction(() => /password has been changed/.test(document.body.textContent ?? ""));
  await page.click('[data-testid="pt-signout"]');
  await page.waitForURL(/\/portal\/login/);
  assert.equal((await api("me")).status, 401);
  await signIn("ana@sandbox.test", PASSWORD);
  await page.waitForSelector('.pt-note.is-bad');
  await signIn("ana@sandbox.test", "a much better passphrase");
  await page.waitForURL(/\/portal$/);
  await page.waitForFunction(() => /Ana M\. Silva/.test(document.querySelector("h1")?.textContent ?? ""));
  await page.click('[data-testid="pt-signout"]');
  await page.waitForURL(/\/portal\/login/);
  ok("the name is corrected; a weak password is refused; after a change the old password no longer signs in; sign out ends the session");
}

console.log("\n8 — invitation link");
{
  await page.goto(`/portal/invitation#token=${INVITE}`);
  await page.waitForSelector('[data-testid="pt-rid"]');
  assert.equal(await page.textContent('[data-testid="pt-rid"]'), "RSP-SANDB0X3");
  assert.ok(!page.url().includes(INVITE), "the token is removed from the address bar");
  await page.fill('[data-testid="pt-new-password"]', "caras own long password");
  await page.fill('[data-testid="pt-new-password-again"]', "caras own long password");
  await page.click('[data-testid="pt-activate"]');
  await page.waitForURL(/\/portal$/);
  await page.waitForSelector('[data-testid="pt-none"]');
  await page.waitForFunction(() => /Welcome, Cara Lind/.test(document.querySelector("h1")?.textContent ?? ""));
  await page.click('[data-testid="pt-signout"]');
  await page.waitForURL(/\/portal\/login/);
  await page.goto(`/portal/invitation#token=${INVITE}`);
  await page.waitForSelector('.pt-note.is-bad');
  assert.match(await page.textContent("h1"), /cannot be used/);
  ok("an invitation shows the Respondent ID, sets the password and signs in; the link is then dead");
}

console.log("\n9 — forgotten password");
{
  const real = await api("reset", { login: "ben@sandbox.test" });
  const none = await api("reset", { login: "nobody@sandbox.test" });
  assert.deepEqual(real, none); assert.equal(real.status, 200);
  await page.goto("/portal/reset");
  await page.fill('[data-testid="pt-reset-login"]', "ben@sandbox.test");
  await page.click('[data-testid="pt-reset-ask"]');
  await page.waitForFunction(() => /Check your email/.test(document.querySelector("h1")?.textContent ?? ""));
  ok("asking for a reset answers the same for a real and an unknown login");
}

console.log("\n10 — a phone");
{
  const phone = await browser.newContext({ baseURL: RUNTIME, viewport: { width: 375, height: 740 } });
  const p = await phone.newPage();
  await p.goto("/portal/login");
  await p.fill('[data-testid="pt-login"]', "ben@sandbox.test"); await p.fill('[data-testid="pt-password"]', PASSWORD); await p.click('[data-testid="pt-signin"]');
  await p.waitForSelector('[data-testid="pt-card-completed"]');
  for (const path of ["/portal", "/portal/assessments/e-ben", "/portal/account"]) {
    await p.goto(path); await p.waitForSelector("h1");
    await p.waitForTimeout(400);
    const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(wide <= 1, `${path} scrolls sideways by ${wide}px at 375px`);
  }
  await phone.close();
  ok("the dashboard, an assessment and the account page fit a 375px screen");
}

await browser.close();
console.log(`\n${passed} checks passed`);
