/**
 * SETTINGS → AI & INTEGRATIONS → AI PROVIDER CONFIGURATION — browser suite.
 *
 * The REAL page, in a real browser, talking to the REAL account-AI service
 * (`apps/studio/lib/byok/service.ts`: overview, save, test connection, model
 * discovery, credentials) running in this process against an in-memory store
 * and local mock providers. Only the HTTP/auth shell is stood in for — the
 * session (`/api/auth/me`) and the thin route wrappers, which the
 * auth-guard audit covers separately — because the Studio in this container
 * has no database to sign anybody in against.
 *
 *   node scripts/byok-settings-test.mjs      (Studio on :3000)
 *
 * Proves: the seven sections; platform → own provider → save, with Test
 * Connection failing and then passing; unsaved markers and Discard; a key is
 * never shown, never in any response, never in the page; masked after saving;
 * translation by a service with no model; fallbacks saved with their keys;
 * replace / remove a key with confirmation and the features that fall back to
 * the platform; the usage section's two tables and its no-invented-cost
 * sentence; a blocked workspace; the phone layout.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const ROOT = new URL("..", import.meta.url).pathname;

/* ---- the environment the service reads (set BEFORE it is imported) ---- */
process.env.AI_CREDENTIAL_KEY = randomBytes(32).toString("hex");
process.env.AI_BYOK_ALLOW_PRIVATE_ENDPOINTS = "1";
process.env.AI_API_URL = "https://platform.example/v1";
process.env.AI_API_KEY = "platform-secret-key";
process.env.AI_MODEL = "platform-model";
process.env.GOOGLE_TRANSLATE_API_KEY = "platform-google-key";

const studioReq = createRequire(`${ROOT}apps/studio/package.json`);
const aiPath = studioReq.resolve("@rescript/ai");
const ai = await import(pathToFileURL(aiPath).href);
const svc = await import(pathToFileURL(`${ROOT}apps/studio/lib/byok/service.ts`).href);
const storeMod = await import(pathToFileURL(`${ROOT}apps/studio/lib/byok/store.ts`).href);
const usageMod = await import(pathToFileURL(`${ROOT}apps/studio/lib/byok/usage.ts`).href);

