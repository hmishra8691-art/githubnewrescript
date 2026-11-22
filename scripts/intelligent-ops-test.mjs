/**
 * INTELLIGENT MODE AS A RESEARCH-OPERATIONS AGENT, FROM THE OUTSIDE (2026-11-22).
 *
 * In a real browser, in the full Studio: attach a file of people, say what to do in a sentence, read the card
 * (how each column was read and why, what needs a look, the steps and their reasons), confirm, and check on the
 * platform's own routes that it happened — then the same for lists that already exist, portal settings, pausing
 * access, a status question, and the things the agent deliberately only guides to.
 *
 * Files of different shapes on purpose: a CSV whose headings are nobody's convention, an Excel workbook with the
 * name split in two and the columns in an awkward order, a file with two email columns (a question, not a guess),
 * and a file that identifies nobody.
 *
 * It runs on /sandbox with no database: the routes keep the list in memory (the CHECKS and DECISIONS are the
 * product's own code; the storage is not). No model is called anywhere in this suite, and it asserts that.
 *
 *   node scripts/intelligent-ops-test.mjs      (needs the Studio on :3000, freshly started, no database configured)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const BASE = "http://localhost:3000";
const api = (p) => `${BASE}/api/surveys/sandbox/${p}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 120)} (${r.failure()?.errorText})`));
const modelCalls = [];
page.on("request", (r) => { if (/\/api\/(?:copilot\/turn|ai\/)/.test(r.url())) modelCalls.push(r.url()); });
/*
 * ONLY THE ROUTES THIS SUITE IS ABOUT REACH THE SERVER. A development server compiles every route it is asked for
 * and keeps it in memory; the Studio asks for dozens on opening (tasks, documents, billing, notifications…), which
 * is more than the build machine has. Those answer 401 here, as most already do for the sandbox, and the Studio
 * carries on without them. The respondent and portal routes — everything the agent uses — are real.
 */
await page.route("**/api/**", (route) => (/\/api\/surveys\/sandbox\/(?:respondents|portal)(?:[/?]|$)/.test(route.request().url()) ? route.continue() : route.fulfill({ status: 401, contentType: "application/json", body: "{}" })));
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const t = (id) => `[data-testid="${id}"]`;
const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();

const say = async (message) => {
  const n = (await page.$$(t("cp-turn"))).length;
  await page.fill(t("iq-input"), message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const x = document.querySelectorAll('[data-testid="cp-turn"]'); return x.length > k && x[x.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 90000 });
  return (await page.$$(t("cp-turn"))).at(-1);
};
const ops = async (turn) => { const c = await turn.$(t("cp-ops")); assert.ok(c, `no operations card: ${clean(await turn.textContent()).slice(0, 300)}`); return c; };
const status = async (card, want) => assert.equal(await card.getAttribute("data-status"), want, clean(await card.textContent()).slice(0, 600));
/* innerText, so table cells and list items are separated the way a reader sees them */
const within = async (card, id) => { const el = await card.$(t(id)); return el ? clean(await el.evaluate((e) => e.innerText)) : ""; };
const attach = async (name, mimeType, buffer) => {
  await page.setInputFiles(t("cp-people-file"), { name, mimeType, buffer });
  await page.waitForFunction((n) => (document.querySelector('[data-testid="cp-people-chip"]')?.textContent ?? "").includes(n), name);
};
const confirm = async (card) => {
  await (await card.$(t("cp-ops-confirm"))).click();
  await page.waitForFunction((el) => ["done", "failed"].includes(el.getAttribute("data-status")), card, { timeout: 90000 });
  const st = await card.getAttribute("data-status");
  if (st !== "done") console.log(`  (card: ${clean(await card.textContent()).slice(0, 600)})`);
  return st;
};
/* a development server restarts itself when it runs short of memory while compiling: one retry rides over that */
const lists = async () => { for (let i = 0; ; i++) { try { return await page.request.get(api("portal?limit=500")).then((r) => r.json()); } catch (e) { if (i >= 2) throw e; await page.waitForTimeout(8000); } } };

