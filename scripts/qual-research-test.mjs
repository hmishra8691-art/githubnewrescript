/**
 * QUALITATIVE RESEARCH (2026-10-18) — moderated interviews, focus groups and AI-assisted coding,
 * in the browser (docs/QUALITATIVE-RESEARCH-2026-10-18.md).
 *
 * The model is the stand-in (`window.__rescriptCopilotFake` for Intelligent Mode,
 * `window.__rescriptQualFake` for the coding call, both honoured only against the fake provider);
 * everything after the reply is real: the copilot route and the engine's gate, the preview and Apply,
 * the Qualitative workspace, the sandbox branches of `/api/surveys/sandbox/qual/coding` (the real
 * reader, substring check and merge) and `/qual/export` (the real Word editions, checked here with
 * the same `checkDocx` the route uses).
 *
 *   1  “Create a 45-minute interview guide…” → create_qual_guide → Apply → Research Tools →
 *      Qualitative shows the guide; Export guide (.docx) is a valid Word document with its content
 *   2  “Add a probe and a question to the triggers section” → update_qual_guide (a PATCH) → Apply →
 *      only that section changed
 *   3  “Make it a focus-group discussion guide” → create_qual_guide replace → ground rules → .docx
 *   4  a transcript imported ("[00:00:05] Moderator: …") → segments with speakers and timestamps;
 *      speakers assigned to participant segments
 *   5  AI codebook proposal (stand-in reply with one paraphrased “quote” and one moderator turn) →
 *      both rejected and listed; every stored excerpt is the exact span of its segment
 *   6  accept, merge two codes, rename a theme, code a passage by hand → history; two coders → kappa
 *   7  the theme table by participant segment, labelled "frequency is not importance"
 *   8  the qualitative report .docx
 *   9  access: a member without Data access gets 403 from the transcripts routes. The Studio here has
 *      no database, so this step runs only when QUAL_TEST_PROJECT and QUAL_TEST_COOKIE_NODATA (a
 *      session cookie of a member whose Data module is None) are set; otherwise it checks that the real
 *      route never answers an anonymous caller with data, and the 403 is proven by
 *      apps/studio/lib/qual/qualAccess.test.ts (the guard's decision) and scripts/qual-research-sql-test.sql.
 *
 *   pnpm --filter @rescript/schema --filter @rescript/engine --filter @rescript/analytics build
 *   STUDIO_URL=http://localhost:3000 node scripts/qual-research-test.mjs     (studio with AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions } from "../packages/engine/dist/index.js";
import { parseTranscript } from "../packages/analytics/dist/index.js";
import { checkDocx } from "../packages/analytics/dist/export/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const EMPTY = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "QS", title: "Broadband switching", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});

/* ------------------------------------------------------------ the stand-in replies, checked against the engine first */
const IDI = "Create a 45-minute interview guide about why customers switch broadband provider";
const IDI_REPLY = {
  kind: "proposal", reply: "GENERATED (awaiting your approval): a 45-minute in-depth interview guide for a human moderator — Rescript plans and records the sessions; it does not run them live.",
  actions: [{
    op: "create_qual_guide", kind: "interview", title: "Why customers switch broadband", durationMinutes: 45,
    objectives: ["Understand what triggers switching", "Learn how customers compare providers"],
    protocol: "One-to-one remote interviews moderated by a senior researcher; audio recorded with consent.",
    screening: ["Pays the household broadband bill", "Exclude: works in telecoms or market research"],
    consent: { statement: "Taking part is voluntary; you may stop at any time.", recordingDisclosure: "The interview is recorded (audio) for the research team only and deleted after 12 months." },
    segments: [{ name: "Switchers", target: 6 }, { name: "Stayers", target: 6 }], sessionPlan: { sessions: 12, participantsPerSession: 1, mode: "remote" },
    sections: [
      { title: "Introduction", kind: "opening", minutes: 5, script: "Thank you for joining. There are no right or wrong answers. May I record?" },
      { title: "Switching triggers", minutes: 20, questions: [{ text: "Tell me about the last time you thought about changing provider.", probes: ["What happened next?"], conditionalProbes: [{ ifMentions: "price", ask: "What would a fair price be?" }] }] },
      { title: "Comparing providers", minutes: 15, questions: ["When you compare providers, what do you look at first?"] },
      { title: "Close", kind: "closing", minutes: 5, questions: ["Is there anything else you would like to add?"] },
    ],
  }],
};
const EDIT = "Add a probe about who else was involved, and a question about what would have made them stay, to the triggers section";
const EDIT_REPLY = { kind: "proposal", reply: "GENERATED: one probe and one question added to “Switching triggers”; nothing else changes.", actions: [{ op: "update_qual_guide", sections: [{ target: "Switching triggers", updateQuestions: [{ target: "s2q1", addProbes: ["Who else was involved in the decision?"] }], addQuestions: ["What would have made you stay?"] }] }] };
const FG = "Actually, make it a 90-minute focus-group discussion guide instead";
const FG_REPLY = { kind: "proposal", reply: "GENERATED: a 90-minute focus-group discussion guide (replaces the interview guide).", actions: [{ ...IDI_REPLY.actions[0], replace: true, kind: "focus_group", durationMinutes: 90, groundRules: ["One person speaks at a time", "There are no right or wrong answers", "What is said here stays here"], sessionPlan: { sessions: 2, participantsPerSession: 6, mode: "in_person" }, sections: [...IDI_REPLY.actions[0].sections.slice(0, 3), { title: "Card sort", kind: "exercise", minutes: 20, exercise: { title: "Rank the benefits", instructions: "Sort the cards from most to least important", materials: ["10 benefit cards"] } }, IDI_REPLY.actions[0].sections[3]] }] };
const engineRun = (def, actions) => { const c = coerceSurveyActions(actions); assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected)); const r = applySurveyActions(def, c.actions); assert.deepEqual(r.errors, [], JSON.stringify(r.errors)); return r.def; };
const afterIdi = engineRun(EMPTY, IDI_REPLY.actions);
const afterEdit = engineRun(afterIdi, EDIT_REPLY.actions);
assert.deepEqual(afterEdit.qualStudy.sections[2], afterIdi.qualStudy.sections[2], "the fixture's patch leaves other sections alone");
const afterFg = engineRun(afterEdit, FG_REPLY.actions);
assert.equal(afterFg.qualStudy.kind, "focus_group");