/* ---- local providers ---- */
const GOOD = "sk-proj-BROWSERSUITEGOODKEY0001";
const BAD = "sk-proj-BROWSERSUITEBADKEY00001";
const DEEPL = "deepl-browser-suite-key:fx";
const seen = [];
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve({ s, origin: `http://127.0.0.1:${s.address().port}` })); });
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const openai = await listen(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  const body = await readBody(req);
  seen.push({ provider: "openai", url: req.url, auth });
  if (auth !== `Bearer ${GOOD}`) return json(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
  if (req.url.endsWith("/models")) return json(res, 200, { data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }] });
  if (req.url.endsWith("/chat/completions")) return json(res, 200, { choices: [{ message: { content: /JSON/.test(body) ? '{"ok": true}' : "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
  return json(res, 404, {});
});
const deepl = await listen(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  const body = JSON.parse((await readBody(req)) || "{}");
  seen.push({ provider: "deepl", url: req.url, auth });
  if (auth !== `DeepL-Auth-Key ${DEEPL}`) return json(res, 403, { message: "Forbidden" });
  return json(res, 200, { translations: (body.text ?? []).map((t) => ({ detected_source_language: "EN", text: `[es] ${t}` })) });
});
const patch = (id, base) => { const d = ai.providerById(id); const was = d.base; d.base = base; return () => { d.base = was; }; };
const restores = [patch("openai", `${openai.origin}/v1`), patch("deepl", `${deepl.origin}/v2`)];

/* ---- the service, in this process ---- */
const USER = "aaaaaaaa-0000-0000-0000-00000000b0b0";
const store = new storeMod.MemoryAiStore();
const state = { workspaceAllows: true };
const deps = () => ({ store, env: process.env, workspaceAllows: state.workspaceAllows });
const fail = (r) => ({ status: r.status, body: { error: r.message, code: r.code, ...(r.errors ? { problems: r.errors } : {}) } });
const events = [
  { id: "u1", eventType: "AI_REQUEST_BYOK", category: "ai", service: "chat", provider: "openai", model: "gpt-4.1", quantity: 1, unit: "request", inputUnits: 1200, outputUnits: 300, customerCharge: 0, metadata: { providerId: "openai" }, createdAt: new Date(Date.now() - 3600e3).toISOString(), adjustsEventId: null },
  { id: "u2", eventType: "AI_REQUEST_BYOK", category: "ai", service: "translate", provider: "deepl", model: "v2", quantity: 800, unit: "character", inputUnits: null, outputUnits: null, customerCharge: 0, metadata: { providerId: "deepl", usedFallback: true }, createdAt: new Date(Date.now() - 7200e3).toISOString(), adjustsEventId: null },
  { id: "u3", eventType: "AI_REQUEST", category: "ai", service: "chat", provider: "anthropic", model: "claude", quantity: 1, unit: "request", inputUnits: 10, outputUnits: 10, customerCharge: 0.0125, providerCost: 0.9, metadata: {}, createdAt: new Date(Date.now() - 1800e3).toISOString(), adjustsEventId: null },
];

const allResponses = [];
async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname, m = req.method();
  const reply = (status, body) => { const text = JSON.stringify(body); allResponses.push(text); return route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: text }); };
  let body = {}; try { body = JSON.parse(req.postData() ?? "{}"); } catch { /* none */ }
  if (p === "/api/account/ai" && m === "GET") return reply(200, await svc.overview(USER, deps()));
  if (p === "/api/account/ai" && m === "PUT") {
    const r = await svc.saveSetting(USER, body, deps());
    if (!r.ok) { const f = fail(r); return reply(f.status, f.body); }
    return reply(200, { ok: true, ...(await svc.overview(USER, deps())) });
  }
  if (p === "/api/account/ai/credentials" && m === "POST") {
    const r = await svc.saveCredential(USER, { provider: String(body.provider ?? ""), apiKey: body.apiKey, label: body.label, credentialId: typeof body.credentialId === "string" ? body.credentialId : null }, deps());
    if (!r.ok) { const f = fail(r); return reply(f.status, f.body); }
    return reply(200, { ok: true, credential: r.credential });
  }
  const del = /^\/api\/account\/ai\/credentials\/([^/]+)$/.exec(p);
  if (del && m === "DELETE") {
    const r = await svc.removeCredential(USER, decodeURIComponent(del[1]), deps());
    if (!r.ok) return reply(r.status, { error: r.message, code: r.code });
    return reply(200, { ok: true, ...(await svc.overview(USER, deps())) });
  }
  if (p === "/api/account/ai/test" && m === "POST") {
    const r = await svc.testConnection(USER, body, deps());
    if (!r.ok) { const f = fail(r); return reply(f.status, f.body); }
    return reply(200, { ok: true, result: r.result });
  }
  if (p === "/api/account/ai/models" && m === "POST") {
    const r = await svc.modelsFor(USER, body, deps());
    if (!r.ok) { const f = fail(r); return reply(f.status, f.body); }
    return reply(200, r);
  }
  if (p === "/api/account/ai/usage" && m === "GET") return reply(200, { ok: true, ...usageMod.summariseAiUsage(events, { days: Number(url.searchParams.get("days")) || 30 }) });
  if (p === "/api/auth/me") return reply(200, { userId: USER, userCode: "USR-90001", name: "Test Researcher", email: "t@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", policies: { heartbeatSeconds: 3600, lockHeartbeatSeconds: 3600, presenceHeartbeatSeconds: 3600, idleAfterSeconds: 900, staleAfterSeconds: 900, lockStaleAfterSeconds: 900 } });
  return reply(200, {});
}

