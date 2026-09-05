/**
 * Writes the Master Demo survey and everything a programmer would want next to
 * it into docs/master-demo/:
 *
 *   MASTER_DEMO_2026_v1.json            the complete definition (import via Studio → JSON → import .json)
 *   MASTER_DEMO_2026_v1_variables.xlsx  the variable dictionary (Variables + Loops sheets)
 *   MASTER_DEMO_2026_v1_variables.csv
 *   designs/*.csv                       the generated Conjoint, MaxDiff and custom design files
 *   OUTLINE.md                          block → page → question outline with the [DEMO] notes
 *   TEST-PATHS.md                       the seven test paths with the engine's predicted route
 *
 *   node scripts/master-demo-export.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildMasterDemoSurvey, MASTER_DEMO_TEST_PATHS, simulateRespondent } from "../packages/templates/dist/index.js";
import { exportSurveyJson, exportVariableDictionaryXlsx, variableDictionaryToCSV } from "../packages/exporters/dist/index.js";
import { designToCSV, designFileName } from "../packages/designs/dist/index.js";
import { buildVariableDictionary, countRespondentQuestions, lintSurveyLogic } from "../packages/engine/dist/index.js";

const OUT = new URL("../docs/master-demo/", import.meta.url).pathname;
mkdirSync(`${OUT}designs`, { recursive: true });

const def = buildMasterDemoSurvey("00000000-0000-0000-0000-00000000demo");
const base = `${def.meta.code}_v${def.meta.version}`;

writeFileSync(`${OUT}${base}.json`, exportSurveyJson(def));
writeFileSync(`${OUT}${base}_variables.csv`, variableDictionaryToCSV(def));
writeFileSync(`${OUT}${base}_variables.xlsx`, await exportVariableDictionaryXlsx(def));
for (const d of def.designs) {
  writeFileSync(`${OUT}designs/${designFileName(d.kind, d.name, d.version, "csv")}`, designToCSV(d.file));
  writeFileSync(`${OUT}designs/${designFileName(d.kind, d.name, d.version, "json")}`, JSON.stringify({ id: d.id, kind: d.kind, name: d.name, version: d.version, seed: d.seed, config: d.config, summary: undefined, file: d.file }, null, 2));
}

/* ------------------------------------------------------------ outline */

const q = (id) => def.questions.find((x) => x.id === id);
const lines = [];
lines.push(`# ${def.meta.title} — outline`, "");
lines.push(`Code \`${def.meta.code}\` · version ${def.meta.version} · ${countRespondentQuestions(def)} respondent-facing questions, ${def.questions.length} questions in total, ${buildVariableDictionary(def).length} variables · lint issues: ${lintSurveyLogic(def).length}`, "");
lines.push("Every block title is programmer-facing (block titles are hidden from respondents). `[DEMO: …]` notes say what each question demonstrates.", "");
const condText = (c) => c ? " *(conditional)*" : "";
const walk = (nodes, depth) => {
  const ind = "  ".repeat(depth);
  for (const n of nodes) {
    switch (n.type) {
      case "block": case "section":
        lines.push(`${ind}- **${n.title ?? n.id}**${condText(n.visibleIf)}`); walk(n.children, depth + 1); break;
      case "page":
        lines.push(`${ind}- Page \`${n.id}\` — ${n.title ?? ""}${condText(n.visibleIf)}`);
        for (const qid of n.questionIds) {
          const x = q(qid); if (!x) continue;
          const flags = [x.type, x.required ? "required" : null, x.displayLogic ? "display logic" : null, x.skipLogic?.length ? "skip logic" : null,
            x.carryForward ? "carry-forward" : null, x.optionPipeline?.length ? "list ops" : null, x.mask ? "mask" : null, x.punches?.length ? "auto-punch" : null,
            x.randomization?.enabled ? "randomized" : null, x.validation?.length ? "validation" : null].filter(Boolean).join(", ");
          lines.push(`${ind}  - \`${x.code}\` **${x.variableName}** (${flags}) — ${x.text.replace(/<[^>]+>/g, "").slice(0, 110)}${x.notes ? `\n${ind}    - ${x.notes}` : ""}`);
        }
        break;
      case "loop":
        lines.push(`${ind}- 🔁 **${n.title ?? n.id}** — loopVar \`${n.loopVar}\`, source ${JSON.stringify(n.source)}${n.order ? `, order ${JSON.stringify(n.order)}` : ""}${n.count ? `, count ${JSON.stringify(n.count)}` : ""}${n.references ? `, references [${n.references.columns.map((c) => c.name).join(", ")}]` : ""}`);
        walk(n.children, depth + 1); break;
      case "branch":
        lines.push(`${ind}- ⑂ **Branch ${n.id}**`);
        for (const b of n.branches) { lines.push(`${ind}  - ${b.label ?? b.id}`); walk(b.children, depth + 2); }
        if (n.otherwise) { lines.push(`${ind}  - otherwise`); walk(n.otherwise, depth + 2); }
        break;
      case "randomizer": lines.push(`${ind}- 🎲 **${n.title ?? n.id}** (show ${n.show ?? "all"})`); walk(n.children, depth + 1); break;
      case "quota_check": lines.push(`${ind}- ⛔ Quota check ${n.quotaIds.join(", ")} → ${n.onFull.kind}`); break;
      case "embedded_data": lines.push(`${ind}- 🔗 Embedded data: ${n.fields.map((f) => `${f.name} (${f.source})`).join(", ")}`); break;
      case "end": lines.push(`${ind}- 🏁 End \`${n.id}\` (${n.status})`); break;
    }
  }
};
walk(def.flow, 0);
lines.push("", "## Calculations", "", ...def.calculations.map((c) => `- \`${c.targetVariable}\` = \`${c.expression}\` (${c.trigger})${c.notes ? ` — ${c.notes}` : ""}`));
lines.push("", "## Quotas", "", ...def.quotas.map((x) => `- **${x.name}** (${x.mode}${x.targetTotal ? `, base ${x.targetTotal}` : ""}): ${x.cells.map((c) => `${c.label} = ${c.limit}${c.limitType === "percent" ? "%" : ""}`).join("; ")}`));
lines.push("", "## List Fills", "", ...def.listFills.map((lf) => `- **${lf.name}** — ${lf.label}\n  - source ${JSON.stringify(lf.source)}, count ${JSON.stringify(lf.selection.count)}, method ${lf.selection.method}, after maximum ${lf.selection.afterMaximum}, fallback ${lf.selection.fallback}\n  - options: ${lf.options.map((o) => `${o.label ?? o.code}${o.priority ? ` p${o.priority}` : ""}${o.maximum ? ` max ${o.maximum}` : ""}${o.target ? ` target ${o.target}` : ""}`).join("; ")}\n  - destinations: ${lf.destinations.map((d) => `${d.questionId}@${d.position}`).join(", ") || "piping only"}`));
lines.push("", "## Scripts", "", ...def.scripts.map((s) => `- **${s.name}** — ${s.scope}${s.ref ? ` ${s.ref}` : ""} / ${s.event}`));
lines.push("", "## Designs", "", ...def.designs.map((d) => `- **${d.name}** (${d.kind}, v${d.version}, seed ${d.seed}) — ${d.file.rows.length} rows, columns ${d.file.columns.join(", ")} → \`designs/${designFileName(d.kind, d.name, d.version, "csv")}\``));
writeFileSync(`${OUT}OUTLINE.md`, lines.join("\n") + "\n");

