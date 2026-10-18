import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import { ProviderError } from "@rescript/ai";
import { requestScope, isLongBrief, UNSUPPORTED_MESSAGE, outsideNote } from "@rescript/engine";
import { classifyRequest, copilotUserPrompt, coerceCopilotReply, normalizeBrief, honestReply, analysisIntent, MAX_MESSAGE_CHARS, COPILOT_ANALYSIS_GUIDE, COPILOT_TRANSLATION_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_FINDINGS_GUIDE, COPILOT_UX_GUIDE } from "./prompt.ts";
import { COPILOT_METHODS_GUIDE } from "./methodsGuide.ts";
import { coerceChangePlan, planStagePrompt, planRetryPrompt, mergeItemReplies, sanitizeDone } from "./changePlan.ts";
import { evaluateProposal, memoryFrom, actionGist, type MemoryTurn } from "./client.ts";
import { copilotOutline } from "./outline.ts";
import { describeFailure, failureFromError, failureFromTransport, type FailureCode } from "./failure.ts";
import { coerceOperation, LIMITS, sha256Hex } from "./operations.ts";
import { mergeBuilt, pendingIds, autoRetriesFor, isTemporary, MAX_AUTO_RETRIES } from "./resume.ts";
import { MASTER_PROMPT_BRIEF, BRIEF_SECTIONS, BRIEF_HYPOTHESES } from "./fixtures/masterPromptBrief.mjs";

/*
 * INTELLIGENT ENGINE RELIABILITY (2026-10-17) — the production evidence, reproduced in the pure parts:
 *   #1 a ~25k-character pasted brief → "clarify", no plan (cut at 8,000 characters; every guide sent; the plan stage invited questions)
 *   #2 a 30–35-minute survey → "connection interrupted", nothing kept (one request ran as long as the clock allowed)
 *   #3 a Hindi brief after its plan → "the provider refused" (the build cut off by the platform, no JSON)
 *   #4 an ordinary edit → "the AI service could not process this" (a 400 / an exception read as a refusal)
 * plus the classifier, the multi-turn referents, honest replies, failure mapping and the operation log.
 */

const MUMBAI = "मैं मुंबई में रहता हूँ और यहाँ पे पानी की समस्या बहुत सारी है और यहाँ पे जो एक demographic population है, कुछ slum में रहते हैं और कुछ अच्छे residential apartments में तो पानी अलग-अलग तरीके से मिलता है तो मेरा मानना है कि slums में रहने वाले लोगों को purified पानी नहीं मिलता, please help me design a survey";

function survey(n = 0): SurveyDefinition {
  const questions = Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `V${i + 1}`, type: "single_select", text: `Question ${i + 1}?`, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }));
  return SurveyDefinition.parse({
    meta: { id: "s", code: "PS", title: "Pricing study" },
    questions,
    flow: [...(n ? [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }] }] : []), { type: "end", id: "e", status: "complete" }],
  });
}

/* ------------------------------------------------------------ evidence #1: the long brief */

test("#1 the root cause: the route read 8,000 characters — the brief's hypotheses, questionnaire, analysis and reporting sections never reached the model", () => {
  assert.ok(MASTER_PROMPT_BRIEF.length > 24_000, `the fixture is a ~25k brief: ${MASTER_PROMPT_BRIEF.length}`);
  const old = MASTER_PROMPT_BRIEF.trim().slice(0, 8000);
  for (const lost of ["Analysis Plan", "Reporting and Deliverables", "Output Format for This Request"]) assert.ok(!old.includes(lost), `cut off before: ${lost}`);
  const now = normalizeBrief(MASTER_PROMPT_BRIEF);
  assert.ok(now.length <= MAX_MESSAGE_CHARS, "read whole now");
  for (const s of BRIEF_SECTIONS) assert.ok(now.includes(s), `kept: ${s}`);
  for (let i = 1; i <= BRIEF_HYPOTHESES; i++) assert.ok(now.includes(`H${i}.`), `hypothesis H${i} kept`);
});

