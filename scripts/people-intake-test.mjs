/**
 * ADDING PEOPLE, FROM THE OUTSIDE (2026-11-21) — the whole walk in a real browser:
 *
 *   template → type people in → upload a file → every finding in the preview → confirm → the list appears →
 *   reuse a list → rename it → the respondent portal's "People and accounts": pick a list, add people there,
 *   create accounts for everyone in it, see what is handed over.
 *
 * It runs against /sandbox/people: the real Distribution panel on the id "sandbox", whose routes keep the list in
 * memory (no database). The CHECKS are the product's own (`runIntake`, `prepareRespondentList`, `planAccounts`,
 * `credentialRoute`); the storage is not — scripts/distribution-sql-test.sql is the proof of that part.
 *
 *   node scripts/people-intake-test.mjs        (needs the Studio on :3000, started with no database configured)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";

const BASE = "http://localhost:3000";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const t = (id) => `[data-testid="${id}"]`;
const text = async (sel) => ((await page.textContent(sel)) ?? "").replace(/\s+/g, " ").trim();

await page.goto(`${BASE}/sandbox/people`, { waitUntil: "networkidle" });
await page.waitForSelector(t("ds-guide"));
/* a list left over from an earlier run on the same server would make every count below wrong */
assert.ok(await page.$(t("ds-empty")), "the sandbox list is not empty: restart the Studio before running this suite");
assert.match(await text(t("ds-guide")), /Add people/);
assert.match(await text(t("ds-empty")), /Nobody/i);
ok("an empty list says what to do, in three steps");

/* ---------------------------------------------------------------- the template */
const csv = await page.request.get(`${BASE}/api/surveys/sandbox/respondents/template?format=csv`);
assert.equal(csv.status(), 200);
assert.match(csv.headers()["content-disposition"], /respondent-list-template\.csv/);
const csvText = (await csv.text()).replace(/^﻿/, "");
assert.equal(csvText.split(/\r?\n/)[0], "name,email,id,department");
const xlsx = await page.request.get(`${BASE}/api/surveys/sandbox/respondents/template?format=xlsx`);
assert.equal(xlsx.status(), 200);
const xlsxBytes = await xlsx.body();
assert.equal(xlsxBytes.subarray(0, 2).toString(), "PK", "the Excel template is not a workbook");
ok("the template downloads as CSV and as Excel, with the columns name, email, id");

/* ---------------------------------------------------------------- 1. type people in */
await page.click(t("ds-empty-add"));
await page.waitForSelector(t("ds-manual"));
assert.equal(await page.getAttribute(t("ds-mode-type"), "aria-selected"), "true");
ok("Add people opens on typing them in, with the other two ways beside it");

const line = (i, label) => page.getByLabel(`${label}, line ${i}`);
await line(1, "Name").fill("Ada Lovelace");
await line(1, "Email").fill("ada@example.com");
await line(2, "Name").fill("Bob Stone");
await line(2, "Email").fill("bob-at-example");
await page.waitForSelector(t("ds-manual-problem-1"));
assert.match(await text(t("ds-manual-problem-1")), /email/i);
ok("a mistyped address is said under its own line as it is typed");
await line(2, "Email").fill("bob@example.com");
await page.waitForSelector(t("ds-manual-problem-1"), { state: "detached" });

await page.fill(t("ds-quick"), "cy@example.com, Dee Dee <dee@example.com>\nada@example.com");
await page.click(t("ds-quick-add"));
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ds-manual-row"]').length >= 4);
const typed = await page.$$eval('[data-testid^="ds-manual-email-"]', (els) => els.map((e) => e.value).filter(Boolean));
assert.deepEqual(typed, ["ada@example.com", "bob@example.com", "cy@example.com", "dee@example.com"], "pasted addresses were not merged without repeating Ada");
ok("several addresses pasted at once join the table, without repeating one already typed");

