import { customPlugin } from "/home/claude/rescript/packages/designs/dist/index.js";
// what the Studio DesignsPanel "list" field produces for columnsSpec (textarea, one string per line)
const fromStudio = { rows: 10, versions: 1, columnsSpec: ["price", "brand"] };
console.log("Studio-shaped config validateConfig:", customPlugin.validateConfig(fromStudio));
try { const f = customPlugin.generate(fromStudio, 1); console.log("generate ->", f.columns, f.rows.length); } catch (e) { console.log("generate threw:", e.message); }
// the shape the plugin actually expects
const proper = { rows: 5, versions: 1, columnsSpec: [{ name: "seq", kind: "sequence" }, { name: "price", kind: "random_level", levels: ["low", "high"] }, { name: "note", kind: "expression", expression: "price * 2" }] };
console.log("proper config validateConfig:", customPlugin.validateConfig(proper));
const f = customPlugin.generate(proper, 1); console.log("generate ->", f.columns, JSON.stringify(f.rows.slice(0, 2)));
console.log("configFields:", JSON.stringify(customPlugin.configFields));