const TRANSCRIPT = `[00:00:05] Moderator: What made you think about switching provider?
[00:00:12] Anna: The price went up twice last year and nobody explained why.
[00:00:30] Moderator: Anything else?
[00:00:34] Anna: The speed was awful every evening, so we left.
[00:01:02] Ben: For us the price is fine for what we get.
[00:01:20] Ben: Speed drops sometimes but it is tolerable.`;
const TURNS = parseTranscript(TRANSCRIPT).turns;
assert.equal(TURNS.length, 6);
const CODING_REPLY = {
  themes: [{ name: "Money" }, { name: "Network" }],
  codes: [{ name: "Price rise", definition: "the price went up", theme: "Money" }, { name: "Cost", definition: "talks about cost", theme: "Money" }, { name: "Slow speed", definition: "the connection is slow", theme: "Network" }],
  excerpts: [
    { segment: "S2", code: "Price rise", quote: "The price went up twice last year" },
    { segment: "S5", code: "Cost", quote: "the price is fine for what we get" },
    { segment: "S4", code: "Slow speed", quote: "The speed was awful every evening" },
    { segment: "S6", code: "Slow speed", quote: "Speed drops sometimes" },
    { segment: "S2", code: "Price rise", quote: "prices kept rising without explanation" },
    { segment: "S1", code: "Price rise", quote: "What made you think about switching provider?" },
  ],
};

