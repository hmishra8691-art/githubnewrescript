/**
 * THE STRUCTURED RESEARCH CONTEXT AND THE CAPABILITY READINESS (§3 / §11, 2026-10-18) — in the browser, against
 * the Studio dev server with the stand-in model (AI_API_URL=fake:; `window.__rescriptCopilotFake`):
 *
 *   [1] a ~24k pasted brief → a plan; the plan stage leaves ONE research context behind (no extra model call):
 *       8 hypotheses, smaller than half the brief
 *   [2] the staged build: every item's model request (the route's fake-only `context.sent`) is far smaller than
 *       the brief, carries the research context as a cached system block, and the item that needs exact wording
 *       gets the exact passage (the screener item: the regional quota table, verbatim)
 *   [3] reload → the context persists (GET /api/copilot/context); the applied design is adopted
 *   [4] a hypothesis changed in the survey → the context is invalidated (stale, not sent), then regenerated on
 *       demand with the survey's wording (version + 1)
 *   [5] an unready capability → a refusal naming the missing configuration, no model call, no charge; the
 *       platform page lists the readiness (variable names only)
 *
 *   node scripts/context-summary-test.mjs      (Studio on :3000, AI_API_URL=fake:)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { MASTER_PROMPT_BRIEF } from "../apps/studio/lib/copilot/fixtures/masterPromptBrief.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (402|404|413|501|502|503|504)/.test(m.text())) errors.push(m.text()); });
const turnRequests = [];
const turnResponses = [];
page.on("request", (r) => { if (r.url().endsWith("/api/copilot/turn") && r.method() === "POST") { try { turnRequests.push(JSON.parse(r.postData() ?? "{}")); } catch { turnRequests.push({}); } } });
page.on("response", async (r) => { if (r.url().endsWith("/api/copilot/turn") && r.request().method() === "POST") { try { turnResponses.push(await r.json()); } catch { turnResponses.push(null); } } });

const EMPTY = { meta: { id: "sandbox", code: "S", title: "Industry study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const fakeNext = (reply) => page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
const faultNext = (f) => page.evaluate((x) => window.__rescriptCopilotFault(x), f);
const lastTurn = async () => (await page.$$('[data-testid="cp-turn"]')).at(-1);
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const waitStatus = (re, timeout = 30000) => page.waitForFunction((src) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return !!l && new RegExp(src).test(l.getAttribute("data-status") ?? ""); }, re.source, { timeout });
const submit = async (text, reply) => {
  if (reply) await fakeNext(reply);
  await page.$eval('[data-testid="iq-input"]', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await page.focus('[data-testid="iq-input"]');
  await page.keyboard.press("Enter");
};
const settled = async () => { for (let i = 0; i < 60 && turnResponses.length < turnRequests.length; i++) await page.waitForTimeout(100); };
const contextApi = async (body) => (body ? page.request.post(`${STUDIO}/api/copilot/context`, { data: { surveyId: "sandbox", ...body } }) : page.request.get(`${STUDIO}/api/copilot/context?surveyId=sandbox`)).then((r) => r.json());

const H = [
  "Agencies that use three or more separate tools across the workflow report more delays between questionnaire sign-off and field launch than agencies on an integrated platform.",
  "Programming and testing account for more person-hours than questionnaire writing for projects with advanced logic (loops, quotas, MaxDiff or conjoint).",
  "Client-side insights teams are more likely than agencies to have piloted AI for questionnaire drafting, but less likely to use it in production.",
];
const PLAN = {
  kind: "plan", summary: "A 25–30 minute global B2B study among research professionals.",
  items: [
    { id: "d", title: "Record the research design: objectives and hypotheses H1–H3", kind: "design", objects: ["Research design"], reason: "the brief's objectives and hypotheses" },
    { id: "sc", title: "Build the screening and firmographics block with the regional quotas", kind: "create", objects: ["Screener"], reason: "qualify respondents; minimum completes per region" },
    { id: "ts", title: "Build the technology stack block", kind: "create", objects: ["Technology stack"], reason: "map the tools used at each workflow stage" },
    { id: "an", title: "Plan the analysis: hypothesis tests", kind: "analysis", objects: ["Analysis plan"], reason: "chi-square, t-tests and driver analysis per the brief" },
  ],
  questions: [], assumptions: ["The competitor list is supplied before fieldwork"],
};
const ITEMS = [
  { kind: "proposal", reply: "Research design recorded.", actions: [{ op: "set_research", objective: "Quantify the end-to-end research workflow and technology stack", hypotheses: H }] },
  { kind: "proposal", reply: "Screener added.", actions: [{ op: "create_block", title: "Screener" }, { op: "create_question", ref: "REGION", type: "single_select", text: "Where are you based?", options: ["North America", "South Asia (incl. India)", "Greater China"] }] },
  { kind: "proposal", reply: "Stack added.", actions: [{ op: "create_block", title: "Technology stack" }, { op: "create_question", ref: "TOOLS", type: "multi_select", text: "Which survey platforms do you use?", options: ["Rescript", "Qualtrics", "Decipher (Forsta)"] }] },
  { kind: "proposal", reply: "Analysis planned.", actions: [{ op: "propose_analysis_plan" }] },
];

/* ============================================================ [1] the brief → a plan, and the research context it leaves */
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.checkpoint.")).forEach((k) => localStorage.removeItem(k)); localStorage.removeItem("rescript.copilot.planFirst"); } catch {} });
await loadDef(EMPTY);
await intelligent();
turnRequests.length = 0; turnResponses.length = 0;
{
  await submit(MASTER_PROMPT_BRIEF, PLAN);
  await waitStatus(/^plan$/, 45000);
  await settled();
  const res = turnResponses[0];
  assert.equal(res.stage, "plan");
  const rc = res.context.researchContext;
  assert.ok(["derived", "regenerated"].includes(rc.status), JSON.stringify(rc));
  assert.equal(rc.hypotheses, 8, "the brief's eight hypotheses");
  assert.ok(rc.chars < res.context.messageChars / 2, `context ${rc.chars} vs brief ${res.context.messageChars}`);
  assert.equal(res.context.calls.length, 1, "one model call — the plan; the context is derived, not asked for");
  assert.ok(res.context.workflowId?.startsWith("wf_"));
  ok(`the plan stage read the brief whole (${res.context.messageChars} chars) and left a research context of ${rc.chars} chars with all 8 hypotheses — one model call`);
}