await page.click(t("ds-preview"));
await page.waitForSelector(t("ds-error"));
assert.match(await text(t("ds-error")), /name/i);
ok("a new list must be named before anything is checked");
await page.fill(t("ds-list-name"), "Wave 1");
await page.click(t("ds-preview"));
await page.waitForSelector(t("ds-preview-result"));
assert.match(await text(t("ds-headline")), /^4 people will be added to the live list\.$/);
assert.equal(await page.$(t("ds-issues")), null, "a clean list should have nothing to look at");
assert.equal((await page.request.get(`${BASE}/api/surveys/sandbox/respondents?environment=LIVE`).then((r) => r.json())).total, 0, "the preview wrote to the list");
ok("the check says exactly who will be added, and writes nothing");
await page.click(t("ds-commit"));
await page.waitForSelector(t("ds-list-Wave 1"));
assert.match(await text(t("ds-note")), /Added 4 people to “Wave 1”/);
assert.match(await text(t("ds-list-Wave 1")), /4/);
ok("confirming adds them, and the list appears under Your lists");

/* ---------------------------------------------------------------- 2. upload a file with every kind of problem */
if (!(await page.$(t("ds-upload")))) await page.click(t("ds-upload-open"));
await page.click(t("ds-mode-file"));
await page.waitForSelector(t("ds-template-xlsx"));
assert.match(await text(t("ds-file-mode")), /name.*email.*id/i);
assert.match(await text(t("ds-drop")), /\.csv|CSV/i);
const [download] = await Promise.all([page.waitForEvent("download"), page.click(t("ds-template-xlsx"))]);
assert.equal(download.suggestedFilename(), "respondent-list-template.xlsx");
ok("the upload step shows the template, the columns and the formats it reads");