/* ============================================================ the Studio */
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await switchMode(page, "studio").catch(() => {});
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
};
const readDef = async () => {
  await switchMode(page, "studio");
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  return SurveyDefinition.parse(JSON.parse(json));
};
const ask = async (text, reply) => {
  /* Intelligent Mode opens from the questionnaire, not from a Research Tools panel */
  await switchMode(page, "studio").catch(() => {});
  await goTab("Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  await page.evaluate((r) => window.__rescriptCopilotFake(r), [reply]);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 90000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 60000 });
  const refused = (body.validation?.results ?? []).filter((r) => !r.ok);
  assert.deepEqual(refused, [], "every action passes the engine's gate");
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const changes = await page.$eval('[data-testid="cp-changes"]', (e) => e.textContent);
  /* the review lists the guide change item by item, and the structure view shows the guide's sections */
  const rows = await page.$$eval('[data-testid="cp-row"]', (rs) => rs.map((r) => ({ category: r.dataset.category, kind: r.dataset.kind, text: r.textContent })));
  const guideRows = rows.filter((r) => r.category === "Qualitative guide");
  assert.ok(guideRows.length > 0, `the change list names the guide change: ${JSON.stringify(rows).slice(0, 400)}`);
  const outline = await page.$$eval('.cp-o-block', (bs) => bs.map((b) => b.textContent));
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(800);
  return { body, changes, guideRows, outline, def: await readDef() };
};
const openQual = async (tab) => {
  await switchMode(page, "studio").catch(() => {});
  await goTab("Qualitative");
  await page.waitForSelector('[data-testid="qual-panel"]');
  await page.click(`[data-testid="qual-tab-${tab}"]`);
};
const download = async (selector) => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click(selector)]);
  const buf = readFileSync(await d.path());
  const c = checkDocx(buf);
  assert.ok(c.ok, c.problems.join("; "));
  return { name: d.suggestedFilename(), c };
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(EMPTY);

