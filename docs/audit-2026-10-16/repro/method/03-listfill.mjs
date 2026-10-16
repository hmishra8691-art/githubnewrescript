// ListFill engine audit (pure engine; the Postgres claim path is NOT exercised here).
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { decideListFill, pendingListFills, listFillVariables, applyListFillDestinations, unusedListFillDestinations, listFillHiddenDestinations, allocationPayload, listFillCandidates, resolveListFillCount, simulateListFill, visibleQuestions, buildVariableDictionary, confirmListFill } from "/home/claude/rescript/packages/engine/dist/index.js";
import { writeFileSync } from "node:fs";
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

const base = {
  meta: { id: "s", code: "S", title: "List fill", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands?", options: [{ code: "A", label: "Apple" }, { code: "B", label: "Beta" }, { code: "C", label: "Gamma" }, { code: "D", label: "Delta" }, { code: "E", label: "Epsilon" }] },
    { id: "q2", code: "Q2", variableName: "PICK", type: "single_select", text: "Rate {{LISTFILL_Q1_1}}", options: [{ code: "x", label: "x" }] },
    { id: "q3", code: "Q3", variableName: "PICK2", type: "single_select", text: "Rate {{LISTFILL_Q1_2}}", options: [{ code: "x", label: "x" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
};
const withLF = (lf) => SurveyDefinition.parse({ ...base, listFills: [lf] });
const lfBase = (extra = {}, selection = {}) => ({
  id: "lf1", name: "Q1", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority", ...selection },
  tracking: { sampleLevel: true },
  options: [{ code: "A", priority: 1, maximum: 150 }, { code: "B", priority: 2, maximum: 75 }, { code: "C", priority: 3, maximum: 50 }, { code: "D" }, { code: "E" }],
  destinations: [{ questionId: "q2", write: "answer", whenUnused: "hide" }, { questionId: "q3", write: "answer", whenUnused: "hide" }],
  ...extra,
});
const st = (answers, seed = 42, calculated = {}) => ({ surveyId: "s", surveyVersion: "1", sessionId: "sess1", seed, startedAt: "2026-09-01T10:00:00Z", status: "in_progress", answers, embedded: {}, calculated, flags: [], stepIndex: 0 });

/* 1. canonical sequence */
log("## 1. Priority / cap sequence (A 150 > B 75 > C 50 > random D/E)");
const def = withLF(lfBase());
for (const [label, counts] of [["open", {}], ["A 149", { A: 149 }], ["A 150", { A: 150 }], ["A150 B75", { A: 150, B: 75 }], ["A150 B75 C50", { A: 150, B: 75, C: 50 }]]) {
  const r = decideListFill({ def, listFill: def.listFills[0], state: st({ q1: ["A", "B", "C", "D", "E"] }), counts: { lf1: counts } });
  log(`  ${label}: →`, r.items.map((i) => i.code).join(","), "| preference", r.preference.join(">"));
}
/* 2. determinism + spread of random fallback */
const picks = {};
for (let s = 1; s <= 500; s++) { const r = decideListFill({ def, listFill: def.listFills[0], state: st({ q1: ["A", "B", "C", "D", "E"] }, s), counts: { lf1: { A: 150, B: 75, C: 50 } } }); picks[r.items[0]?.code] = (picks[r.items[0]?.code] ?? 0) + 1; }
log("## 2. fallback spread over 500 seeds (D/E only):", JSON.stringify(picks));
const r1 = decideListFill({ def, listFill: def.listFills[0], state: st({ q1: ["D", "E"] }, 7) }), r2 = decideListFill({ def, listFill: def.listFills[0], state: st({ q1: ["D", "E"] }, 7) });
log("  deterministic for same seed:", r1.items[0].code === r2.items[0].code);

/* 3. dedup of source list */
log("## 3. dedup: source [A,A,B,B] →", JSON.stringify(listFillCandidates(def, def.listFills[0], st({ q1: ["A", "A", "B", "B"] })).map((c) => c.code)), "(candidates not deduped) → decide:", decideListFill({ def, listFill: { ...def.listFills[0], selection: { ...def.listFills[0].selection, count: { kind: "all" } } }, state: st({ q1: ["A", "A", "B", "B"] }) }).items.map((i) => i.code).join(","));

/* 4. EMPTY source: pending? unused destinations? */
log("## 4. empty source (respondent selected nothing)");
const s4 = st({ q1: [] });
log("  pendingListFills:", pendingListFills(def, s4).map((l) => l.id).join(",") || "(none — list never runs)");
log("  unusedListFillDestinations:", JSON.stringify([...unusedListFillDestinations(def, s4)]));
log("  listFillHiddenDestinations:", JSON.stringify([...listFillHiddenDestinations(def, s4)]));
const page2 = { kind: "page", id: "p2", questionIds: ["q2", "q3"] };
const vis4 = visibleQuestions(def, page2, s4).map((q) => q.id);
log("  visibleQuestions:", vis4.join(","), "→ q2/q3 (whenUnused=hide) still shown:", vis4.includes("q2") && vis4.includes("q3"));
// contrast: list ran but allocated 1 of 2
const s4b = st({ q1: ["A"] });
const lf2 = { ...def.listFills[0], selection: { ...def.listFills[0].selection, count: { kind: "fixed", n: 2 } } };
const r4 = decideListFill({ def, listFill: lf2, state: s4b });
Object.assign(s4b.calculated, listFillVariables(lf2, r4));
log("  contrast — list ran with 1 of 2 allocated: hidden =", JSON.stringify([...listFillHiddenDestinations(def, s4b)]), "visible:", visibleQuestions(def, page2, s4b).map((q) => q.id).join(","));

/* 5. fillToCount=false / fallback none — engine vs. allocator payload */
log("## 5. fillToCount=false, fallback=none, count 2, only A under priority (B,C,D,E unprioritised)");
const def5 = withLF(lfBase({ options: [{ code: "A", priority: 1 }, { code: "B" }, { code: "C" }] }, { count: { kind: "fixed", n: 2 }, fillToCount: false, fallback: "none" }));
const r5 = decideListFill({ def: def5, listFill: def5.listFills[0], state: st({ q1: ["A", "B", "C"] }) });
log("  engine items:", r5.items.map((i) => i.code).join(","), "| requestedCount", r5.trace.requestedCount, "| preference sent to DB:", JSON.stringify(allocationPayload(def5.listFills[0], r5)), "| p_count =", r5.trace.requestedCount);
log("  → rescript_allocate_listfill loops p_count slots over the whole preference (0007_list_fill.sql:174-204), so LIVE/TEST would grant", r5.trace.requestedCount, "items where the engine decided", r5.items.length);
// what confirmListFill would do with a DB grant of [A,B]
const c5 = confirmListFill(def5.listFills[0], r5, ["A", "B"]);
log("  confirmListFill(decided, ['A','B']) → items", c5.items.map((i) => i.code).join(","), "| reason:", c5.trace.reason);

/* 6. count kinds: expression */
log("## 6. count kind 'expression'");
const def6 = withLF(lfBase({}, { count: { kind: "expression", expression: "min(2, Q1_COUNT)" } }));
log("  resolveListFillCount with calculated={} →", resolveListFillCount(def6, def6.listFills[0], st({ q1: ["A", "B", "C"] }), 3));
log("  resolveListFillCount with calculated={'min(2, Q1_COUNT)': 2} →", resolveListFillCount(def6, def6.listFills[0], st({ q1: ["A", "B", "C"] }, 1, { "min(2, Q1_COUNT)": 2 }), 3), "(reads state.calculated[<expression text>]; nothing in the engine or runtime evaluates it)");

/* 7. variables + dictionary */
const r7 = decideListFill({ def, listFill: lf2, state: st({ q1: ["B", "A"] }) });
log("## 7. variables:", JSON.stringify(listFillVariables(lf2, r7)));
const dict = buildVariableDictionary(def);
log("  dictionary LISTFILL_* columns:", dict.filter((v) => v.name.startsWith("LISTFILL_")).map((v) => v.name).join(","));

/* 8. destinations write answers */
const s8 = st({ q1: ["B", "A"] });
applyListFillDestinations(lf2, r7, s8);
log("## 8. destinations written:", JSON.stringify({ q2: s8.answers.q2, q3: s8.answers.q3 }));

/* 9. simulator */
const sim = simulateListFill({ def, listFill: def.listFills[0], state: st({ q1: ["A", "B", "C", "D", "E"] }), counts: { lf1: { A: 149, B: 75, C: 20 } }, draws: 100 });
log("## 9. simulate 100 from A149/B75/C20:", JSON.stringify(sim.counts), "empty", sim.empty);

/* 10. 'take: all' list runs before the source question is answered */
const defAll = withLF(lfBase({ source: { kind: "question", questionId: "q1", take: "all" } }));
log("## 10. take=all, nothing answered yet → pending:", pendingListFills(defAll, st({})).map((l) => l.id).join(",") || "(none)");

/* 11. quota interplay — hard quota on allocated brand */
const defQ = SurveyDefinition.parse({ ...base, listFills: [lfBase()], quotas: [{ id: "qa", name: "Apple cap", mode: "hard", targetTotal: 100, cells: [{ id: "c1", label: "Apple", limit: 10, limitType: "count", when: { type: "rule", source: { kind: "calculation", ref: "LISTFILL_Q1_1_CODE" }, operator: "eq", value: "A" } }] }] });
const rq = decideListFill({ def: defQ, listFill: defQ.listFills[0], state: st({ q1: ["A", "B"] }), quotaCounts: { qa: { c1: 10 } } });
log("## 11. hard quota full on A → items:", rq.items.map((i) => i.code).join(","), "| A rejected:", rq.trace.options.find((o) => o.code === "A")?.rejectedBecause);
writeFileSync("/tmp/audit/method/03-listfill.out.txt", out.join("\n"));

/* 12. inert selection settings? */
log("## 12. selection settings the engine does not act on");
const defStop = withLF(lfBase({}, { afterMaximum: "stop" }));
const rStop = decideListFill({ def: defStop, listFill: defStop.listFills[0], state: st({ q1: ["A", "B"] }), counts: { lf1: { A: 150 } } });
log("  afterMaximum='stop', A at max → items:", rStop.items.map((i) => i.code).join(",") || "(none)", "(doc: 'stop — allocate nothing rather than substitute')");
const defRF = withLF(lfBase({}, { afterMaximum: "random_fallback" }));
const rRF = decideListFill({ def: defRF, listFill: defRF.listFills[0], state: st({ q1: ["A", "B", "C"] }), counts: { lf1: { A: 150 } } });
log("  afterMaximum='random_fallback', A at max → items:", rRF.items.map((i) => i.code).join(","), "(always B = next priority)");
let same = 0;
for (let s = 1; s <= 300; s++) {
  const a = decideListFill({ def: withLF(lfBase({}, { fallback: "none", fillToCount: false })), listFill: withLF(lfBase({}, { fallback: "none", fillToCount: false })).listFills[0], state: st({ q1: ["A", "B", "C", "D", "E"] }, s), counts: { lf1: { A: 150, B: 75, C: 50 } } });
  const b = decideListFill({ def, listFill: def.listFills[0], state: st({ q1: ["A", "B", "C", "D", "E"] }, s), counts: { lf1: { A: 150, B: 75, C: 50 } } });
  if (a.items[0]?.code === b.items[0]?.code) same++;
}
log("  fallback none+fillToCount=false vs random_eligible: identical result on", same, "of 300 seeds (the 'random D/E' comes from the unprioritised band + equalPriority, not from `fallback`)");
const defDup = withLF(lfBase({}, { count: { kind: "fixed", n: 3 }, allowDuplicates: true }));
const rDup = decideListFill({ def: defDup, listFill: defDup.listFills[0], state: st({ q1: ["A", "B"] }) });
log("  allowDuplicates=true, count 3, candidates A,B → items:", rDup.items.map((i) => i.code).join(","), "(never duplicates; payload carries no allowDuplicates flag either)");
writeFileSync("/tmp/audit/method/03-listfill.out.txt", out.join("\n"));
