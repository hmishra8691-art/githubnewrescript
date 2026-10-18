import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReportTheme } from "./reportThemeResolve.ts";

test("the builder's theme is resolved, not suggested: a saved one is reused, a preset is saved first, an unknown name is said", () => {
  assert.equal(resolveReportTheme(undefined, []), null);
  assert.deepEqual(resolveReportTheme("midnight", [{ id: "t1", name: "Midnight" }]), { kind: "saved", themeId: "t1", name: "Midnight" });
  const m = resolveReportTheme("Midnight", []);
  assert.equal(m?.kind, "create");
  assert.equal(m?.kind === "create" && m.theme.colors.background, "#0f1524");
  const hc = resolveReportTheme("the Healthcare Analytics theme", []);
  assert.equal(hc?.kind === "create" && hc.theme.colors.primary, "#1D4E6B");
  assert.equal(hc?.kind === "create" && hc.name, "Healthcare Analytics");
  assert.deepEqual(resolveReportTheme("Sparkles", []), { kind: "unknown", name: "Sparkles" });
});
