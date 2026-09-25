import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMenuGroups, groupOfTab, fitGroups, menuKey, TAB_DESCRIPTIONS } from "./menubar.ts";

const NAV = [
  { key: "questions", label: "Questions", group: "Programming" },
  { key: "logic", label: "Logic", group: "Programming" },
  { key: "designs", label: "Design Generators", group: "Research tools" },
  { key: "tests", label: "Tests", group: "Research tools" },
  { key: "data", label: "Data", group: "Results" },
  { key: "fieldwork", label: "Fieldwork", group: "Results" },
  { key: "project", label: "Project", group: "Management" },
  { key: "json", label: "JSON", group: "Management" },
];

test("the groups are the sidebar's four, in order, with every NAV entry and the analytics link after Data", () => {
  const g = buildMenuGroups(NAV, { analyticsHref: "/analytics?survey=x" });
  assert.deepEqual(g.map((x) => x.label), ["Programming", "Research Tools", "Results", "Management"]);
  assert.deepEqual(g[0].items.map((i) => i.key), ["questions", "logic"]);
  assert.deepEqual(g[2].items.map((i) => i.key), ["data", "analytics", "fieldwork"]);
  assert.equal(g[2].items[1].href, "/analytics?survey=x");
  const all = g.flatMap((x) => x.items.map((i) => i.key)).filter((k) => k !== "analytics");
  assert.deepEqual(all, NAV.map((n) => n.key), "nothing lost, nothing invented");
  for (const i of g.flatMap((x) => x.items)) assert.ok(i.description, `${i.key} has a description`);
  assert.equal(buildMenuGroups(NAV)[2].items.length, 2, "no analytics link without a href");
  // a NAV group the menubar does not name still gets a home
  const extra = buildMenuGroups([...NAV, { key: "zzz", label: "Zzz", group: "Experimental" }]);
  assert.equal(extra[4].label, "Experimental");
  assert.equal(extra[4].items[0].key, "zzz");
});

test("groupOfTab finds the owner; every real tab key has a description", () => {
  const g = buildMenuGroups(NAV);
  assert.equal(groupOfTab(g, "json")?.key, "management");
  assert.equal(groupOfTab(g, "nope"), null);
  for (const k of ["questions", "settings", "flow", "logic", "variables", "calculations", "quotas", "listfill", "designs", "branding", "assets", "localization", "scripts", "tests", "data", "fieldwork", "project", "usage", "distribution", "versions", "json", "collaborators", "notes", "activity"]) {
    assert.ok(TAB_DESCRIPTIONS[k], k);
  }
});

test("fitGroups folds from the right and reserves the More button", () => {
  assert.deepEqual(fitGroups([100, 120, 80, 110], 500, 60), { visible: 4, overflow: false });
  assert.deepEqual(fitGroups([100, 120, 80, 110], 400, 60), { visible: 3, overflow: true }, "60 + 100 + 120 + 80 = 360 fits; + 110 does not");
  assert.deepEqual(fitGroups([100, 120, 80, 110], 300, 60), { visible: 2, overflow: true });
  assert.deepEqual(fitGroups([100, 120, 80, 110], 100, 60), { visible: 0, overflow: true }, "everything folds; the bar is just More");
  assert.deepEqual(fitGroups([], 100, 60), { visible: 0, overflow: false });
});

test("menubar keys: arrows move and switch, down opens, escape closes and returns focus", () => {
  const closed = { open: -1, item: -1 };
  assert.deepEqual(menuKey(closed, "ArrowRight", 4, 0, 3), { open: -1, item: -1, focus: 0 }, "wraps");
  assert.deepEqual(menuKey(closed, "ArrowLeft", 4, 0, 0), { open: -1, item: -1, focus: 3 });
  assert.deepEqual(menuKey(closed, "ArrowDown", 4, 5, 1), { open: 1, item: 0 });
  assert.deepEqual(menuKey(closed, "Enter", 4, 5, 2), { open: 2, item: 0 });
  assert.deepEqual(menuKey(closed, "ArrowUp", 4, 5, 2), { open: 2, item: 4 }, "up from closed lands on the last item");
  assert.equal(menuKey(closed, "Escape", 4, 5, 2), null);
  assert.equal(menuKey(closed, "Home", 4, 5, 2), null);
  const open = { open: 1, item: 2 };
  assert.deepEqual(menuKey(open, "ArrowDown", 4, 5, 1), { open: 1, item: 3 });
  assert.deepEqual(menuKey({ open: 1, item: 4 }, "ArrowDown", 4, 5, 1), { open: 1, item: 0 }, "wraps inside");
  assert.deepEqual(menuKey({ open: 1, item: 0 }, "ArrowUp", 4, 5, 1), { open: 1, item: 4 });
  assert.deepEqual(menuKey(open, "ArrowRight", 4, 5, 1), { open: 2, item: 0 }, "switches the open menu");
  assert.deepEqual(menuKey(open, "End", 4, 5, 1), { open: 1, item: 4 });
  assert.deepEqual(menuKey(open, "Escape", 4, 5, 1), { open: -1, item: -1, focus: 1 });
  assert.equal(menuKey(open, "Enter", 4, 5, 1), null, "Enter on an item is the item's own click");
  assert.equal(menuKey(open, "a", 4, 5, 1), null);
});
