// One respondent answering best == worst on one MaxDiff task: effect on the aggregate model.
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { maxdiffPlugin } from "/home/claude/rescript/packages/designs/dist/index.js";
import { mulberry32 } from "/home/claude/rescript/packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "/home/claude/rescript/packages/analytics/dist/index.js";
import { writeFileSync } from "node:fs";
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const items = ["Battery", "Camera", "Screen", "Price", "Speed", "Design"];
const md = maxdiffPlugin.generate({ items, itemsPerTask: 4, tasks: 9, versions: 1 }, 7);
const def = SurveyDefinition.parse({ meta: { id: "syn", code: "SYN", title: "S", version: "1.0" },
  designs: [{ id: "d_md", kind: "maxdiff", name: "MD", config: { items, itemsPerTask: 4 }, file: { format: "json", columns: md.columns, rows: md.rows } }],
  questions: [{ id: "q_md", code: "Q17", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }] });
const MD_U = [1.5, 0.8, 0.2, -0.2, -0.8, -1.5]; const gumbel = (r) => -Math.log(-Math.log(Math.max(r(), 1e-9)));
const r = mulberry32(3);
const make = (poison) => { const rows = []; for (let i = 0; i < 200; i++) { const mdAns = {}; for (const t of new Set(md.rows.map((x) => String(x.task)))) { const alts = md.rows.filter((x) => String(x.task) === t); const u = alts.map((a) => MD_U[Number(a.item_index) - 1] + gumbel(r)); const bi = u.indexOf(Math.max(...u)); const rest = alts.map((_, k) => k).filter((k) => k !== bi); const uw = rest.map((k) => -MD_U[Number(alts[k].item_index) - 1] + gumbel(r)); mdAns[t] = { best: String(alts[bi].item_index), worst: String(alts[rest[uw.indexOf(Math.max(...uw))]].item_index) }; }
  if (poison && i === 0) mdAns["1"] = { best: mdAns["1"].best, worst: mdAns["1"].best };
  rows.push({ id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, seed: i, started_at: "2026-06-01T10:00:00Z", completed_at: "2026-06-01T10:10:00Z", answers: { q_md: mdAns }, calculated: {}, embedded: {}, flags: [] }); } return rows; };
const spec = { environment: "LIVE", dataset: "all" };
for (const poison of [false, true]) {
  const ds = buildDataset(def, make(poison), { spec });
  const m = runAnalysis({ name: "maxdiff", kind: "maxdiff", dataset: spec, variables: ["MD"] }, ds);
  const t = m.tables.find((x) => x.id === "maxdiff");
  log(`## poison=${poison} (one respondent, one task, best==worst):`, "error:", JSON.stringify(m.error ?? null), "| warnings:", JSON.stringify(m.warnings));
  log("   rows:", (t?.rows ?? []).map((x) => `${x.item}:${x.utility}/${x.share}`).join("  "));
  log("   fit:", JSON.stringify((m.tables.find((x) => x.id === "fit")?.rows ?? []).map((x) => `${x.m}=${x.v}`)));
}
writeFileSync("/tmp/audit/method/05-maxdiff-bestworst-same.out.txt", out.join("\n"));
