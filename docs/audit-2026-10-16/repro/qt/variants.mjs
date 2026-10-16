import { variantRegistry, BUILTIN_QUESTION_TYPES } from "/home/claude/rescript/packages/schema/dist/index.js";
import "/home/claude/rescript/packages/engine/dist/index.js";
const all = variantRegistry.all ? variantRegistry.all() : [...variantRegistry.values?.() ?? []];
console.log("variant count", all.length);
const byBase = {};
for (const v of all) (byBase[v.baseType] ??= []).push(`${v.id}${v.renderer ? "(" + v.renderer + ")" : ""}${v.supersededBy ? "[superseded]" : ""}${v.status && v.status !== "stable" ? "[" + v.status + "]" : ""}`);
for (const t of BUILTIN_QUESTION_TYPES) console.log(t.padEnd(16), (byBase[t] ?? []).join(", ") || "(no variants)");
const unknownBase = Object.keys(byBase).filter((b) => !BUILTIN_QUESTION_TYPES.includes(b));
console.log("variants with non-builtin base:", unknownBase);
