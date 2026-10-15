import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * STRUCTURAL GUARANTEES OF THE SETTINGS SCREEN — read from its source, so a
 * later edit that breaks one fails here rather than in a person's browser.
 */
const dir = new URL("../../components/settings/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
const src = (f: string) => readFileSync(new URL(f, dir), "utf8");
const all = files.map((f) => [f, src(f)] as const);
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the screen has its seven sections, in order, each with an anchor", () => {
  const cfg = src("AiProviderConfig.tsx");
  const ids = [...cfg.matchAll(/\{ id: "(ai-[a-z]+)", label: "([^"]+)" \}/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["ai-overview", "ai-intelligent", "ai-additional", "ai-stt", "ai-translation", "ai-keys", "ai-usage"]);
  assert.ok(cfg.includes('id="ai-overview"') && cfg.includes("id={`ai-${id}`}") && cfg.includes('id="ai-keys"') && cfg.includes('id="ai-usage"'));
});

test("a secret never touches browser storage, the URL, the console or the DOM as text", () => {
  for (const [f, s] of all) {
    assert.doesNotMatch(s, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f} must not persist anything`);
    assert.doesNotMatch(s, /console\.(log|info|debug|warn|error)/, `${f} must not log`);
    assert.doesNotMatch(s, /location\.(href|search)\s*=|URLSearchParams|router\.(push|replace)\(.*[Kk]ey/, `${f} must not put values in a URL`);
  }
});

test("every key field is a password input that the browser does not autofill or remember", () => {
  let found = 0;
  for (const [f, s] of all) {
    for (const m of s.matchAll(/<input\b[\s\S]*?\/>/g)) {
      const tag = m[0];
      if (!/value=\{(draft\.newKey|newKey|f\.newKey|replacement|adding\.key)\}/.test(tag)) continue;
      found += 1;
      assert.match(tag, /type="password"/, `${f}: ${tag.slice(0, 90)}`);
      assert.match(tag, /autoComplete="new-password"/, `${f}: ${tag.slice(0, 90)}`);
      assert.match(tag, /spellCheck=\{false\}/, `${f}: ${tag.slice(0, 90)}`);
    }
  }
  assert.ok(found >= 4, `the main key, each fallback's key, the replacement and the add form (found ${found})`);
});

test("a key is never prefilled: no defaultValue on a key field, and the draft built from saved settings has an empty newKey", () => {
  for (const [f, s] of all) assert.doesNotMatch(s, /defaultValue=/, f);
  const m = read("lib/byok/settingsModel.ts");
  assert.match(m, /credentialId: f\.credential\?\.id \?\? null, newKey: ""/);
  assert.match(m, /credentialId: x\.credential\?\.id \?\? null, newKey: ""/);
});

test("the screen talks to the account API only, with the methods the routes define", () => {
  const urls = new Set<string>();
  for (const [, s] of all) for (const m of s.matchAll(/api<[^>]*>\(\s*[`"]([^`"?$]+)/g)) urls.add(m[1]);
  for (const u of urls) assert.match(u, /^\/api\/account\/ai(\/|$)/, u);
  assert.ok(["/api/account/ai", "/api/account/ai/test", "/api/account/ai/models", "/api/account/ai/credentials", "/api/account/ai/credentials/", "/api/account/ai/usage"].every((u) => urls.has(u)), [...urls].join(", "));
});

test("the screen imports nothing from the server-side packages or the vault", () => {
  for (const [f, s] of all) assert.doesNotMatch(s, /from "(@rescript\/[^"]*|[^"]*\/(vault|store|service|resolve|server|admin|guard|metering)(\.ts)?|server-only|@supabase[^"]*)"/, f);
  const m = read("lib/byok/settingsModel.ts");
  assert.doesNotMatch(m, /^import /m, "the model is browser-safe: no imports at all");
});

test("saving back to the platform asks twice; removing a key asks twice and says what returns to the platform", () => {
  assert.match(src("FeatureEditor.tsx"), /armedPlatform \? "Confirm: use platform AI"/);
  const k = src("KeysSection.tsx");
  assert.match(k, /armed === c\.id \? "Confirm\?"/);
  assert.match(k, /returns \{uses\.join\(", "\)\} to the platform's AI/);
});

test("the unsaved indicator, the leave-page guard and the per-section dot exist", () => {
  const e = src("FeatureEditor.tsx"), c = src("AiProviderConfig.tsx");
  assert.match(e, /Unsaved changes/); assert.match(e, /data-dirty/); assert.match(e, /Discard changes/);
  assert.match(c, /beforeunload/); assert.match(c, /ai-unsaved-banner/);
});

test("the usage route reads only the signed-in user's events and no cost fields", () => {
  const r = read("app/api/account/ai/usage/route.ts");
  assert.match(r, /requireUser/); assert.match(r, /userId: user\.userId/);
  assert.doesNotMatch(r, /providerCost|infraCost|marginPct|grossProfit/);
  const u = read("lib/byok/usage.ts");
  assert.doesNotMatch(u, /e\.providerCost|e\.infraCost|e\.marginPct|e\.grossProfit|e\.paymentFee|e\.taxReserve/);
});

test("the page is reachable from the account navigation and the account menu", () => {
  assert.match(read("components/AccountHeader.tsx"), /href="\/settings\/ai"/);
  assert.match(read("components/ui/AppHeader.tsx"), /href="\/settings\/ai"/);
  assert.match(read("app/settings/ai/page.tsx"), /AiProviderConfig/);
});