console.log("\n1 — an interview guide from one sentence → Apply → the Qualitative workspace → Word");
{
  const { body, changes, guideRows, outline, def } = await ask(IDI, IDI_REPLY);
  /* 4 sections, 3 questions: the Introduction carries a script, not a question */
  assert.match(changes, /Create the interview guide: 4 sections, 3 questions/);
  assert.ok(guideRows.some((r) => r.kind === "added" && /section “Switching triggers”/.test(r.text) && /Tell me about the last time/.test(r.text)), JSON.stringify(guideRows).slice(0, 400));
  assert.ok(guideRows.some((r) => r.kind === "added" && /guide type/.test(r.text)));
  assert.ok(outline.some((t) => /Interview guide — Switching triggers \(20 min\)/.test(t)), outline.join(" | "));
  assert.match(JSON.stringify(body), /does not run them live/);
  assert.deepEqual(def.qualStudy, { ...afterIdi.qualStudy, updatedAt: def.qualStudy.updatedAt }, "the browser's replay is the engine's");
  assert.equal(def.questions.length, 0, "the moderated guide is not the questionnaire");
  await openQual("guide");
  await page.waitForSelector('[data-testid="qual-guide"][data-kind="interview"]');
  assert.deepEqual(await page.$$eval('[data-testid="qual-guide-section"]', (es) => es.map((e) => e.dataset.title)), ["Introduction", "Switching triggers", "Comparing providers", "Close"]);
  assert.match(await page.textContent('[data-testid="qual-guide"]'), /If they mention price → What would a fair price be\?/);
  const { name, c } = await download('[data-testid="qual-export-guide"]');
  assert.match(name, /Interview_Guide_\d{4}-\d{2}-\d{2}\.docx$/);
  for (const w of ["INTERVIEW GUIDE", "Understand what triggers switching", "If the participant mentions price → ask: What would a fair price be?", "The interview is recorded (audio)"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  ok(`create_qual_guide → Apply → 4 sections in the workspace → ${name} (${c.paragraphs} paragraphs, ${c.tables} tables)`);
}

console.log("\n2 — edit it from a sentence: a PATCH, only the named section changes");
{
  const { changes, guideRows, def } = await ask(EDIT, EDIT_REPLY);
  assert.match(changes, /Change guide section “Switching triggers”/);
  assert.deepEqual(guideRows.map((r) => r.kind), ["modified"], "one item: the triggers section, nothing else");
  assert.match(guideRows[0].text, /What would have made you stay\?/);
  assert.deepEqual(def.qualStudy.sections.map((s) => s.questions.map((q) => q.text)), afterEdit.qualStudy.sections.map((s) => s.questions.map((q) => q.text)));
  assert.deepEqual(def.qualStudy.sections[2], afterIdi.qualStudy.sections[2], "“Comparing providers” untouched");
  assert.deepEqual(def.qualStudy.sections[1].questions[0].probes, ["What happened next?", "Who else was involved in the decision?"]);
  await openQual("guide");
  assert.equal(await page.$$eval('[data-testid="qual-guide-section"][data-title="Switching triggers"] [data-testid="qual-guide-question"]', (e) => e.length), 2);
  ok("update_qual_guide → one probe and one question added; every other section byte-identical");
}

console.log("\n3 — a focus-group discussion guide (replace) → ground rules, an exercise → Word");
{
  const { changes, def } = await ask(FG, FG_REPLY);
  assert.match(changes, /focus-group discussion guide/);
  assert.equal(def.qualStudy.kind, "focus_group");
  await openQual("guide");
  await page.waitForSelector('[data-testid="qual-guide"][data-kind="focus_group"]');
  assert.match(await page.textContent('[data-testid="qual-guide"]'), /One person speaks at a time/);
  const { c } = await download('[data-testid="qual-export-guide"]');
  for (const w of ["FOCUS-GROUP DISCUSSION GUIDE", "Ground rules", "Exercise: Rank the benefits", "2 groups, 6 participants each"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  ok("create_qual_guide replace:true → focus-group guide with ground rules and a card sort → valid .docx");
}

console.log("\n4 — import a transcript: speakers and timestamps kept; speakers assigned to segments");
{
  await openQual("transcripts");
  await page.fill('[data-testid="qual-import-title"]', "IDI pair — Anna and Ben");
  await page.fill('[data-testid="qual-import-text"]', TRANSCRIPT);
  await page.click('[data-testid="qual-import-submit"]');
  await page.waitForSelector('[data-testid="qual-transcript"][data-title="IDI pair — Anna and Ben"]');
  await page.click('[data-testid="qual-transcript-open"]');
  const segs = await page.$$eval('[data-testid="qual-segment"]', (rs) => rs.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent.trim())));
  assert.deepEqual(segs.map((s) => [s[0], s[2]]), [["t1", "00:05"], ["t2", "00:12"], ["t3", "00:30"], ["t4", "00:34"], ["t5", "01:02"], ["t6", "01:20"]]);
  assert.deepEqual(await page.$$eval('[data-testid="qual-segment"]', (rs) => rs.map((r) => r.dataset.role)), ["moderator", "participant", "moderator", "participant", "participant", "participant"]);
  for (const [label, group] of [["Anna", "Switchers"], ["Ben", "Stayers"]]) await page.fill(`[data-testid="qual-speaker"][data-label="${label}"] [data-testid="qual-speaker-group"]`, group);
  await page.click('[data-testid="qual-speakers-save"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="qual-segment"] td:nth-child(2)')].some((td) => /Switchers/.test(td.textContent)));
  ok("“[hh:mm:ss] Speaker: text” → 6 segments, timestamps kept, the moderator suggested, Anna → Switchers, Ben → Stayers");
}

