/**
 * AI COST REPORT — the token composition of a typical JavaScript (behaviour) request to the copilot,
 * and what it costs before / after provider prompt caching (docs/AI-COST-AUDIT-2026-10-17.md).
 *
 *   node --experimental-strip-types --no-warnings scripts/ai-cost-report.mjs [templateKey]
 *
 * Builds the real prompt with the Studio's own builders (copilotOutline, copilotUserPrompt, repairPrompt)
 * on a shipped template (default: screener_quota, an age-screener survey like the field case), splits it
 * the way the route now sends it (aiPromptCache.copilotCall), and prices it with the billing package's
 * own priceSpec and default rate table. Tokens are estimated at 4 characters per token (the meter's own
 * estimator); the production call sizes observed on 2026-10-17 are priced alongside for calibration.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = join(ROOT, "apps/studio");
const req = createRequire(join(STUDIO, "package.json"));
const imp = (rel) => import(pathToFileURL(join(STUDIO, rel)).href);
const { SURVEY_TEMPLATES } = await import(pathToFileURL(req.resolve("@rescript/templates")).href);
const { priceSpec, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS, billingConfig } = await import(pathToFileURL(req.resolve("@rescript/billing")).href);
const prompt = await imp("lib/copilot/prompt.ts");
const { copilotOutline } = await imp("lib/copilot/outline.ts");
const { copilotCall } = await imp("lib/aiPromptCache.ts");

const key = process.argv[2] ?? "screener_quota";
const tpl = SURVEY_TEMPLATES.find((t) => t.key === key);
if (!tpl) { console.error(`unknown template ${key}; one of ${SURVEY_TEMPLATES.map((t) => t.key).join(", ")}`); process.exit(1); }
const def = tpl.build("cost-report");
const target = def.questions.find((q) => /age/i.test(String(q.code))) ?? def.questions[0];
const message = `On ${target.code}, add JavaScript: when the typed age is 18 or more show "Yes, you are an eligible voter", and keep Next disabled until then.`;
const cls = prompt.classifyRequest(message, def.questions.length, 0);
const outline = copilotOutline(def, { selectedId: target.id, focusIds: prompt.referencedQuestions(def, message), ux: true });
const memory = { memory: "Theme set to the brand palette; Q2 options randomised.", history: [{ role: "user", text: "Randomise the options of Q2" }, { role: "copilot", text: "Done: Q2's options are randomised; the last one stays anchored." }] };
const userPrompt = prompt.copilotUserPrompt({ message, outline, surveyLanguage: prompt.surveyLanguageOf(def), mode: "ux", memory, ux: true, uxOnly: cls.uxOnly, selected: String(target.code) });
const [system, user] = copilotCall(userPrompt);

const tok = (s) => Math.max(1, Math.ceil(s.length / 4));
const row = (label, s) => console.log(`  ${label.padEnd(34)} ${String(s.length).padStart(7)} chars  ≈${String(tok(s)).padStart(6)} tokens`);
console.log(`\nTEMPLATE ${key} (${def.questions.length} questions) — request: ${message}\n`);
console.log("WHAT ONE BEHAVIOUR REQUEST SENDS");
row("system prompt", prompt.COPILOT_SYSTEM_PROMPT);
row("UX guide", prompt.COPILOT_UX_GUIDE);
row("survey outline", outline);
row("memory + recent turns", `${memory.memory}\n${memory.history.map((h) => h.text).join("\n")}`);
row("whole user text (before)", userPrompt);
const before = prompt.COPILOT_SYSTEM_PROMPT + userPrompt;
const stable = system.join("\n\n");
row("TOTAL INPUT", before);
console.log("\nAS THE ROUTE NOW SENDS IT");
row("system blocks (cacheable prefix)", stable);
row("user text (variable)", user);
console.log(`  cacheable share of the input       ${(100 * stable.length / (stable.length + user.length)).toFixed(1)} %`);
console.log(`  other guides (analysis / translation / quota / list fill / findings): ${[prompt.COPILOT_ANALYSIS_GUIDE, prompt.COPILOT_TRANSLATION_GUIDE, prompt.COPILOT_QUOTA_GUIDE, prompt.COPILOT_FINDINGS_GUIDE].map((g) => tok(g)).join(" / ")} tokens (+ list fill) — cached the same way when sent`);

const cfg = billingConfig({});
const MODEL = "claude-sonnet-4-6";
const price = (input, output, read = 0, write = 0) => priceSpec({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: MODEL, inputUnits: input, outputUnits: output, cacheReadUnits: read, cacheWriteUnits: write }, "LIVE", cfg, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS).breakdown;
const usd = (n) => `$${n.toFixed(4)}`;
const stableTok = tok(stable);
console.log(`\nPRICED (${MODEL}, default rates and margin; cache read 10 %, write 125 % of input; ${stableTok} cacheable tokens)`);
console.log("  call                      in      out   before: provider → charge     after warm: provider → charge     after cold (write)");
/* a question / edit turn carries no UX guide: only the system prompt is its cacheable prefix */
const sysTok = tok(prompt.COPILOT_SYSTEM_PROMPT);
const cases = [
  ["this request (estimated)", tok(before), 2215, stableTok],
  ["prod copilot_ux", 12362, 2215, stableTok],
  ["prod copilot_ux_repair", 14640, 2102, stableTok],
  ["prod copilot_question", 9770, 4822, sysTok],
];
for (const [label, input, output, prefix] of cases) {
  const cached = Math.min(prefix, input);
  const b = price(input, output), w = price(input, output, cached, 0), c = price(input, output, 0, cached);
  console.log(`  ${label.padEnd(24)} ${String(input).padStart(6)} ${String(output).padStart(6)}   ${usd(b.providerCost)} → ${usd(b.customerCharge)}          ${usd(w.providerCost)} → ${usd(w.customerCharge)} (−${(100 * (1 - w.customerCharge / b.customerCharge)).toFixed(0)} %)      ${usd(c.customerCharge)} (+${(100 * (c.customerCharge / b.customerCharge - 1)).toFixed(0)} %)`);
}
const rp = prompt.repairPrompt({ prompt: userPrompt, raw: { reply: "x", actions: [{ op: "create_behavior", target: String(target.code), script: "x".repeat(2400) }] }, refused: ["create_behavior: the selector matches nothing on the page"], total: 1, uxGuideSent: true, ops: ["create_behavior"] });
const [rs, ru] = copilotCall(rp.text);
console.log(`\nREPAIR of this request: ${tok(prompt.COPILOT_SYSTEM_PROMPT + rp.text)} tokens in, of which ${tok(rs.join("\n\n"))} now read from the cache (the turn wrote them); ${tok(ru)} variable.`);
console.log("\nOutput is billed as generated: a behaviour edit that rewrites a whole script pays for the whole script (J's `edits` op addresses that).\n");
