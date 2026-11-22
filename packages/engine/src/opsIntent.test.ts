import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS_CAPABILITIES, describeOpsRequest, interpretOpsRequest, opsCapability, portalSettingLabel, type OpsContext, type OpsRequest } from "./opsIntent.js";
import { PORTAL_TEMPLATES } from "./portalTemplates.js";

const templates = PORTAL_TEMPLATES.map((t) => ({ id: t.id, name: t.name }));
const ctx = (over: Partial<OpsContext> = {}): OpsContext => ({ hasFile: false, lists: ["Wave 1", "Wave 10", "Night shift"], templates, ...over });
const read = (s: string, over: Partial<OpsContext> = {}) => interpretOpsRequest(s, ctx(over));
const people = (s: string, over: Partial<OpsContext> = {}) => { const r = read(s, over); assert.equal(r?.op, "people", `not a people request: ${s} → ${JSON.stringify(r)}`); return r as Extract<OpsRequest, { op: "people" }>; };
const settings = (s: string) => { const r = read(s); assert.equal(r?.op, "settings", `not a settings request: ${s} → ${JSON.stringify(r)}`); return Object.fromEntries((r as Extract<OpsRequest, { op: "settings" }>).changes.map((c) => [c.key, c.hours ? `${c.value}:${c.hours}` : c.value])); };

test("the owner's own sentences: a file, accounts and invitations in one instruction", () => {
  const a = people("Upload this file and use it for respondent account creation and email invitations.", { hasFile: true });
  assert.deepEqual([a.add, a.accounts, a.invite, a.source, a.missingFile, a.environment], [true, true, true, "file", false, "LIVE"]);
  const b = people("I want to invite these respondents, create their accounts, and use the uploaded email list for this project.", { hasFile: true });
  assert.deepEqual([b.add, b.accounts, b.invite, b.source], [true, true, true, "file"]);
  /* the same words with nothing attached: understood, and the file is what is missing */
  const c = people("Upload this file and create accounts for everyone in it");
  assert.deepEqual([c.add, c.missingFile], [true, true]);
});

test("lists: an existing one by name (the longest name wins), a new one by what it is called", () => {
  assert.deepEqual([people("Create accounts for the Wave 10 list and send the invitations").list, people("create accounts for wave 1").list], ["Wave 10", "Wave 1"]);
  const existing = people("Create accounts for the Night shift list");
  assert.deepEqual([existing.source, existing.add, existing.listIsNew, existing.invite], ["list", false, false, false]);
  const fresh = people("Import this spreadsheet into a new list called Spring Cohort", { hasFile: true });
  assert.deepEqual([fresh.list, fresh.listIsNew, fresh.accounts], ["Spring Cohort", true, false]);
  assert.equal(people("Add these people to “Pilot group” and invite them", { hasFile: true }).list, "Pilot group");
  assert.equal(people("Create accounts for everyone").source, "everyone");
  assert.equal(people("upload this file to the test list", { hasFile: true }).environment, "TEST");
});

test("an invitation implies an account; inviting a colleague is not this", () => {
  const r = people("Send invitations to the Wave 1 list");
  assert.deepEqual([r.accounts, r.invite, r.list], [true, true, "Wave 1"]);
  assert.equal(read("Invite a colleague to review the survey"), null);
  assert.equal(read("invite my manager as an editor"), null);
});

test("sentences about the questionnaire are left to the questionnaire's own reader", () => {
  for (const s of ["Add a question about email addresses", "Add an email question for respondents", "Rename the block for employees", "Show respondents a progress bar",
    "Show them their score at the end of the survey", "Remove the demographics page", "Compare Q3 by Q5", "Make the list of brands longer", "Translate this to French", "Add a list of brands"]) {
    assert.equal(read(s), null, `${s} → ${JSON.stringify(read(s))}`);
  }
  /* even with a people file attached */
  assert.equal(read("Add a question asking employees for their email", { hasFile: true }), null);
});

test("settings: each clause has its own yes or no", () => {
  assert.deepEqual(settings("Turn on the portal and let respondents see their scores and how they changed over time"), { enabled: true, "show.scores": true, "show.trends": true });
  assert.deepEqual(settings("Let participants see their answers but don't show them how they compare with others"), { "show.answers": true, "show.comparison": false });
  assert.deepEqual(settings("Allow respondents to change their answers for 48 hours"), { editing: "window:48", "show.answers": true });
  assert.deepEqual(settings("Respondents can change their answers for two days"), { editing: "window:48", "show.answers": true });
  assert.deepEqual(settings("Don't let respondents edit their answers"), { editing: "none" });
  assert.deepEqual(settings("Let employees correct their responses"), { editing: "until_locked", "show.answers": true });
  assert.deepEqual(settings("Give each respondent two attempts and show the badges they earned"), { maxAttempts: 2, "show.rewards": true });
  assert.deepEqual(settings("Turn off the respondent portal"), { enabled: false });
  assert.deepEqual(settings("Let respondents write to our team, and hide their earlier attempts"), { messages: true, "show.history": false });
  assert.deepEqual(settings("Give respondents a few sentences about their results and a projection"), { "show.insights": true, "show.projection": true });
});