console.log("\n5 — AI codebook proposal: a paraphrase and a moderator turn rejected; every excerpt verbatim");
{
  await openQual("coding");
  await page.evaluate((r) => { window.__rescriptQualFake = [r]; }, CODING_REPLY);
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/api/surveys/sandbox/qual/coding")), page.click('[data-testid="qual-ai-code"]')]);
  const body = await res.json();
  assert.equal(res.status(), 200, JSON.stringify(body));
  assert.deepEqual(body.added, { codes: 3, themes: 2, excerpts: 4 });
  assert.deepEqual(body.rejected.map((r) => r.reason), ["not an exact quote from the segment (paraphrased, shortened or from elsewhere)", "a moderator turn is context, not a participant's view"]);
  await page.waitForSelector('[data-testid="qual-ai-report"][data-rejected="2"]');
  assert.match(await page.textContent('[data-testid="qual-rejected"]'), /prices kept rising without explanation/);
  assert.deepEqual(await page.$$eval('[data-testid="qual-code"]', (es) => es.map((e) => `${e.dataset.name}:${e.dataset.status}`)), ["Price rise:ai_suggested", "Cost:ai_suggested", "Slow speed:ai_suggested"]);
  for (const name of ["Price rise", "Cost", "Slow speed"]) {
    await page.click(`[data-testid="qual-code"][data-name="${name}"] [data-testid="qual-code-open"]`);
    for (const x of await page.$$eval('[data-testid="qual-excerpt"]', (es) => es.map((e) => ({ seg: e.dataset.segment, start: Number(e.dataset.start), end: Number(e.dataset.end), quote: e.querySelector('[data-testid="qual-excerpt-quote"]').textContent.replace(/^“|”$/g, "") })))) {
      const text = TURNS[Number(x.seg.slice(1)) - 1].text;
      assert.equal(text.slice(x.start, x.end), x.quote, `${name}: the quote is the exact span of ${x.seg}`);
    }
    await page.click(`[data-testid="qual-code"][data-name="${name}"] [data-testid="qual-code-open"]`);
  }
  ok("3 codes, 2 themes, 4 excerpts, all ai_suggested; the paraphrase and the moderator turn rejected and listed; every excerpt = segment.text.slice(start, end)");
}

console.log("\n6 — review: accept, merge, rename a theme, code by hand; history; two coders → kappa");
{
  await page.click('[data-testid="qual-code"][data-name="Slow speed"] [data-testid="qual-code-accept"]');
  await page.waitForSelector('[data-testid="qual-code"][data-name="Slow speed"][data-status="human_reviewed"]');
  await page.check('[data-testid="qual-code"][data-name="Price rise"] [data-testid="qual-code-select"]');
  await page.check('[data-testid="qual-code"][data-name="Cost"] [data-testid="qual-code-select"]');
  const into = await page.$eval('[data-testid="qual-merge-into"] option:nth-child(2)', (o) => o.value);
  await page.selectOption('[data-testid="qual-merge-into"]', into);
  await page.click('[data-testid="qual-merge-go"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="qual-code"][data-name="Cost"]'));
  await page.click('[data-testid="qual-code"][data-name="Price rise"] [data-testid="qual-code-open"]');
  assert.equal(await page.$$eval('[data-testid="qual-excerpt"]', (e) => e.length), 2, "the merged code holds both excerpts");
  await page.fill('[data-testid="qual-theme"][data-name="Money"] [data-testid="qual-theme-name"]', "Cost and value");
  await page.click('[data-testid="qual-theme"][data-name="Money"] [data-testid="qual-theme-rename"]');
  await page.waitForSelector('[data-testid="qual-theme"][data-name="Cost and value"]');
  await page.selectOption('[data-testid="qual-manual-segment"]', { index: 1 });
  await page.fill('[data-testid="qual-manual-quote"]', "PRICE WENT UP TWICE");
  await page.click('[data-testid="qual-manual-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="qual-excerpt"]').length === 3);
  const manual = await page.$$eval('[data-testid="qual-excerpt"]', (es) => es.map((e) => e.querySelector('[data-testid="qual-excerpt-quote"]').textContent).at(-1));
  assert.equal(manual, "“price went up twice”", "the source's own words, not what was typed");
  const history = await page.$$eval('[data-testid="qual-history-item"]', (es) => es.map((e) => e.textContent));
  for (const re of [/Merged “Cost” into “Price rise” \(1 excerpt moved\)/, /renamed “Money” → “Cost and value”/, /Accepted code “Slow speed”/, /Coded “price went up twice” as “Price rise”/, /AI inductive coding of 6 segments/]) assert.ok(history.some((h) => re.test(h)), String(re));
  await page.selectOption('[data-testid="qual-coder-a"]', "ai");
  await page.selectOption('[data-testid="qual-coder-b"]', "sandbox-user");
  await page.waitForSelector('[data-testid="qual-kappa-row"]');
  assert.ok((await page.$$('[data-testid="qual-kappa-row"]')).length >= 1);
  ok("accept → reviewed; merge Cost → Price rise (excerpts moved); theme renamed; a hand-coded passage stored as the source's exact words; every step in the history; AI vs reviewer kappa table");
}