test("normalisation strips the chat tool's markdown noise and keeps the meaning — headings, lists, table rows, every word, Devanagari intact", () => {
  const now = normalizeBrief(MASTER_PROMPT_BRIEF);
  assert.ok(now.length < MASTER_PROMPT_BRIEF.length, "smaller");
  assert.doesNotMatch(now, /\*\*|^#{1,6} |^-{3,}$|^\|-{3}/m, "no bold markers, heading hashes, rules or table alignment rows");
  assert.match(now, /^\| Survey programming \| Rescript, Qualtrics/m, "table rows kept as rows");
  assert.match(now, /^- how market research agencies and client-side insights teams work today/m, "bullets kept");
  assert.match(now, /^1\. Profile the market/m, "numbered lists kept");
  assert.doesNotMatch(now, /✅/, "decorative emoji gone");
  const hindi = `## पृष्ठभूमि\n**मुंबई** में पानी — क्ष‍ (ZWJ) और​ शून्य`;
  const n = normalizeBrief(hindi);
  assert.equal(n, "पृष्ठभूमि\nमुंबई में पानी — क्ष‍ (ZWJ) और शून्य", "NFC; the joiner Indic scripts need is kept, the zero-width space goes");
  assert.equal(normalizeBrief("Make Q5 required"), "Make Q5 required", "a sentence is untouched");
  assert.equal(normalizeBrief("Q5 * Q6 and 2*3"), "Q5 * Q6 and 2*3", "a lone asterisk is not markdown");
});

test("#1 the brief is a research request: supported, long, a generation — and its plan prompt carries no action guides and asks for assumptions, not questions", () => {
  const brief = normalizeBrief(MASTER_PROMPT_BRIEF);
  const scope = requestScope(brief);
  assert.equal(scope.scope, "supported");
  assert.equal(scope.longBrief, true);
  assert.ok(isLongBrief(brief));
  assert.equal(classifyRequest(brief, 0, 0).mode, "generate");
  const base = { message: brief, outline: copilotOutline(survey()), surveyLanguage: "en", mode: "generate" as const, analysis: true, translation: true, quota: true, methods: true, findings: true, ux: true, longBrief: true };
  const full = copilotUserPrompt(base);
  const plan = copilotUserPrompt({ ...base, planOnly: true });
  for (const g of [COPILOT_ANALYSIS_GUIDE, COPILOT_TRANSLATION_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_FINDINGS_GUIDE, COPILOT_UX_GUIDE, COPILOT_METHODS_GUIDE]) {
    assert.ok(full.includes(g), "the items keep their guides");
    assert.ok(!plan.includes(g), "the plan stage does not carry them");
  }
  assert.ok(full.length - plan.length > 30_000, `the plan prompt is ${full.length - plan.length} characters lighter`);
  assert.ok(plan.includes(brief), "the whole brief is in the plan prompt");
  assert.match(plan, /A PASTED RESEARCH BRIEF \([\d,]+ characters; every section counts/);
  assert.match(plan, /do not answer with a list of questions/);
  const p = planStagePrompt({ longBrief: true });
  assert.match(p, /THIS IS A DETAILED BRIEF\. Plan from it — do not answer with questions/);
  assert.match(p, /at most ONE/);
  assert.match(p, /3 to 30 items/);
  assert.match(planStagePrompt(), /3 to 15 items/, "an ordinary generation is unchanged");
  assert.doesNotMatch(planStagePrompt(), /DETAILED BRIEF/);
  assert.match(planRetryPrompt(), /NOT A PLAN.*at least 3 items/s);
});

test("#1 a brief's plan keeps at most one question and every assumption; a questions-only answer is no plan (the route asks once more, then asks ONE question)", () => {
  const raw = { kind: "plan", summary: "Global MR industry study", items: Array.from({ length: 14 }, (_, i) => ({ id: `s${i + 1}`, title: `Build section ${i + 1}`, kind: "create", reason: "the brief" })), questions: ["Which panel?", "Which currency?", "Brand guidelines?"], assumptions: Array.from({ length: 12 }, (_, i) => `assumption ${i + 1}`) };
  const plan = coerceChangePlan(raw, { maxQuestions: 1 })!;
  assert.equal(plan.items.length, 14);
  assert.deepEqual(plan.questions, ["Which panel?"]);
  assert.equal(plan.assumptions.length, 12, "assumptions are the point — up to 20 kept");
  assert.equal(coerceChangePlan({ kind: "clarify", reply: "This is a very large and detailed brief — I have a few questions…", questions: ["a", "b", "c"] }), null, "the production answer is not a plan");
  assert.equal(coerceChangePlan({ kind: "plan", items: [], questions: ["a"] }), null);
});

/* ------------------------------------------------------------ the classifier */

test("supported, unsupported, mixed and ambiguous — and the unsupported answer is the exact sentence", () => {
  for (const t of [MUMBAI, "So, question number two as a men's flip-flop mode.", "I want to design a full survey, a new separate survey, yes, please add some screening criteria and yes, please also turn with 30, 35 minutes, yeah, that's good, yeah, you can add more list if you have, you can also ask certain loops, keep things manageable, yeah.", "सारे कोशन सेपरेट पेज़ पे चाहिए।", "Mujhe ek customer satisfaction survey banana hai"]) assert.equal(requestScope(t).scope, "supported", t.slice(0, 60));
  for (const t of ["write me a poem", "book a flight to Delhi", "what's the weather today"]) assert.equal(requestScope(t).scope, "unsupported", t);
  assert.equal(UNSUPPORTED_MESSAGE, "This request is outside the supported capabilities of Intelligent Mode. You can use this engine for research planning, hypothesis development, survey design and programming, supported analysis, data-quality workflows, translation, and research reporting.");
  const mixed = requestScope("Add an NPS question to the survey and book me a flight to Delhi");
  assert.equal(mixed.scope, "mixed");
  assert.match(outsideNote(mixed.scope === "mixed" ? mixed.outside : []), /“book me a flight to Delhi”/);
  assert.equal(requestScope("hi").scope, "ambiguous");
});

/* ------------------------------------------------------------ section 15: the multi-turn chain */

test("multi-step context: each turn's prompt carries what the turn before created, and no localized edit is routed to full generation", () => {
  // the stand-in model's replies, turn by turn
  const replies = [
    { kind: "proposal", reply: "I'll record a hypothesis about price sensitivity.", actions: [{ op: "add_hypothesis", text: "Price-sensitive shoppers switch brands more often" }], memory: "H1 price sensitivity recorded." },
    { kind: "proposal", reply: "Three questions measure price sensitivity.", actions: [1, 2, 3].map((n) => ({ op: "create_question", ref: `PRICE_${n}`, block: "Main", type: "single", text: `Price item ${n}?`, options: ["Agree", "Disagree"] })) },
    { kind: "proposal", reply: "PRICE_2 and PRICE_3 show only to price-sensitive respondents.", actions: [{ op: "set_display_logic", target: "PRICE_2", expression: "PRICE_1 = 1" }, { op: "set_display_logic", target: "PRICE_3", expression: "PRICE_1 = 1" }] },
    { kind: "proposal", reply: "H1 is now in the analysis plan.", actions: [{ op: "set_question_analysis", target: "PRICE_1", role: "independent", hypotheses: ["H1"] }, { op: "propose_analysis_plan", merge: true }] },
  ];
  const turns = ["Add a hypothesis about price sensitivity", "Create three questions to measure it", "Add display logic", "Include it in the analysis plan", "Add a chart to the report", "Update the Word document"];
  let def = survey(10);
  let proposal = { base: def, steps: [] as { request: string; actions: never[] }[] };
  const history: MemoryTurn[] = [];
  const prompts: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const text = turns[i];
    const working = proposal.steps.length ? evaluateProposal(proposal).after : def;
    const cls = classifyRequest(text, working.questions.length, 0);
    assert.notEqual(cls.mode, "generate", `“${text}” is a localized edit, not a generation`);
    prompts.push(copilotUserPrompt({ message: text, outline: copilotOutline(working, { analysis: analysisIntent(text) }), surveyLanguage: "en", mode: cls.mode, memory: memoryFrom(history), analysis: analysisIntent(text) }));
    const reply = coerceCopilotReply(replies[i] ?? { kind: "answer", reply: "Noted." })!;
    history.push({ user: text, reply });
    if (reply.actions.length) proposal = { base: def, steps: [...proposal.steps, { request: text, actions: reply.actions as never[] }] };
  }
  assert.match(prompts[1], /Researcher: Add a hypothesis about price sensitivity\nCopilot: .*\[proposed 1 actions: hypothesis “Price-sensitive shoppers switch brands more often”\]/, "turn 2 knows what “it” is");
  assert.match(prompts[2], /\[proposed 3 actions: PRICE_1, PRICE_2, PRICE_3\]/, "turn 3 knows the three questions by their refs");
  assert.match(prompts[2], /PRICE_1/, "and the outline (the proposal applied) shows them");
  assert.match(prompts[3], /display logic on PRICE_2 \(PRICE_1 = 1\)/);
  assert.ok(prompts[3].includes(COPILOT_ANALYSIS_GUIDE), "“include it in the analysis plan” carries the analysis guide");
  assert.match(prompts[4], /analysis tag on PRICE_1 \(H1\)/, "the report turn knows what went into the plan");
  assert.match(prompts[5], /Researcher: Add a chart to the report/);
  assert.equal(classifyRequest("Create a survey to test the price sensitivity hypothesis", 10, 0).mode, "generate", "naming the whole survey is still a generation");
  assert.equal(classifyRequest("Add a hypothesis about price sensitivity", 0, 0).mode, "generate", "on an empty survey a hypothesis starts the design");
});

test("the action gist names objects, stays short, and says how many more there are", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ op: "create_question", ref: `ITEM_${i + 1}`, type: "single", text: "x" }));
  const g = actionGist(many as never);
  assert.ok(g.length < 290, g);
  assert.match(g, /^ITEM_1, ITEM_2, .*\+\d+ more$/);
  assert.equal(actionGist([{ op: "create_block", title: "Pricing" }, { op: "add_skip", from: "Q3", when: "Q3 = 2", to: "end" }] as never), "block “Pricing”, skip from Q3");
});