test("a template is chosen only when the words single one out", () => {
  assert.deepEqual(settings("Use the employee engagement template for the portal"), { template: PORTAL_TEMPLATES.find((t) => t.name === "Employee engagement")!.id });
  assert.deepEqual(settings("Apply the student assessment template for students"), { template: PORTAL_TEMPLATES.find((t) => t.name === "Student assessment")!.id });
  assert.deepEqual(settings("Remove the template from the portal"), { template: null });
  /* "assessment" is in three names: nothing is singled out, so nothing is chosen */
  const vague = read("Use the assessment template for the portal");
  assert.ok(!vague || vague.op !== "settings" || !(vague as Extract<OpsRequest, { op: "settings" }>).changes.some((c) => c.key === "template"));
});

test("pause, restore, lock, unlock — for a list or for everyone", () => {
  assert.deepEqual(read("Pause access for the Night shift list"), { op: "access", text: "Pause access for the Night shift list", action: "suspend", list: "Night shift" });
  assert.equal((read("Restore access for everyone") as Extract<OpsRequest, { op: "access" }>).action, "reactivate");
  assert.equal((read("Lock the answers for Wave 1 respondents") as Extract<OpsRequest, { op: "access" }>).action, "lock");
  assert.equal((read("unlock everyone's answers") as Extract<OpsRequest, { op: "access" }>).action, "unlock");
  /* "until I lock them" is a setting, not an order to lock */
  assert.equal(read("Let respondents change their answers until I lock them")?.op, "settings");
});

test("questions are answered, not run; some things are never run from a sentence", () => {
  assert.deepEqual(read("How many people still have no account?")?.op, "status");
  assert.deepEqual(read("Which lists do I have?")?.op, "status");
  const guide = (s: string) => { const r = read(s); assert.equal(r?.op, "guide", `${s} → ${JSON.stringify(r)}`); return (r as Extract<OpsRequest, { op: "guide" }>).capability; };
  assert.equal(guide("Where do I answer a privacy request from a respondent?"), "privacy");
  assert.equal(guide("How do I give someone a first password for the portal?"), "accounts.password");
  assert.equal(guide("Reset the password for Jo's account"), "accounts.password");
  assert.equal(guide("Send reminders to the night shift people"), "reminders");
  assert.equal(guide("Open this respondent's results"), "individual");
  /* a personal survey link is not a portal invitation: asked or told, it is explained, never turned into accounts */
  assert.equal(guide("Send the survey links to the Wave 1 list"), "links.send");
  assert.equal(guide("How do I download the links for my respondents?"), "links.send");
  assert.equal(guide("How do I define a score for respondents?"), "scores.define");
  assert.equal(guide("Where is the template for the respondent file?"), "people.template");
  assert.equal(guide("How do I create accounts for people?"), "accounts.create");
  assert.equal(read("What can you do with the respondent portal?")?.op, "capabilities");
});

test("the catalogue covers every phase, and every entry can be followed by hand", () => {
  assert.deepEqual([...new Set(OPS_CAPABILITIES.map((c) => c.phase))].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(OPS_CAPABILITIES.map((c) => c.id)).size, OPS_CAPABILITIES.length);
  for (const c of OPS_CAPABILITIES) {
    assert.ok(c.steps.length >= 3 && c.where.length >= 1 && c.what.length > 40 && c.then.length > 10, c.id);
    if (c.agent === "guides") assert.ok(c.whyGuided && c.whyGuided.length > 30, `${c.id} does not say why it is only guided`);
    /* the sentence offered as an example is understood, and leads to this function or to a request that carries it out */
    const r = interpretOpsRequest(c.say, ctx({ hasFile: c.id === "people.add" }));
    assert.ok(r, `${c.id}: “${c.say}” is not understood`);
    if (c.agent === "guides") assert.deepEqual([r!.op, (r as { capability?: string }).capability], ["guide", c.id], c.id);
    else assert.notEqual(r!.op, "guide", `${c.id}: “${c.say}” should be carried out, not explained`);
  }
  assert.equal(opsCapability("nope"), null);
});

test("requests describe themselves; every setting has words", () => {
  assert.equal(describeOpsRequest(people("Upload this file to a new list called Spring Cohort, create accounts and invite them", { hasFile: true })), "Add the people in the attached file to a new list, “Spring Cohort”, then create portal accounts, then send the invitations.");
  assert.equal(describeOpsRequest(read("Pause access for the Night shift list")!), "Pause access for “Night shift”.");
  for (const k of ["enabled", "show.answers", "show.history", "show.scores", "show.bands", "show.comparison", "show.trends", "show.insights", "show.projection", "show.aiSummary", "show.rewards", "messages", "editing", "maxAttempts", "template", "identity"] as const) assert.ok(portalSettingLabel(k).length > 5);
});