/* ---- the browser ---- */
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ok   ${name}`); };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await context.addCookies([{ name: "rescript_session", value: "browser-suite", url: STUDIO }]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); console.error("PAGE ERROR:", e.message); });
page.on("dialog", (d) => d.accept());
await page.route("**/api/**", (route) => handle(route).catch((e) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: String(e) }) })));
const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const T = (id) => page.locator(`[data-testid="${id}"]`);
const open = async (viewport) => { if (viewport) await page.setViewportSize(viewport); await page.goto(`${STUDIO}/settings/ai`, { waitUntil: "domcontentloaded" }); await T("ai-provider-config").waitFor({ timeout: 90_000 }); };

let failed = null;
try {
  console.log("\nTHE PAGE — seven sections, everything on the platform to start");
  await open();
  const links = await page.$$eval('[data-testid="ai-sections"] a', (a) => a.map((x) => x.textContent.replace(/^\d/, "").trim()));
  assert.deepEqual(links, ["Overview", "Intelligent Mode", "Other AI features", "Speech-to-text", "Translation", "Saved API keys", "Usage & cost"]);
  for (const id of ["ai-overview", "ai-intelligent", "ai-additional", "ai-stt", "ai-translation", "ai-keys", "ai-usage"]) assert.ok(await page.locator(`section#${id}`).count(), id);
  ok("seven sections, each with its anchor, in order");
  for (const f of ["intelligent", "additional", "stt", "translation"]) assert.equal(await T(`ai-overview-row-${f}`).getAttribute("data-mode"), "platform");
  assert.match(await T("ai-overview-respondent").textContent(), /always runs on the platform's AI/);
  assert.equal(await T("ai-keys-empty").count(), 1);
  ok("the overview says each feature is on the platform's AI; respondent AI is stated to be unaffected; no keys saved");
  assert.equal(await page.locator('a[data-testid="nav-ai"]').count(), 1);
  ok("the account navigation reaches this page");

  console.log("\nINTELLIGENT MODE — own provider: test (wrong key, right key), unsaved, save");
  await T("ai-intelligent-mode-user").check();
  await T("ai-intelligent-provider").selectOption("openai");
  assert.match(await T("ai-intelligent-fixed-base").textContent(), /fixed for this provider/);
  assert.equal(await T("ai-intelligent-test").isDisabled(), true, "Test is disabled until the connection is complete");
  assert.equal(await T("ai-intelligent-save").isDisabled(), true);
  assert.equal(await T("ai-feature-intelligent-unsaved").count(), 1, "switching mode is an unsaved change");
  const keyField = T("ai-intelligent-key");
  assert.equal(await keyField.getAttribute("type"), "password");
  assert.equal(await keyField.getAttribute("autocomplete"), "new-password");
  await keyField.fill(BAD);
  await T("ai-intelligent-model").fill("gpt-4.1");
  await T("ai-intelligent-test").click();
  await T("ai-intelligent-test-result").waitFor();
  assert.equal(await T("ai-intelligent-test-result").getAttribute("data-ok"), "0");
  assert.match(await T("ai-intelligent-test-result").textContent(), /rejected the API key/);
  assert.doesNotMatch(await T("ai-intelligent-test-result").textContent(), /Incorrect API key provided/, "the provider's own words are not repeated");
  ok("a wrong key: 'The provider rejected the API key' in our words, the provider's text not echoed");
  await keyField.fill(GOOD);
  await T("ai-intelligent-find-models").click();
  await T("ai-intelligent-models-note").waitFor();
  assert.match(await T("ai-intelligent-models-note").textContent(), /4 models your key can use/);
  await page.locator('[data-testid="ai-intelligent-models-note"] .chip', { hasText: "gpt-4.1-mini" }).click();
  assert.equal(await T("ai-intelligent-model").inputValue(), "gpt-4.1-mini");
  await T("ai-intelligent-model").fill("gpt-4.1");
  ok("Find models lists what this key can use (the provider's own list); a chip fills the field");
  await T("ai-intelligent-test").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-intelligent-test-result"]')?.getAttribute("data-ok") === "1");
  assert.match(await T("ai-intelligent-test-result").textContent(), /Connection works/);
  ok("the right key: 'Connection works' with the latency");
  assert.equal(await T("ai-unsaved-banner").count(), 1);
  assert.equal(await T("ai-section-link-ai-intelligent").locator(".ai-dot").count(), 1);
  assert.equal(await T("ai-feature-intelligent").getAttribute("data-dirty"), "1");
  ok("unsaved: the section's chip, the banner and the navigation dot all say so");
  await T("ai-intelligent-discard").click();
  assert.equal(await T("ai-feature-intelligent").getAttribute("data-dirty"), "0");
  /* the page's banner learns of the discard one render after the section does: wait for it to go (it still fails if it never does) */
  await T("ai-unsaved-banner").waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await T("ai-unsaved-banner").count(), 0);
  assert.equal(await T("ai-intelligent-mode-platform").isChecked(), true);
  ok("Discard returns the section to what is saved");

  await T("ai-intelligent-mode-user").check();
  await T("ai-intelligent-provider").selectOption("openai");
  await T("ai-intelligent-key").fill(GOOD);
  await T("ai-intelligent-model").fill("gpt-4.1");
  await T("ai-intelligent-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-feature-intelligent"]')?.getAttribute("data-mode") === "user");
  assert.equal(await T("ai-feature-intelligent").getAttribute("data-dirty"), "0");
  assert.equal(await T("ai-intelligent-key-saved").count(), 1);
  const mask = await T("ai-intelligent-key-saved").textContent();
  assert.match(mask, /sk-proj-••••••••0001/);
  assert.equal(await T("ai-intelligent-key").count(), 0, "the key field is gone: a saved key is a mask");
  assert.equal((await page.content()).includes(GOOD), false, "the key is nowhere in the page");
  assert.match(await T("ai-overview-row-intelligent").textContent(), /Your own provider.*OpenAI · gpt-4\.1 · your own key/);
  await shot("intelligent-saved");
  ok("Save: the section is clean, the key shows only as a mask, and the overview now says 'Your own provider'");

  console.log("\nTRANSLATION — a service has no model; a fallback is saved with its own key");
  await T("ai-translation-mode-user").check();
  await T("ai-translation-provider").selectOption("deepl");
  assert.equal(await T("ai-translation-model").count(), 0, "a translation service has no model to choose");
  assert.match(await T("ai-translation-fixed-base").textContent(), /api\.deepl\.com|127\.0\.0\.1/);
  await T("ai-translation-key").fill(DEEPL);
  await T("ai-translation-add-fallback").click();
  await T("ai-translation-fallback-0-provider").selectOption("google-translate");
  assert.equal(await T("ai-translation-save").isDisabled(), true, "a fallback with no key blocks Save");
  assert.match(await T("ai-translation-fallback-0").textContent(), /Enter this fallback's API key/);
  await T("ai-translation-fallback-0-key").fill("AIzaSyBROWSERSUITEGOOGLE000000001");
  await T("ai-translation-test").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-translation-test-result"]')?.getAttribute("data-ok") === "1");
  await shot("translation-draft");
  ok("DeepL Test Connection translates two characters with the key given");
  await T("ai-translation-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-feature-translation"]')?.getAttribute("data-mode") === "user");
  assert.equal(await T("ai-translation-fallback-0").count(), 1);
  assert.equal((await page.content()).includes(DEEPL), false);
  assert.equal((await page.content()).includes("AIzaSyBROWSERSUITEGOOGLE"), false, "neither key is in the page");
  ok("Save: the fallback's key was saved first and the setting names it by id; no key is in the page");
  assert.equal(await T("ai-translation-allow-platform").isChecked(), false);
  assert.match(await T("ai-translation-allow-platform").locator("xpath=ancestor::label").textContent(), /billed to your wallet as platform usage/);
  ok("the platform last resort is off by default and says what it would cost the person");

  console.log("\nMY AI MODEL — translating by the chat connection needs that connection");
  await T("ai-additional-mode-platform").check();
  ok("Other AI features stays on the platform");
  // choose My AI model for a feature that has no own chat provider yet → the server refuses in words
  await T("ai-translation-provider").selectOption("llm");
  assert.match(await T("ai-translation-reuse").textContent(), /no key of its own/);
  await T("ai-translation-save").click();
  await T("ai-translation-error").waitFor();
  assert.match(await T("ai-translation-error").textContent(), /Other AI features/);
  ok("“My AI model” with Other AI features on the platform is refused in words (never the platform's model)");
  await T("ai-translation-discard").click();

  console.log("\nSAVED KEYS — masks, where each is used, replace, remove");
  const rows = page.locator('[data-testid="ai-key-row"]');
  assert.equal(await rows.count(), 3, "OpenAI, DeepL and the Google fallback");
  const masks = await page.$$eval('[data-testid="ai-key-mask"]', (e) => e.map((x) => x.textContent));
  assert.ok(masks.every((m) => m.includes("••")), masks.join(","));
  assert.match(await rows.filter({ hasText: "DeepL" }).textContent(), /Translation/);
  assert.match(await rows.filter({ hasText: "Google" }).textContent(), /Translation \(fallback\)/);
  ok("three masked keys; each says what uses it, fallbacks included");
  await rows.filter({ hasText: "OpenAI" }).locator('[data-testid="ai-key-replace"]').click();
  await T("ai-key-replace-input").fill("sk-proj-BROWSERSUITENEWKEY00002");
  await T("ai-key-replace-save").click();
  await T("ai-keys-note").waitFor();
  assert.match(await T("ai-keys-note").textContent(), /Key replaced/);
  assert.match(await rows.filter({ hasText: "OpenAI" }).textContent(), /0002/);
  assert.equal((await page.content()).includes("BROWSERSUITENEWKEY"), false);
  ok("Replace swaps the secret behind the same row; the new mask shows, the key does not");
  await rows.filter({ hasText: "Google" }).locator('[data-testid="ai-key-remove"]').click();
  await T("ai-key-remove-warning").waitFor();
  assert.match(await T("ai-key-remove-warning").textContent(), /Translation \(fallback\)/);
  ok("Remove asks first and says what will change");
  await rows.filter({ hasText: "Google" }).locator('[data-testid="ai-key-remove"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ai-key-row"]').length === 2);
  assert.equal(await T("ai-translation-fallback-0").count(), 0, "the fallback that used the removed key is gone");
  assert.equal(await T("ai-feature-translation").getAttribute("data-mode"), "user");
  await rows.filter({ hasText: "DeepL" }).locator('[data-testid="ai-key-remove"]').click();
  await rows.filter({ hasText: "DeepL" }).locator('[data-testid="ai-key-remove"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-feature-translation"]')?.getAttribute("data-mode") === "platform");
  assert.match(await T("ai-overview-row-translation").textContent(), /Platform AI/);
  ok("removing the key a feature used returns that feature to the platform's AI, visibly; the others are untouched");
  assert.equal(await T("ai-feature-intelligent").getAttribute("data-mode"), "user");

  console.log("\nUSAGE — two tables, never added; no invented cost");
  await T("ai-usage-own").waitFor();
  assert.equal(await page.locator('[data-testid="ai-usage-own-row"]').count(), 2);
  const own = await T("ai-usage-own").textContent();
  assert.match(own, /1,200 in \/ 300 out tokens/); assert.match(own, /800 characters/);
  assert.doesNotMatch(own, /\$/, "no money on own-provider rows");
  assert.match(await T("ai-usage-cost-note").textContent(), /does not know your price/);
  assert.match(await T("ai-usage-platform-total").textContent(), /\$0\.0125|\$0\.01/);
  assert.doesNotMatch(await T("ai-usage").textContent(), /0\.9/, "the platform's provider cost is not shown");
  await shot("usage");
  ok("own-provider volumes with the cost sentence; the platform table shows the charge and not the provider's cost");

  console.log("\nGOING BACK TO THE PLATFORM — asks twice, keeps the keys");
  await T("ai-intelligent-mode-platform").check();
  assert.match(await T("ai-feature-intelligent").textContent(), /Saving returns this feature to the platform/);
  await T("ai-intelligent-save").click();
  assert.match(await T("ai-intelligent-save").textContent(), /Confirm: use platform AI/);
  await T("ai-intelligent-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-feature-intelligent"]')?.getAttribute("data-mode") === "platform");
  assert.equal(await page.locator('[data-testid="ai-key-row"]').count(), 1, "the saved key is kept");
  ok("platform again after a confirmation; the saved key remains");

  console.log("\nBLOCKED — a workspace that forbids user-managed AI");
  state.workspaceAllows = false;
  await open();
  assert.match(await T("ai-overview-workspace").textContent(), /administrator has turned off/);
  assert.equal(await T("ai-intelligent-mode-user").isDisabled(), true);
  assert.equal(await T("ai-feature-intelligent-blocked").count(), 1);
  state.workspaceAllows = true;
  ok("the radio is disabled and the reason is stated");

  console.log("\nTHE PHONE — nothing scrolls sideways");
  await open({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  ok("390 px wide: no horizontal page scroll");

  console.log("\nTHE WIRE — no response ever carried a secret");
  const wire = allResponses.join("\n");
  for (const secret of [GOOD, BAD, DEEPL, "BROWSERSUITENEWKEY", "AIzaSyBROWSERSUITEGOOGLE"]) assert.equal(wire.includes(secret), false, `${secret.slice(0, 18)}… appeared in a response`);
  assert.equal(/"sealed"/.test(wire), false);
  ok("across every response of this run: no key, no ciphertext");
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  ok("no page errors");
} catch (e) { failed = e; }

await browser.close();
for (const r of restores) r();
openai.s.close(); deepl.s.close();
if (failed) { console.error("\nFAILED:", failed.stack ?? failed); process.exit(1); }
console.log(`\n${checks.length} checks passed`);
process.exit(0);