/* ------------------------------------------------------------ never "success" when nothing was done */

test("an answer is never success when nothing was proposed or everything was refused", () => {
  const r = coerceCopilotReply({ kind: "proposal", reply: "I've added the screener block.", actions: [{ op: "create_block", title: "Screener" }] })!;
  const refused = honestReply(r, [{ ok: false, description: "Create block “Screener”", error: "a block with this title exists" }]);
  assert.match(refused.reply, /^Nothing was changed: none of the 1 proposed change could be applied \(Create block “Screener” — a block with this title exists\)\./);
  assert.equal(honestReply(r, [{ ok: true, description: "x" }]).reply, r.reply, "an accepted batch is left as it is");
  const claim = coerceCopilotReply({ kind: "answer", reply: "Done — I have added three questions to Block 2." })!;
  assert.match(honestReply(claim, null).reply, /Nothing has been changed yet — this answer proposed no changes to apply\.\)$/);
  const plain = coerceCopilotReply({ kind: "answer", reply: "Q3 measures satisfaction on a 5-point scale." })!;
  assert.equal(honestReply(plain, null).reply, plain.reply, "an answer that claims nothing is untouched");
  const merged = mergeItemReplies([]);
  assert.equal((merged.actions as unknown[]).length, 0, "an empty build merges to no actions (the route then says nothing was built)");
});

