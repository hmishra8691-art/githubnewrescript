// Is there any analysis for ACBC or Menu-based conjoint answers?
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { menuPlugin, acbcPlugin } from "/home/claude/rescript/packages/designs/dist/index.js";
import { normalizeAcbc, emptyAcbcAnswer, submitByo, submitScreen, chooseInTournament, answerRule, acbcDone, primaryMethodsFor } from "/home/claude/rescript/packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "/home/claude/rescript/packages/analytics/dist/index.js";
import { writeFileSync } from "node:fs";
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const acfg = { attributes: [{ name: "Brand", levels: ["A", "B", "C"] }, { name: "Price", levels: ["$1", "$2", "$3"] }, { name: "Size", levels: ["S", "L"] }], screeningTasks: 3, conceptsPerScreen: 3, minTournamentConcepts: 3 };
const mcfg = { items: [{ name: "Base", levels: ["$10", "$15"], required: true }, { name: "Storage", levels: ["$2", "$4"] }, { name: "Support", levels: ["$3", "$5"] }], tasks: 4, versions: 1 };
const menu = menuPlugin.generate(mcfg, 3), aplan = acbcPlugin.generate(acfg, 1);
const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" },
  designs: [{ id: "d_acbc", kind: "acbc", name: "ACBC", config: acfg, file: { format: "json", columns: aplan.columns, rows: aplan.rows } }, { id: "d_menu", kind: "menu", name: "Menu", config: mcfg, file: { format: "json", columns: menu.columns, rows: menu.rows } }],
  questions: [{ id: "q_acbc", code: "Q1", variableName: "ACBC", type: "acbc_task", text: "ACBC", settings: { designRef: "d_acbc" } }, { id: "q_menu", code: "Q2", variableName: "MENU", type: "conjoint_task", variant: "conjoint.menu", text: "Menu", settings: { designRef: "d_menu" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_acbc", "q_menu"] }] });
const cfg = normalizeAcbc(acfg);
const rows = [];
for (let i = 0; i < 60; i++) {
  let a = submitByo(cfg, emptyAcbcAnswer(), i, { Brand: "A", Price: "$1", Size: "S" });
  let guard = 0;
  while (!acbcDone(a) && guard++ < 50) {
    if (a.stage === "screen") { const s = a.screens[a.screens.length - 1]; for (const c of s.concepts) s.verdicts[c.id] = c.profile.Price === "$3" ? "no" : "yes"; a = submitScreen(cfg, a, i); }
    else if (a.stage === "rule") a = answerRule(cfg, a, i, true);
    else if (a.stage === "tournament") { const r = a.tournament[a.tournament.length - 1]; a = chooseInTournament(cfg, a, i, r.concepts[0].id); }
  }
  const menuAns = {}; for (const t of new Set(menu.rows.map((r) => String(r.task)))) menuAns[t] = i % 3 === 0 ? ["none"] : ["2"];
  rows.push({ id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, seed: i, started_at: "2026-06-01T10:00:00Z", completed_at: "2026-06-01T10:10:00Z", answers: { q_acbc: a, q_menu: menuAns }, calculated: {}, embedded: {}, flags: [] });
}
log("ACBC transcripts complete:", rows.filter((r) => acbcDone(r.answers.q_acbc)).length, "of", rows.length);
const spec = { environment: "LIVE", dataset: "all" };
const ds = buildDataset(def, rows, { spec });
log("ACBC columns in dataset:", [...ds.byName.keys()].filter((k) => k.startsWith("ACBC")).join(","));
log("MENU columns in dataset:", [...ds.byName.keys()].filter((k) => k.startsWith("MENU")).join(","));
for (const [kind, v] of [["conjoint", "ACBC"], ["conjoint", "MENU"], ["descriptive", "ACBC_WINNER_Brand"], ["descriptive", "MENU_T1_2"]]) {
  const r = runAnalysis({ name: kind, kind, dataset: spec, variables: [v] }, ds);
  log(`runAnalysis(${kind}, ${v}) → tables ${r.tables.length}, error ${JSON.stringify(r.error ?? null)}, warnings ${JSON.stringify(r.warnings)}`);
}
log("primaryMethodsFor:", JSON.stringify({ acbc: primaryMethodsFor(def.questions[0]), menu: primaryMethodsFor(def.questions[1]) }));
writeFileSync("/tmp/audit/method/08-acbc-menu-analysis.out.txt", out.join("\n"));