console.log("\n7 — the theme table by participant segment, with frequency ≠ importance");
{
  await openQual("themes");
  assert.match(await page.textContent('[data-testid="qual-frequency-note"]'), /Frequency is not importance/);
  const heads = await page.$$eval('[data-testid="qual-theme-table"] th', (ths) => ths.map((t) => t.textContent));
  assert.ok(heads.some((h) => /^Stayers/.test(h)) && heads.some((h) => /^Switchers/.test(h)), heads.join(" | "));
  const row = await page.$$eval('[data-testid="qual-theme-row"][data-name="Cost and value"] [data-testid="qual-theme-cell"]', (cs) => Object.fromEntries(cs.map((c) => [c.dataset.group, c.textContent])));
  assert.deepEqual(row, { Stayers: "1 seg (50%)", Switchers: "1 seg (50%)" });
  const claims = await page.$$eval('[data-testid="qual-theme-summary"][data-name="Cost and value"] [data-testid="qual-claim"]', (cs) => cs.map((c) => c.dataset.cites));
  assert.ok(claims.length && claims.every((c) => /^x\d+(,x\d+)*$/.test(c)), "every claim cites excerpt ids");
  ok("Cost and value: Stayers 1 segment (50%), Switchers 1 segment (50%); the note; every summary claim cites excerpts");
}

console.log("\n8 — the qualitative report .docx");
{
  await openQual("report");
  await page.fill('[data-testid="qual-interpretation"]', "Price rises without explanation push customers to leave; speed matters but is tolerated.");
  const { name, c } = await download('[data-testid="qual-export-report"]');
  assert.match(name, /Qualitative_Report_\d{4}-\d{2}-\d{2}\.docx$/);
  for (const w of ["QUALITATIVE REPORT", "Method and coding", "Codebook", "Cost and value", "price went up twice", "the price is fine for what we get", "Group differences", "Frequency is not importance", "Price rises without explanation push customers to leave", "Limitations", "Review status and history"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  ok(`${name}: methodology, codebook, themes with verbatim excerpts, groups, the researcher's interpretation, limitations, review status`);
}

console.log("\n9 — access: no Data access, no transcripts");
{
  const project = process.env.QUAL_TEST_PROJECT, cookie = process.env.QUAL_TEST_COOKIE_NODATA;
  if (project && cookie) {
    for (const [method, path, body] of [["GET", "", null], ["POST", "/transcripts", JSON.stringify({ text: "Moderator: hi\nP1: hello", title: "x" })], ["POST", "/coding", JSON.stringify({ action: "op", op: { op: "add_code", name: "x" }, version: 0 })]]) {
      const r = await fetch(`${STUDIO}/api/surveys/${project}/qual${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      assert.equal(r.status, 403, `${method} ${path || "/"} → ${r.status}`);
    }
    ok("a member whose Data module is None gets 403 from GET /qual, POST /qual/transcripts and POST /qual/coding");
  } else {
    const r = await fetch(`${STUDIO}/api/surveys/00000000-0000-4000-8000-000000000065/qual`);
    assert.notEqual(r.status, 200, "an anonymous caller never gets qualitative data");
    const t = await fetch(`${STUDIO}/api/surveys/00000000-0000-4000-8000-000000000065/qual/transcripts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.notEqual(t.status, 200);
    ok(`anonymous → ${r.status} / ${t.status} (no data). SKIPPED the 403 for a no-Data member: no database here — set QUAL_TEST_PROJECT and QUAL_TEST_COOKIE_NODATA; proven by lib/qual/qualAccess.test.ts and scripts/qual-research-sql-test.sql`);
  }
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\nqual-research-test: ${passed} passed`);