/* ------------------------------------------------------------ evidence #2 / #3: staging and idempotency */

test("#2/#3 staged generation: the stage ids are idempotent — a resent, retried or repeated item is never built or merged twice", () => {
  const allowed = new Set(["p1", "p2", "p3", "p4"]);
  const done = sanitizeDone([
    { id: "p1", raw: { actions: [{ op: "create_block", title: "Screener" }] } },
    { id: "p1", raw: { actions: [{ op: "create_block", title: "Screener (again)" }] } },
    { id: "p2", raw: { actions: [] }, applied: true },
    { id: "zz", raw: { actions: [] } },
    { id: "p3", raw: "not an object" },
  ], allowed);
  assert.deepEqual([...done.keys()], ["p1", "p2"], "this plan's ids only, each once, objects only");
  assert.equal((done.get("p1")!.raw as { actions: { title: string }[] }).actions[0].title, "Screener", "the first reply for an id wins");
  assert.equal(done.get("p2")!.applied, true, "an item already in the proposal is context, never merged again");
  // a provider timeout mid-stage: the built stages are kept, only the failed one and the rest are pending, and a retry of it lands once
  let built = mergeBuilt([], [{ id: "p1", raw: 1 }, { id: "p2", raw: 2 }]);
  assert.deepEqual(pendingIds(["p1", "p2", "p3", "p4"], built, []), ["p3", "p4"]);
  built = mergeBuilt(built, [{ id: "p3", raw: 3 }]);
  built = mergeBuilt(built, [{ id: "p3", raw: 33 }]);
  assert.deepEqual(built.map((b) => b.id), ["p1", "p2", "p3"]);
  assert.equal(built.find((b) => b.id === "p3")!.raw, 33);
});

test("#3 a Devanagari brief survives the whole path: scope, classification, prompt, JSON round trip", () => {
  const text = normalizeBrief(MUMBAI);
  assert.equal(text, MUMBAI.normalize("NFC"));
  assert.equal(requestScope(text).scope, "supported");
  assert.equal(classifyRequest(text, 0, 0).mode, "generate");
  const p = copilotUserPrompt({ message: text, outline: copilotOutline(survey()), surveyLanguage: "hi", mode: "generate" });
  assert.ok(p.includes("मेरा मानना है कि slums"));
  assert.equal(JSON.parse(JSON.stringify({ messages: [{ role: "user", content: p }] })).messages[0].content, p, "no encoding loss in the request body");
});

/* ------------------------------------------------------------ evidence #4 and the failure taxonomy */

