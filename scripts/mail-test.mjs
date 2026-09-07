/**
 * MAIL, FROM THE OUTSIDE.
 *
 * The transport itself cannot be exercised here — the container has no
 * provider key, and pointing a test at Resend would send real mail. So the
 * three things a browser CAN prove are the three that go wrong:
 *
 *   the reset page can actually set a password now (it was a placeholder that
 *     pointed back to sign-in, because the Studio never held a Supabase
 *     access token — migration 0016 moved the reset to the platform's own
 *     tokens, and this asserts the form is real and validates);
 *   /platform tells you whether mail is configured and, crucially, whether
 *     this instance can reach real people at all;
 *   an unconfigured instance still says the honest thing everywhere rather
 *     than offering a button that silently does nothing.
 *
 * The rules and the templates are unit-tested in `packages/mail`
 * (28 checks), and the tables in `scripts/mail-sql-test.sql` (10).
 *
 *   node scripts/mail-test.mjs        (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

/* ------------------------------------------------------- the reset page */
console.log("\nTHE RESET PAGE CAN NOW SET A PASSWORD");

await page.goto(`${STUDIO}/reset`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="reset-no-token"]');
const noToken = await page.textContent('[data-testid="reset-no-token"]');
assert.match(noToken, /needs the link from your reset email/i);
assert.doesNotMatch(noToken, /handled by our authentication provider/i, "the old placeholder copy is still there");
ok("without a token it explains itself instead of showing a form that cannot work");

await page.goto(`${STUDIO}/reset?token=${"x".repeat(43)}`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="reset-form"]');
await page.waitForSelector('[data-testid="reset-password"]');
await page.waitForSelector('[data-testid="reset-confirm"]');
ok("with a token there is a real form");

assert.equal(await page.$eval('[data-testid="reset-submit"]', (b) => b.disabled), true);
ok("submit is disabled until it can succeed");

await page.fill('[data-testid="reset-password"]', "short");
await page.waitForSelector('[data-testid="reset-too-short"]');
ok("it says the password is too short before the server has to");

await page.fill('[data-testid="reset-password"]', "a-long-enough-passphrase");
await page.fill('[data-testid="reset-confirm"]', "a-different-one");
await page.waitForSelector('[data-testid="reset-mismatch"]');
assert.equal(await page.$eval('[data-testid="reset-submit"]', (b) => b.disabled), true);
ok("a mismatch is caught, and still cannot be submitted");

await page.fill('[data-testid="reset-confirm"]', "a-long-enough-passphrase");
await page.waitForFunction(() => !document.querySelector('[data-testid="reset-submit"]').disabled);
ok("matching, long enough — now it can be submitted");

/* the token is a fake, so the API must refuse it and say so */
await page.click('[data-testid="reset-submit"]');
await page.waitForSelector('[data-testid="reset-error"]', { timeout: 10000 });
const err = await page.textContent('[data-testid="reset-error"]');
/*
 * Three legitimate refusals, depending on the instance: an unknown token, a
 * database without migration 0016, or — as here in the container, which has
 * no Supabase credentials — no reachable database at all. What is asserted is
 * that the refusal is ACTIONABLE prose and never a bare status code, because
 * this is the one screen a locked-out person has no way around.
 */
assert.match(
  err,
  /expired|already been used|migration 0016|not configured to reach its database/i,
  `unexpected refusal: ${err}`,
);
assert.doesNotMatch(err, /^That did not work \(\d+\)/, "a bare status code is not an answer");
ok(`a token that cannot be redeemed is refused in prose (“${err.trim().slice(0, 46)}…”)`);

/* the password must not still be sitting in the DOM after a failure */
const stillThere = await page.$eval('[data-testid="reset-password"]', (i) => i.value);
assert.equal(stillThere, "a-long-enough-passphrase", "the field should keep its value so the person can retry");
ok("the typed password survives a failed attempt, so it need not be retyped");

/* -------------------------------------------------------- /platform mail */
console.log("\nWHETHER THIS INSTANCE CAN SEND, AND TO WHOM");

await page.goto(`${STUDIO}/platform`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="platform-mail"]');
const mail = await page.textContent('[data-testid="platform-mail"]');

if (await page.$('[data-testid="platform-mail-off"]')) {
  assert.match(mail, /RESEND_API_KEY/);
  assert.match(mail, /fall back to handing you a link/i);
  ok("with no key it says so, and says what still works without one");
  assert.equal(await page.$('[data-testid="platform-mail-test"]'), null, "there should be no test button with nothing to test");
  ok("and offers no test button that could only fail");
} else {
  await page.waitForSelector('[data-testid="platform-mail-test"]');
  assert.match(mail, /Reaches real recipients/i);
  ok("with a key it reports the addresses and whether real people can be reached");
  assert.match(mail, /does .{0,4}not.{0,4} prove your DNS/i);
  ok("and warns that a delivered test does not prove DNS");
}

/* nothing on the page is ever a credential */
const body = await page.textContent('[data-testid="platform-page"]');
assert.doesNotMatch(body, /re_[A-Za-z0-9]{12}/, "a Resend key reached the page");
assert.doesNotMatch(body, /eyJ[A-Za-z0-9_-]{10}/, "a JWT reached the page");
ok("no key, in any form, appears on the page");

assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
ok("no page errors");

await browser.close();
console.log(`\nALL ${pass} CHECKS PASSED`);