await page.goto(`${BASE}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
assert.equal((await lists()).total, 0, "the sandbox list is not empty: restart the Studio before running this suite");
await openTab(page, "Questions");
await switchMode(page, "intelligent");
await page.waitForSelector(t("intelligent-view"));

/* ---------------------------------------------------------------- 1. the attach menu offers a people list */
await page.click(t("iq-attach"));
assert.match(clean(await page.textContent(t("iq-attach-people"))), /People list.*accounts.*invitations/i);
await page.click(t("iq-attach"));
ok("the paperclip offers “People list”, beside documents, questionnaires and quota sheets");

/* ---------------------------------------------------------------- 2. the instruction without a file */
{
  const card = await ops(await say("Upload this file and use it for respondent account creation and email invitations."));
  await status(card, "needs");
  assert.match(await within(card, "cp-ops-lines"), /no file of people attached.*paperclip.*People list/i);
  assert.equal(await card.$(t("cp-ops-confirm")), null);
  ok("with nothing attached it understands the request and says what is missing, instead of guessing");
}

/* ---------------------------------------------------------------- 3. a CSV in nobody's convention → list, accounts, invitations */
const csv = [
  "Kontakt,Wer,Abteilung,Personalnummer",
  "ada@example.com,Ada Lovelace,Ops,P-1",
  "bob@example.com,Bob Stone,Ops,P-2",
  "not-an-email,Cy Young,HR,P-3",
  "ADA@example.com,Ada Again,Ops,p-1",
  ",,HR,",
  ",Dee Paper,HR,P-4",
].join("\n");
await attach("spring_cohort.csv", "text/csv", Buffer.from(csv));
{
  const card = await ops(await say("Upload this file and use it for respondent account creation and email invitations."));
  await status(card, "preview");
  const lines = await within(card, "cp-ops-lines");
  assert.match(lines, /I read 6 rows from spring_cohort\.csv: 4 people to add to the live list, as “spring cohort” \(a new list\)/, lines);
  assert.match(lines, /Left out: 1 repeated in the file, 1 row with nobody in/);
  /* the columns, read from what is IN them, each with its reason */
  assert.match(await within(card, "cp-ops-col-Kontakt"), /Kontakt Email its values are email addresses/);
  assert.match(await within(card, "cp-ops-col-Wer"), /Wer Name its values read like people's names/);
  assert.match(await within(card, "cp-ops-col-Personalnummer"), /Extra information/, "a heading it cannot read is not guessed to be an ID");
  assert.match(await within(card, "cp-ops-col-Abteilung"), /Extra information/);
  assert.match(await within(card, "cp-ops-problems"), /Row 4.*not-an-email/);
  /* the plan: portal on (it is off), add, accounts — each with why */
  const steps = await card.$$eval('[data-testid="cp-ops-plan"] li', (ls) => ls.map((l) => [l.dataset.step, l.dataset.state, l.textContent.replace(/\s+/g, " ")]));
  assert.deepEqual(steps.map((s) => s.slice(0, 2)), [["portal_on", "todo"], ["add", "todo"], ["accounts", "todo"]]);
  assert.match(steps[0][2], /accounts belong to the portal/);
  assert.match(steps[2][2], /Create portal accounts for 4 people and send their invitations/);
  assert.match(steps[1][2], /nobody gets a second link/);
  const notes = clean((await card.$$eval(t("cp-ops-note"), (ns) => ns.map((n) => n.textContent))).join(" | "));
  assert.match(notes, /portal is off for this survey/);
  assert.match(notes, /Email is not set up on this installation/);
  assert.match(notes, /1 email address looks wrong/);
  assert.equal(await page.$(t("cp-people-chip")), null, "the file's chip stayed after it was used");
  assert.equal((await lists()).total, 0, "the preview wrote to the list");
  ok("a file with unfamiliar headings: columns read from their contents with reasons, problems by row, a plan with reasons, nothing written");

  if (process.env.OPS_SHOT) await card.screenshot({ path: `${process.env.OPS_SHOT}-preview.png` });
  assert.equal(clean(await (await card.$(t("cp-ops-confirm"))).textContent()), "Confirm: add 4 people, create accounts, send invitations");
  assert.equal(await confirm(card), "done");
  const done = await card.$$eval('[data-testid="cp-ops-plan"] li', (ls) => ls.map((l) => [l.dataset.step, l.dataset.state, l.textContent.replace(/\s+/g, " ")]));
  assert.deepEqual(done.map((s) => s[1]), ["done", "done", "done"]);
  assert.match(done[1][2], /4 people added to “spring cohort”/);
  assert.match(done[2][2], /4 accounts; 0 invitations emailed, 2 links to hand over/);
  const said = await within(card, "cp-ops-lines");
  assert.match(said, /Added 4 people to “spring cohort”/);
  assert.match(said, /Created 4 accounts/);
  assert.match(said, /Not done — 2: Email is not set up on this installation/, said);
  /* the people with no usable address (none at all, or one that is not an address): a link each, shown once */
  const hand = await within(card, "cp-ops-handover");
  assert.match(hand, /Dee Paper.*RSP-.*\/portal\/invitation#token=/);
  assert.doesNotMatch(hand, /Ada Lovelace/, "a link for a person with an email address was shown");
  assert.match(await within(card, "cp-ops-next"), /Save and publish/i);
  const now = await lists();
  assert.equal(now.total, 4);
  assert.deepEqual(now.lists, [{ name: "spring cohort", people: 4, withAccount: 4 }]);
  assert.equal(now.rows.filter((r) => r.email === "ada@example.com").length, 1);
  ok("on Confirm it adds the people, creates the accounts, reports each step, what was not done and why, and the next action");

  if (process.env.OPS_SHOT) await card.screenshot({ path: `${process.env.OPS_SHOT}-done.png` });
  await (await card.$(t("cp-ops-noted"))).click();
  await page.waitForFunction((el) => !el.querySelector('[data-testid="cp-ops-handover"]'), card);
  ok("the hand-over link goes once it is noted");
}

/* the portal was switched on IN THE SURVEY (an edit like any other), which the Distribution tab shows */
{
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const def = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  assert.equal(def.portal?.enabled, true);
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector(t("intelligent-view"));
  ok("turning the portal on is a change to the survey itself, not a hidden side effect");
}

/* ---------------------------------------------------------------- 4. an Excel workbook: split names, awkward order, a named new list, no accounts */
{
  const tpl = await page.request.get(api("respondents/template?format=xlsx"));
  /* the platform's own template is the workbook at hand in a browser suite: it proves the Excel path end to end */
  await attach("respondent-list-template.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await tpl.body());
  const card = await ops(await say("Import this spreadsheet into a new list called Wave 2"));
  await status(card, "failed");
  assert.match(await within(card, "cp-ops-error"), /none of those rows has an email, an id or a name|nobody/i);
  assert.match(await within(card, "cp-ops-col-email"), /email Email/);
  assert.match(await within(card, "cp-ops-col-id"), /id Their ID/);
  ok("an Excel workbook is read too; the unfilled template adds nobody and says so");
}
{
  const tsv = ["Surname\tFirst name\tWork e-mail\tStaff no.\tSite", "Hopper\tGrace\tgrace@example.com\tS-10\tNorth", "Turing\tAlan\talan@example.com\tS-11\tSouth", "Lovelace\tAda\tada@example.com\tS-12\tNorth"].join("\n");
  await attach("wave2.tsv", "text/tab-separated-values", Buffer.from(tsv));
  const card = await ops(await say("Import this spreadsheet into a new list called Wave 2"));
  await status(card, "preview");
  assert.match(await within(card, "cp-ops-lines"), /3 people to add to the live list, as “Wave 2” \(a new list\)/);
  assert.match(await within(card, "cp-ops-col-First name"), /Name the first name; joined with the last name/);
  assert.match(await within(card, "cp-ops-col-Surname"), /Name the last name; joined after the first name/);
  assert.match(await within(card, "cp-ops-col-Staff no."), /Their ID its heading says it is an ID, and every value is different/);
  const steps = await card.$$eval('[data-testid="cp-ops-plan"] li', (ls) => ls.map((l) => l.dataset.step));
  assert.deepEqual(steps, ["add"], "accounts were not asked for and must not be planned");
  assert.equal(await confirm(card), "done");
  const rows = (await lists()).rows.filter((r) => r.list === "Wave 2");
  assert.deepEqual(rows.map((r) => [r.name, r.externalId]).sort(), [["Ada Lovelace", "S-12"], ["Alan Turing", "S-11"], ["Grace Hopper", "S-10"]]);
  assert.match(await within(card, "cp-ops-next"), /create accounts for Wave 2/i);
  ok("split names are joined first-then-last, an ID is recognised by heading and content, and only what was asked is done");
}

/* ---------------------------------------------------------------- 5. two email columns: a question, not a guess */
{
  const two = ["name,email,manager email", "Eve Adams,eve@example.com,boss@example.com", "Fay Brown,fay@example.com,chief@example.com"].join("\n");
  await attach("managers.csv", "text/csv", Buffer.from(two));
  const card = await ops(await say("Add these people to “Leads”"));
  const q = await card.$(t("cp-ops-question-email"));
  assert.ok(q, "no question about the two email columns");
  assert.match(clean(await q.textContent()), /2 columns hold email addresses\. Which one should invitations go to\?/);
  assert.equal(await q.$eval("select", (s) => s.value), "email");
  /* the researcher means the other one */
  await (await q.$("select")).selectOption("manager email");
  await page.waitForFunction((el) => /manager email Email as you set it/.test(el.querySelector('[data-testid="cp-ops-col-manager email"]')?.innerText.replace(/\s+/g, " ") ?? ""), card);
  assert.match(await within(card, "cp-ops-col-email"), /email Extra information/);
  assert.equal(await confirm(card), "done");
  assert.deepEqual((await lists()).rows.filter((r) => r.list === "Leads").map((r) => r.email).sort(), ["boss@example.com", "chief@example.com"]);
  ok("when two columns could be the email it asks, shows its default, and uses the researcher's answer");
}
{
  await attach("teams.csv", "text/csv", Buffer.from("Team,Site\nOps,North\nHR,South"));
  const card = await ops(await say("Add these people to the list"));
  assert.match(clean(await (await card.$(t("cp-ops-question-email"))).textContent()), /No column looks like an email address or an ID/);
  assert.equal(await card.$(t("cp-ops-confirm")), null, "it offered to add people it cannot tell apart");
  ok("a file that identifies nobody is not added: it asks which column tells people apart");
}

/* ---------------------------------------------------------------- 6. lists that already exist */
{
  const card = await ops(await say("Create accounts for the Wave 2 list"));
  assert.match(await within(card, "cp-ops-lines"), /“Wave 2” has 3 people: 0 with a portal account, 3 without/);
  assert.match(clean((await card.$$eval(t("cp-ops-note"), (n) => n.map((x) => x.textContent))).join(" ")), /No invitation is sent/);
  assert.equal(await confirm(card), "done");
  assert.deepEqual((await lists()).lists.find((l) => l.name === "Wave 2"), { name: "Wave 2", people: 3, withAccount: 3 });
  assert.equal(await card.$(t("cp-ops-handover")), null);
  ok("“create accounts for the Wave 2 list” reuses the list already there, and sends nothing it was not asked to");

  const again = await ops(await say("Create accounts for the Wave 2 list"));
  await status(again, "answered");
  assert.match(await within(again, "cp-ops-lines"), /Everyone there already has an account/);
  const none = await ops(await say("Create accounts for “Autumn”"));
  assert.match(await within(none, "cp-ops-error"), /no list called “Autumn”\. Your lists: spring cohort, Wave 2, Leads/);
  ok("it does not repeat work already done, and names the lists when one does not exist");
}
{
  const card = await ops(await say("How many people still have no account?"));
  const lines = await within(card, "cp-ops-lines");
  assert.match(lines, /9 people on the live list: 7 with a portal account, 2 without/);
  assert.match(lines, /Leads: 2 people, 0 with an account, 2 without/);
  ok("a status question is answered from the lists themselves");
}

/* ---------------------------------------------------------------- 7. pausing access for a list */
{
  const card = await ops(await say("Pause access for the Wave 2 list"));
  assert.match(await within(card, "cp-ops-lines"), /Pause access to this survey for 3 people on “Wave 2”\. It applies immediately and can be reversed/);
  assert.equal(await confirm(card), "done");
  assert.deepEqual((await lists()).rows.filter((r) => r.suspended).map((r) => r.list), ["Wave 2", "Wave 2", "Wave 2"]);
  assert.match(await within(card, "cp-ops-next"), /restore access for Wave 2/i);
  const back = await ops(await say("Restore access for Wave 2"));
  assert.equal(await confirm(back), "done");
  assert.equal((await lists()).rows.filter((r) => r.suspended).length, 0);
  ok("pause and restore act on a whole list after a preview, and say how to reverse it");
}

/* ---------------------------------------------------------------- 8. portal settings in a sentence */
{
  const card = await ops(await say("Let respondents see their scores and how they changed over time, and allow them to change their answers for 48 hours"));
  assert.equal(await card.getAttribute("data-op"), "settings");
  assert.match(await within(card, "cp-ops-change-show.scores"), /Respondents can see their scores off on/);
  assert.match(await within(card, "cp-ops-change-editing"), /never for 48 hours/);
  const notes = clean((await card.$$eval(t("cp-ops-note"), (n) => n.map((x) => x.textContent))).join(" | "));
  assert.match(notes, /Change over time needs two things on/);
  assert.match(notes, /No score is defined yet/);
  assert.equal(await confirm(card), "done");
  assert.match(await within(card, "cp-ops-next"), /Save and publish/i);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const def = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  assert.deepEqual([def.portal.show.scores, def.portal.show.trends, def.portal.show.answers, def.portal.editing.mode, def.portal.editing.windowHours], [true, true, true, "window", 48]);
  await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector(t("intelligent-view"));
  ok("settings: each change shown as now → after, what depends on what is said first, and the survey is changed only on Confirm");

  const tplCard = await ops(await say("Use the patient-reported outcomes template for the portal and give respondents a projection"));
  assert.match(await within(tplCard, "cp-ops-change-template"), /standard portal Patient-reported outcomes/);
  assert.match(await within(tplCard, "cp-ops-change-show.projection"), /template always keeps this off/);
  ok("a template's fixed rule is said before it is applied: the projection it would refuse is flagged");
}

/* ---------------------------------------------------------------- 9. what it only guides to, and why */
{
  const card = await ops(await say("Where do I answer a privacy request from a respondent?"));
  const g = await within(card, "cp-ops-guide");
  assert.match(g, /Where Distribution → Respondent portal → Privacy requests/i);
  assert.match(g, /Why I do not do this for you/i);
  assert.match(g, /Do what was asked first/);
  assert.equal(await card.$(t("cp-ops-confirm")), null);
  const pw = await ops(await say("Reset the password for Dee Paper's account"));
  assert.match(await within(pw, "cp-ops-guide"), /must not pass through a chat/);
  const cap = await ops(await say("What can you do with the respondent portal?"));
  const c = await within(cap, "cp-ops-capabilities");
  assert.match(c, /I carry these out, after you confirm.*Create portal accounts and send invitations/i);
  assert.match(c, /I tell you where and why.*Privacy requests and consent/i);
  ok("privacy requests, passwords and the like are explained step by step with the reason, never run from a sentence");

  await (await card.$(t("cp-ops-open"))).click();
  await page.waitForSelector(t("ds-guide"), { timeout: 60000 });
  await page.waitForSelector(t("ds-list-Wave 2"));
  ok("“Open Distribution” goes to the screen, where the agent's lists are the manual screen's lists");
  await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector(t("intelligent-view"));
}

/* ---------------------------------------------------------------- 10. it leaves the questionnaire's sentences alone */
{
  assert.deepEqual(modelCalls, [], `a model was called by an operations request: ${modelCalls.join(", ")}`);
  const turn = await say("Add a question asking employees for their email address");
  assert.equal(await turn.$(t("cp-ops")), null, "a questionnaire edit was read as an operations request");
  ok("a sentence about the questionnaire still goes to the questionnaire's own reader");
}

ok("no model was called by any operations request: every reading, check and action above is the platform's own code");
assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")} — failed requests: ${failedRequests.join(" ; ")}`);
ok("no script errors");
console.log(`\nALL ${pass} CHECKS PASSED`);
await browser.close();
