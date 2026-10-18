import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_THEMES } from "@rescript/analytics";
import { themeTurn, applyThemeTurn, saveThemeTurn, readingSaid } from "./reportThemeTurn.ts";
import { sandboxTheme } from "../artifacts/sandboxStore.ts";

/* the copilot's report-theme turn: preview first, nothing changes until Apply; save as a name; list; the saved project's route bodies */
class FakeStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } clear() { this.m.clear(); } key() { return null; } get length() { return this.m.size; } }
const def = { meta: { title: "T" }, branding: { colors: { primary: "#C8102E", secondary: "#003087" }, logoUrl: "data:image/png;base64,AA" } };

test("sandbox: a sentence previews, Apply applies, Save as names it (a version per save), and the list shows it", async () => {
  const store = new FakeStorage() as unknown as Storage;
  const ctx = { surveyId: "sandbox", def, store };
  const t = await themeTurn("Healthcare research presentation, restrained colors, clear statistical annotations", { op: "describe", text: "" }, ctx);
  assert.equal(t.card.status, "preview");
  assert.match(t.said, /^Preview of “Healthcare Analytics \(custom\)”: .*clear statistical annotations/);
  assert.equal(sandboxTheme(store).theme, null, "a preview changes nothing");
  const applied = await applyThemeTurn(t.card, ctx);
  assert.equal(applied.card.status, "applied");
  assert.equal(sandboxTheme(store).theme!.annotations.emphasis, "clear");
  const saved = await saveThemeTurn(t.card, "Clinic Pack", "user", ctx);
  assert.deepEqual(saved.card.savedAs, { name: "Clinic Pack", version: 1, scope: "tab" });
  const named = await themeTurn("Apply the Clinic Pack theme", { op: "apply_named", text: "", name: "Clinic Pack" }, ctx);
  assert.equal(named.card.reading!.intent, "apply_named", "a saved name resolves");
  const list = await themeTurn("which report themes are there", { op: "list", text: "" }, ctx);
  assert.deepEqual(list.card.themes!.map((x) => x.name), [...REPORT_THEMES.map((x) => x.name), "Clinic Pack"]);
  const brand = await themeTurn("Use our uploaded logo and brand colors for the report documents", { op: "describe", text: "" }, ctx);
  assert.equal(brand.card.reading!.preview!.colors.primary, "#C8102E", "the survey's Branding colours");
  const structure = await themeTurn("Keep the content but reorganize around the main hypotheses and recommendations", { op: "restructure", text: "" }, ctx);
  await applyThemeTurn(structure.card, ctx);
  assert.deepEqual(sandboxTheme(store).structure!.order, ["summary", "hypotheses", "recommendations"]);
  assert.equal(sandboxTheme(store).theme!.name, "Clinic Pack", "a structure request leaves the theme alone");
  const unknown = await themeTurn("Apply the Board Pack theme", { op: "apply_named", text: "", name: "Board Pack" }, ctx);
  assert.equal(unknown.card.status, "asked");
  assert.match(unknown.said, /no theme called “Board Pack”/);
});

test("a saved project: preview, apply (a built-in by ref), save for the organisation — the route's bodies", async () => {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const reading = (await themeTurn("Apply the Healthcare Analytics theme", { op: "apply_named", text: "" }, { surveyId: "sandbox", def: {}, store: null })).card.reading!;
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const res = body?.op === "preview" ? { reading, model: { status: "not_needed" } } : body?.op === "save" ? { theme: { ...body.theme, version: 2 } } : body?.op === "apply" ? { applied: {} } : { can: { apply: true, saveOrg: true } };
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const ctx = { surveyId: "s-1", def: {}, store: null, fetcher };
  const t = await themeTurn("Apply the Healthcare Analytics theme", { op: "apply_named", text: "" }, ctx);
  assert.equal(t.card.canSaveOrg, true);
  await applyThemeTurn(t.card, ctx);
  assert.deepEqual(calls.find((c) => c.body?.op === "apply")!.body, { op: "apply", ref: "builtin:healthcare_analytics" });
  const s = await saveThemeTurn(t.card, "Clinic Pack", "org", ctx);
  assert.equal(calls.find((c) => c.body?.op === "save")!.body!.scope, "org");
  assert.deepEqual(s.card.savedAs, { name: "Clinic Pack", version: 2, scope: "org" });
  assert.match(readingSaid(reading), /^Preview of the Healthcare Analytics theme/);
});
