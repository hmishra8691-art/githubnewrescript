import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_THEMES, interpretThemeRequest, reportThemeHash } from "@rescript/analytics";
import { REPORT_THEME_NAMES } from "@rescript/engine";
import { FakeDb } from "../../../scripts/lib/fakeSupabase.mjs";
import { savedThemes, saveTheme, loadSelection, applySelection, resolveTheme, themeStamp, brandOf, readStructure } from "./reportThemesStore.ts";

/*
 * NAMED REPORT THEMES (2026-10-18, migration 0064): saved per organisation or per person — never global —
 * with every version kept; resolved by name; applied to a project as a frozen copy; the brand on file.
 */
const ORG = "cust-1", OTHER_ORG = "cust-2", ANA = "u-ana", BEN = "u-ben";
function db() {
  const d = new FakeDb();
  Object.assign(d.tables, { report_themes: [], report_theme_versions: [], report_theme_selections: [] });
  return d;
}

test("saved per organisation and per person, never global; the same name again is the next version, every version kept", async () => {
  const d = db();
  const premium = interpretThemeRequest("Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds").preview!;
  const v1 = await saveTheme(d as never, { scope: "org", name: "Premium Corporate", theme: premium, customerId: ORG, userId: ANA });
  assert.ok(v1.ok && v1.created && v1.theme.version === 1 && v1.theme.scope === "org");
  const v2 = await saveTheme(d as never, { scope: "org", name: "premium-corporate", theme: { ...premium, colors: { ...premium.colors, heading: "#0B1630" } }, customerId: ORG, userId: BEN });
  assert.ok(v2.ok && !v2.created && v2.theme.version === 2 && v2.theme.id === (v1 as { theme: { id: string } }).theme.id, "one theme, version 2");
  assert.equal(d.tables.report_theme_versions.length, 2, "both versions kept");
  assert.equal(d.tables.report_themes.length, 1);
  const mine = await saveTheme(d as never, { scope: "user", name: "Ana's look", theme: REPORT_THEMES[3], customerId: ORG, userId: ANA });
  assert.ok(mine.ok && mine.theme.scope === "user");
  await saveTheme(d as never, { scope: "org", name: "Other org theme", theme: REPORT_THEMES[0], customerId: OTHER_ORG, userId: "u-x" });
  const forAna = await savedThemes(d as never, { customerId: ORG, userId: ANA });
  assert.deepEqual(forAna.map((t) => t.name).sort(), ["Ana's look", "Premium Corporate"]);
  const forBen = await savedThemes(d as never, { customerId: ORG, userId: BEN });
  assert.deepEqual(forBen.map((t) => t.name), ["Premium Corporate"], "not Ana's personal theme, not another organisation's");
  assert.equal(forBen[0].colors.heading, "#0B1630", "the latest version");
  const noOrg = await saveTheme(d as never, { scope: "org", name: "X", theme: REPORT_THEMES[0], customerId: null, userId: ANA });
  assert.ok(!noOrg.ok && noOrg.code === "theme_no_org");
  const noName = await saveTheme(d as never, { scope: "user", name: "  ", theme: REPORT_THEMES[0], customerId: ORG, userId: ANA });
  assert.ok(!noName.ok && noName.code === "theme_name_required");
});

test("resolved by name or ref: a saved theme shadows a built-in of the same name; the look's hash is the fingerprint's", async () => {
  const d = db();
  await saveTheme(d as never, { scope: "org", name: "Healthcare Analytics", theme: { ...REPORT_THEMES[0] }, customerId: ORG, userId: ANA });
  const saved = await savedThemes(d as never, { customerId: ORG, userId: ANA });
  assert.equal(resolveTheme("the Healthcare Analytics theme", saved)?.id, saved[0].id);
  assert.equal(resolveTheme("builtin:academic_research", saved)?.name, "Academic Research");
  assert.equal(resolveTheme(saved[0].id!, [])?.name ?? null, null, "a saved ref is not found without the saved list");
  assert.equal(resolveTheme("Nope", saved), null);
  assert.deepEqual(themeStamp(REPORT_THEMES[1]), { ref: "builtin:healthcare_analytics", version: 1, hash: reportThemeHash(REPORT_THEMES[1]) });
  assert.equal(themeStamp(null), null);
});

test("a project's applied theme is a frozen copy with its ref and version; a structure request is kept beside it, separately", async () => {
  const d = db();
  assert.equal(await loadSelection(d as never, "s1"), null);
  const a = await applySelection(d as never, "s1", { theme: REPORT_THEMES[1], userId: ANA });
  assert.ok(a.ok);
  let sel = (await loadSelection(d as never, "s1"))!;
  assert.equal(sel.ref, "builtin:healthcare_analytics"); assert.equal(sel.version, 1);
  assert.deepEqual(sel.theme!.colors, REPORT_THEMES[1].colors);
  assert.equal(sel.structure, null);
  const order = interpretThemeRequest("Keep the content but reorganize around the main hypotheses and recommendations").structure!;
  await applySelection(d as never, "s1", { structure: order, keepTheme: true, userId: BEN });
  sel = (await loadSelection(d as never, "s1"))!;
  assert.deepEqual(sel.structure!.order, ["summary", "hypotheses", "recommendations"]);
  assert.equal(sel.ref, "builtin:healthcare_analytics", "the theme is untouched by a structure request");
  await applySelection(d as never, "s1", { theme: null, keepStructure: true, userId: BEN });
  sel = (await loadSelection(d as never, "s1"))!;
  assert.equal(sel.theme, null); assert.ok(sel.structure);
  assert.equal(d.tables.report_theme_selections.length, 1, "one selection per project");
  assert.equal(readStructure({ order: ["hypotheses", "bogus", "hypotheses"] })!.order.join(), "hypotheses");
  assert.equal(readStructure({ order: [] }), null);
});

test("the brand on file is the survey's Branding — its chosen colours and uploaded logo; the schema defaults are not a brand", () => {
  assert.equal(brandOf(null), null);
  assert.equal(brandOf({ branding: { colors: { primary: "#2563eb", secondary: "#0f172a" } } }), null);
  assert.deepEqual(brandOf({ branding: { colors: { primary: "#C8102E", secondary: "#0f172a" }, logoUrl: "/api/media/abc/logo.png" } }), { colors: ["#C8102E", "#0f172a"], logoUrl: "/api/media/abc/logo.png" });
  assert.deepEqual(brandOf({ branding: { logoUrl: "data:image/png;base64,AA" } }), { colors: [], logoUrl: "data:image/png;base64,AA" });
});

test("the engine's built-in theme names are the analytics package's five", () => {
  assert.deepEqual([...REPORT_THEME_NAMES], REPORT_THEMES.map((t) => t.name));
});