await page.setInputFiles(t("ds-file"), { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
await page.waitForSelector(t("ds-error"));
assert.match(await text(t("ds-error")), /notes\.pdf.*not a file this can read/i);
ok("a file of the wrong kind is refused with the formats that work");

const file = [
  "name,email,id,department",
  "Example Person (delete this row),example.person@example.com,EMP-001,",   // the template's own example
  "Eve Adams,eve@example.com,E-1,Finance",
  "Fay Brown,fay@example,E-2,Finance",                                     // an address that looks wrong, kept by id
  "Gus Clark,not-an-email,,Ops",                                           // an address that looks wrong: kept by name, with no way to email him
  "Eve Again,EVE@example.com,e-1,Finance",                                 // repeated in the file
  ",,,Ops",                                                                // nobody
  "Ada Lovelace,ada@example.com,,Ops",                                     // already on the list
  "Hal Dunn,hal@example.com,,Ops",
].join("\n");
await page.setInputFiles(t("ds-file"), { name: "night_shift.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
await page.waitForSelector(t("ds-file-name"));
assert.equal(await text(t("ds-file-name")), "night_shift.csv");
/* with a list already there the picker offers it; this upload goes on a new one, named after the file */
await page.selectOption(t("ds-list-choice"), "__new__");
assert.equal(await page.inputValue(t("ds-list-name")), "night shift");
ok("the chosen file is named on screen, and a new list is offered its name");
await page.click(t("ds-preview"));
await page.waitForSelector(t("ds-preview-result"));
const headline = await text(t("ds-headline"));
const issues = await text(t("ds-issues"));
assert.match(await text(t("ds-invalid")), /2 emails that look wrong/);
assert.match(await text(t("ds-dupes")), /1 repeated/);
assert.match(await text(t("ds-existing")), /1 person is already on this survey's live list.*ada@example\.com/);
assert.match(issues, /Row 4.*fay@example/i, `the bad address is not named with its row: ${issues}`);
assert.match(issues, /Row 5.*not-an-email/i);
assert.match(issues, /Row 6/i, "the repeated person is not named with their row");
assert.match(issues, /example/i, "the template's example row is not mentioned");
assert.match(headline, /^4 people will be added to the live list \(1 repeated in the file, 1 already on the list left out\)\.$/, headline);
ok("the preview names each problem by row: wrong addresses, a repeat, an empty row, the example row, a person already listed");
assert.ok(await page.$(t("ds-map-department")), "the extra column is not shown");
await page.click(t("ds-commit"));
await page.waitForSelector(t("ds-list-night shift"));
assert.match(await text(t("ds-note")), /Added 4 people to “night shift”.*1 already on the list/);
const after = await page.request.get(`${BASE}/api/surveys/sandbox/respondents?environment=LIVE`).then((r) => r.json());
assert.equal(after.total, 8);
assert.equal(after.rows.filter((r) => r.email === "ada@example.com").length, 1, "Ada was given a second link");
ok("confirming adds the good rows only: nobody twice, and the counts are said");

/* the template itself, uploaded unfilled: nobody to add, and nothing can be confirmed */
if (!(await page.$(t("ds-upload")))) await page.click(t("ds-upload-open"));
await page.click(t("ds-mode-file"));
await page.setInputFiles(t("ds-file"), { name: "respondent-list-template.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsxBytes });
await page.waitForSelector(t("ds-file-name"));
await page.click(t("ds-preview"));
await page.waitForSelector(t("ds-preview-result"));
assert.match(await text(t("ds-headline")), /nobody to add/i);
assert.match(await text(t("ds-blocking")), /nobody to invite/i);
assert.equal(await page.$(t("ds-commit")), null, "there is a confirm button with nobody to add");
ok("the Excel template is read as a workbook, and its example row is never added");

/* ---------------------------------------------------------------- 3. reuse a list */
await page.click(t("ds-mode-paste"));
await page.fill(t("ds-paste"), "name\temail\nIvy Ford\tivy@example.com");
const offered = await page.$$eval('[data-testid="ds-list-choice"] option', (os) => os.map((o) => o.textContent));
assert.deepEqual(offered, ["Wave 1", "night shift", "A new list…"]);
await page.selectOption(t("ds-list-choice"), "Wave 1");
await page.click(t("ds-preview"));
await page.waitForSelector(t("ds-preview-result"));
await page.click(t("ds-commit"));
await page.waitForFunction(() => /5/.test(document.querySelector('[data-testid="ds-list-Wave 1"]')?.textContent ?? ""));
ok("an earlier list can be chosen again, and the pasted person joins it");

/* ---------------------------------------------------------------- 4. rename a list */
page.once("dialog", (d) => void d.accept("Night shift 2026"));
await page.click(t("ds-rename-night shift"));
await page.waitForSelector(t("ds-list-Night shift 2026"));
assert.equal(await page.$(t("ds-list-night shift")), null);
page.once("dialog", (d) => void d.accept("Wave 1"));
await page.click(t("ds-rename-Night shift 2026"));
await page.waitForFunction(() => /already a list called/.test(document.querySelector('[data-testid="ds-note"]')?.textContent ?? ""));
ok("a list can be renamed, and not onto another list's name");

/* ---------------------------------------------------------------- 5. the respondent portal: people and accounts */
const portal = (id) => `[data-testid="portal-panel"] [data-testid="${id}"]`;
const closeTop = page.locator(`${t("ds-upload")} >> text=Close`).first();
if (await closeTop.count()) await closeTop.click();
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(portal("portal-how"));
const how = await text(portal("portal-how"));
assert.match(how, /Choose a list/);
assert.match(how, /email is not set up/i, "the page does not say that invitations cannot be emailed here");
assert.match(how, /shown .* once/i);
const options = await page.$$eval('[data-testid="portal-list"] option', (os) => os.map((o) => o.textContent));
assert.deepEqual(options, ["Everyone on the live list (9)", "Wave 1 (5; 0 with an account)", "Night shift 2026 (4; 0 with an account)"]);
ok("the portal offers the same lists, with their sizes, and says how sign-in details reach people");

await page.selectOption(portal("portal-list"), "Night shift 2026");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="portal-row"]').length === 4);
assert.match(await text(portal("portal-scope")), /4 people in “Night shift 2026”: 0 with an account, 4 without/);
ok("choosing a list shows its people and how many still need an account");

/* add someone with no email address, here, to a new list */
await page.click(portal("portal-add-people"));
await page.waitForSelector(portal("ds-manual"));
await page.locator(portal("ds-manual")).getByLabel("Name, line 1").fill("Jo Paper");
await page.locator(portal("ds-manual")).getByLabel("ID, line 1").fill("P-100");
await page.selectOption(portal("ds-list-choice"), "__new__");
await page.fill(portal("ds-list-name"), "On paper");
await page.click(portal("ds-preview"));
await page.waitForSelector(portal("ds-preview-result"));
await page.click(portal("ds-commit"));
await page.waitForFunction(() => document.querySelector('[data-testid="portal-list"]')?.value === "On paper");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="portal-row"]').length === 1);
assert.match(await text(portal("portal-note")), /Added 1 person to “On paper”.*create their accounts below/i);
assert.equal(await page.$(portal("ds-upload")), null, "the add-people box stayed open");
ok("people can be added from the portal section, and it moves to their list");

await page.click(portal("portal-create-list"));
await page.waitForSelector(portal("portal-handover"));
const hand = await text(portal("portal-handover"));
assert.match(hand, /Jo Paper/);
assert.match(hand, /\/portal\/invitation#token=/);
assert.match(hand, /no email address/i);
assert.match(await text(portal("portal-note")), /1 account created/);
await page.waitForFunction(() => /1 person in “On paper”: 1 with an account, 0 without/.test(document.querySelector('[data-testid="portal-scope"]')?.textContent ?? ""));
assert.equal(await page.isDisabled(portal("portal-create-list")), true);
ok("one button creates accounts for everyone in the list; a person with no address gets a link shown once");

/* people WITH an address, where email is not set up: accounts are made, and the page says no invitation went */
await page.selectOption(portal("portal-list"), "Wave 1");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="portal-row"]').length === 5);
await page.click(portal("portal-create-list"));
await page.waitForFunction(() => /5 accounts created/.test(document.querySelector('[data-testid="portal-note"]')?.textContent ?? ""));
assert.match(await text(portal("portal-note")), /5 skipped: Email is not set up/i);
assert.equal(await page.$(portal("portal-handover")).then(async (h) => (h ? /Ada/.test(await h.textContent()) : false)), false, "a link for a person with an email address was shown to the researcher");
ok("with email not set up, accounts are created and the page says plainly that no invitation was sent");

await page.selectOption(portal("portal-list"), "");
await page.check(portal("portal-no-account"));
await page.waitForFunction(() => document.querySelectorAll('[data-testid="portal-row"]').length === 4);
ok("“only people with no account yet” narrows the table to those still waiting");

/* the less common actions are still there, behind one line */
await page.uncheck(portal("portal-no-account"));
await page.waitForFunction(() => document.querySelectorAll('[data-testid="portal-row"]').length === 10);
assert.equal(await page.isVisible(portal("portal-suspend")), false);
await page.click(`${portal("portal-more")} summary`);
await page.getByLabel("Select Jo Paper").check();
await page.click(portal("portal-suspend"));
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="portal-row"]')].some((r) => /Jo Paper/.test(r.textContent) && /Paused/.test(r.textContent)));
for (const id of ["portal-lock", "portal-reopen", "portal-access", "portal-password", "portal-invite"]) assert.ok(await page.$(portal(id)), `${id} is gone`);
ok("pause, lock, reopen, dates, attempts and first password are all still there under More actions");

/* ---------------------------------------------------------------- 6. a phone */
await page.setViewportSize({ width: 390, height: 800 });
await page.click(portal("portal-add-people"));
await page.waitForSelector(portal("ds-manual"));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px at 390px`);
ok("nothing scrolls sideways at phone width");

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
ok("no script errors");
console.log(`\n${pass} checks passed`);
await browser.close();