test("#4 every provider failure kind maps to a researcher-readable card — no status codes, keys, provider words or stack traces", () => {
  const expected: Record<string, FailureCode> = { rate_limited: "capacity", overloaded: "capacity", server: "capacity", busy: "capacity", network: "network", timeout: "timeout", auth: "auth", forbidden: "forbidden", quota_exhausted: "quota", not_found: "not_found", bad_request: "provider" };
  for (const [kind, code] of Object.entries(expected)) {
    const e = new ProviderError({ kind: kind as never, status: 400, detail: "invalid x-api-key sk-ant-api03-SECRETSECRET (400) at Object.<anonymous> (/srv/index.js:12:3)", host: "api.example.com", exhausted: true });
    const f = failureFromError(e);
    assert.equal(f.code, code, kind);
    const card = [f.title, f.message, ...f.next].join(" ");
    assert.doesNotMatch(card, /sk-ant|x-api-key|\(400\)|\b40[0-9]\b|\b5\d\d\b|ProviderError|at Object|index\.js/, `${kind}: ${card}`);
    assert.equal(!!f.retryable, ["capacity", "network", "timeout"].includes(code), `${kind} retryable`);
    assert.doesNotMatch(e.detail, /SECRETSECRET/, "what the route logs (`said`) is redacted at the source");
  }
  assert.equal(failureFromError(new ProviderError({ kind: "bad_request", status: 400, detail: "prompt is too long: 250000 tokens > 200000 maximum" })).code, "too_long");
  // an exception in the Studio itself is the Studio's — never "the AI service could not process this … try rephrasing"
  const studio = failureFromError("Cannot read properties of undefined (reading 'questions')", { studio: true });
  assert.equal(studio.code, "unexpected");
  assert.doesNotMatch([studio.title, studio.message, ...studio.next].join(" "), /Cannot read|undefined|rephras/i);
  assert.equal(failureFromError("the provider refused the request (401)", { studio: true }).code, "auth", "an old-style provider message is still read by its words");
  // no JSON reached the page: the platform's time limit, a dropped connection, a body too large
  assert.equal(failureFromTransport(504).code, "timeout");
  assert.equal(failureFromTransport(0).code, "unreachable");
  assert.equal(failureFromTransport(413).code, "too_long");
  for (const st of [0, 502, 503, 504]) assert.doesNotMatch(failureFromTransport(st).title, /REFUSED/);
  assert.ok(describeFailure("too_long").next.some((n) => /Plan first|one block/.test(n)));
});

/* ------------------------------------------------------------ the operation log */

test("the operation log keeps 20,000 characters of a long prompt, with its full length and SHA-256 — and an update never clobbers the intent", () => {
  const brief = MASTER_PROMPT_BRIEF + "\n" + "Extra context line.\n".repeat(60);
  const c = coerceOperation({ prompt: brief, source: "model", status: "clarify", intent: { mode: "generate" } }, "create");
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal(c.value.prompt.length, LIMITS.prompt);
  assert.equal(LIMITS.prompt, 20_000);
  assert.equal(c.value.intent.promptLength, brief.length);
  assert.equal(c.value.intent.promptSha256, createHash("sha256").update(brief, "utf8").digest("hex"), "the pure SHA-256 matches node:crypto");
  assert.equal(c.value.intent.mode, "generate");
  assert.ok(c.warnings.some((w) => /cut to 20000/.test(w)));
  const short = coerceOperation({ prompt: "Make Q5 required", source: "engine", status: "answered" }, "create");
  assert.ok(short.ok && !("promptLength" in short.value.intent), "a short prompt carries no fingerprint");
  const upd = coerceOperation({ prompt: "x".repeat(5000) }, "update");
  assert.ok(upd.ok && upd.value.intent === undefined, "an update without an intent leaves the stored one alone");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("मुंबई"), createHash("sha256").update("मुंबई", "utf8").digest("hex"));
});

test("retries are bounded and not doubled: the provider layer retries inside a request; the page resends a timed-out call once, a busy provider up to five times", () => {
  const timeout = { status: 503, ok: false, d: { ok: false, failure: describeFailure("timeout") } };
  const busy = { status: 503, ok: false, d: { ok: false, failure: describeFailure("capacity") } };
  const dropped = { status: 0, ok: false, d: null };
  assert.ok(isTemporary(timeout) && isTemporary(busy) && isTemporary(dropped));
  assert.equal(autoRetriesFor(timeout), 1);
  assert.equal(autoRetriesFor(busy), MAX_AUTO_RETRIES);
  assert.equal(autoRetriesFor(dropped), MAX_AUTO_RETRIES);
  assert.equal(isTemporary({ status: 502, ok: false, d: { ok: false, failure: describeFailure("auth") } }), false, "a refused key is never resent");
});