/* ------------------------------------------------------------ test paths */

const tp = ["# Test paths", "", "Each path is a set of answers the tester enters; everything not listed can be answered freely. The route below is what the engine predicts (`simulateRespondent`), so a Test-Mode run can be checked against it page by page.", ""];
for (const p of MASTER_DEMO_TEST_PATHS) {
  const extra = p.id === "E" ? { quotaCounts: { quota_gender: { qg_female: 150 }, quota_gender_age: { qga_f_2534: 45 } } }
    : p.id === "F" ? { listFillCounts: { lf_brand_eval: { "1": 150 } } } : {};
  const res = simulateRespondent(def, { answers: p.answers, seed: p.seed, ...extra });
  tp.push(`## Path ${p.id} — ${p.title}`, "", p.description, "");
  if (p.id === "E") tp.push("Precondition: the female / 25–34 cells are already full (in Test Mode: set the quota counts, or run enough test completes).", "");
  if (p.id === "F") tp.push("Precondition: Apple has already been allocated 150 times in LF_BRAND_EVAL.", "");
  tp.push("Key answers:", "", "```json", JSON.stringify(Object.fromEntries(Object.entries(p.answers).filter(([k]) => /q_consent|q_aware|q_used|q_trusted|q_fav_brand|q_years_used|q_detail_interest|q_n_products|q_gender|q_age|q_use_type|q_employment/.test(k))), null, 2), "```", "");
  tp.push("Expected:", "", ...p.expect.map((e) => `- ${e}`), "");
  tp.push(`Predicted route (${res.pages.length} pages, end status **${res.endStatus}**):`, "");
  tp.push("`" + res.pages.map((pg) => pg.pageId).join("` → `") + "`", "");
  const lf = res.listFills.map((l) => `${l.listFillId}: ${l.items.map((i) => i.label).join(", ") || "—"}`);
  if (lf.length) tp.push("List Fill results: " + lf.join(" · "), "");
}
writeFileSync(`${OUT}TEST-PATHS.md`, tp.join("\n") + "\n");

console.log(`wrote ${OUT}`);
console.log(`  ${base}.json (${(exportSurveyJson(def).length / 1024).toFixed(0)} KB), variables .xlsx/.csv, ${def.designs.length} design files, OUTLINE.md, TEST-PATHS.md`);