let applied;
/* ============================================================ [2] the staged build: small item requests, the context, the exact passage */
{
  turnRequests.length = 0; turnResponses.length = 0;
  for (let i = 0; i < 4; i++) await faultNext({ budgetMs: 1 });
  await fakeNext(ITEMS);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await waitStatus(/^ready$/, 60000);
  await settled();
  const sent = turnResponses.flatMap((r) => r?.context?.sent ?? []).filter((s) => /_item$/.test(s.operation));
  assert.equal(sent.length, 4, `four item calls: ${sent.map((s) => s.operation)}`);
  const brief = turnRequests[0].message.length;
  for (const s of sent) {
    assert.ok(s.variableChars < brief * 0.4, `an item's variable text ${s.variableChars} vs the brief ${brief}`);
    assert.equal(s.contextBlock, true, "the research context went as a cached system block");
    assert.ok(!s.variable.includes("Example Wording (style reference only)"), "not the whole brief");
    assert.match(s.variable, /RESEARCHER:\nBuild the survey from my research brief \(the brief: \d{2},\d{3} characters, stored as ref/);
  }
  const screener = sent[1];
  assert.ok(screener.variable.includes("| North America | 160 | English master questionnaire |") && screener.variable.includes("| South Asia (incl. India) | 110 |"), "the screener item got the quota table verbatim");
  assert.ok(sent[0].variable.includes("H5. Satisfaction with the primary survey platform is driven more by logic flexibility and support than by price.") || sent[0].passages.includes("s5"), "the design item got the hypotheses passage");
  for (const r of turnResponses) assert.ok(["reused", "regenerated", "derived"].includes(r.context.researchContext.status), JSON.stringify(r.context.researchContext));
  const final = turnResponses.find((r) => r.stage === "executed");
  assert.equal(final?.context?.workflow?.calls, 5, `one generation: the plan + 4 items — totals: ${JSON.stringify(final?.context?.workflow)}`);
  assert.equal(final.context.workflow.completed, true);
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(700);
  /* read the applied survey now: the sandbox starts from its fixture again after a reload */
  applied = await readDef();
  assert.equal(applied.research?.hypotheses?.length, 3, "the design item was applied");
  ok(`4 staged item requests, each ${Math.min(...sent.map((s) => s.variableChars))}–${Math.max(...sent.map((s) => s.variableChars))} variable chars against a ${brief}-char brief, the context cached, the quota table quoted verbatim where needed; workflow totals: ${final.context.workflow.calls} calls`);
}

/* ============================================================ [3] reload → the context persists; the applied design is adopted */
{
  /* the shared dev server is supervised and may be mid-restart: one retry */
  await page.reload({ waitUntil: "networkidle" }).catch(async () => { await page.waitForTimeout(8000); await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" }); });
  await page.waitForSelector(".menubar");
  await intelligent();
  const got = await contextApi();
  assert.ok(got.context, "kept after a reload");
  assert.equal(got.context.status, "fresh");
  assert.equal(got.context.hypotheses.length, 8);
  assert.match(got.rendered, /^RESEARCH CONTEXT v\d+/);
  const adopted = await contextApi({ action: "check", definition: applied });
  assert.equal(adopted.context.status, "fresh", "the first design is adopted, not a reason to invalidate");
  assert.equal(adopted.context.hypothesesSource, "design");
  assert.equal(adopted.context.hypotheses[0].text, H[0]);
  ok(`after a reload the context is still there (v${got.context.version}); the applied design is adopted as the authoritative wording`);
}

/* ============================================================ [4] change a hypothesis → invalidated; regenerated on demand */
{
  const changed = structuredClone(applied);
  changed.research.hypotheses[1] = "Programming and testing take FEWER person-hours than questionnaire writing.";
  await loadDef(changed);
  await intelligent();
  /* the next turn on the edited survey (the route checks the context against the definition it is sent) */
  const r = await page.request.post(`${STUDIO}/api/copilot/turn`, { data: { surveyId: "sandbox", message: "Explain which of the research hypotheses the current questions do not yet measure", definition: changed, mode: "question", fake: { kind: "answer", reply: "H2 is not yet measured.", actions: [] } } }).then((x) => x.json());
  assert.ok(r?.context, `the turn answered: ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(r.context.researchContext.status, "invalidated", JSON.stringify(r.context.researchContext));
  assert.equal(r.context.researchContext.stale, true);
  assert.ok(!(r.context.sent ?? []).some((s) => s.contextBlock), "a stale context is not sent");
  const stale = await contextApi();
  assert.equal(stale.context.status, "stale");
  const regen = await contextApi({ action: "regenerate", definition: changed });
  assert.equal(regen.context.status, "fresh");
  assert.equal(regen.context.version, stale.context.version + 1);
  assert.equal(regen.context.hypotheses[1].text, changed.research.hypotheses[1], "regenerated with the survey's wording");
  ok(`a changed hypothesis invalidated the context (not sent); regenerated on demand as v${regen.context.version} with the new wording`);
}

/* ============================================================ [5] an unready capability → a refusal naming the missing configuration */
{
  const platform = await page.request.get(`${STUDIO}/api/platform`).then((x) => x.json());
  assert.ok(platform.capabilities?.services?.length, "the platform reports the services");
  for (const s of platform.capabilities.services) for (const m of s.missing) assert.match(m, /^[A-Z0-9_ |()a-z]+$/, `a name, never a value: ${m}`);
  const PHRASES = { "platform:report_narration": "Make a narrated video report of the findings", "platform:recorded_transcription": "Transcribe the recorded answers of Q12", "platform:voice_requests": "Turn on voice input for my requests" };
  const unready = platform.capabilities.capabilities.find((c) => !c.ready && PHRASES[c.id]);
  if (!unready) ok("every requestable capability is configured on this server — the refusal is covered by the unit tests (capabilitiesReadiness.test.ts)");
  else {
    const res = await page.request.post(`${STUDIO}/api/copilot/turn`, { data: { surveyId: "sandbox", message: PHRASES[unready.id], definition: EMPTY } }).then((x) => x.json());
    assert.equal(res.context.scope, "unavailable");
    assert.equal(res.context.modelCalled, false);
    assert.equal(res.usage.charge, 0);
    assert.equal(res.context.capability, unready.id);
    for (const m of unready.missing) assert.ok(res.reply.reply.includes(m.split(" | ")[0]), `names ${m}: ${res.reply.reply}`);
    assert.match(res.reply.reply, /is not available on this installation: .* Nothing was changed and nothing was charged\./);
    await page.goto(`${STUDIO}/platform`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="platform-capabilities"]');
    const cell = await page.textContent(`[data-testid="platform-capability-${unready.id}"]`);
    assert.match(cell, /not ready/);
    ok(`“${PHRASES[unready.id]}” → refused, naming ${unready.missing.join(", ")}; no model call, no charge; /platform shows it not ready`);
  }
}

assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} passed`);
