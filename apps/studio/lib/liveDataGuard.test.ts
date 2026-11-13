import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { guardLiveData, liveResponseTotal } from "./liveDataGuard.ts";

const def = (questions: unknown[], ids: string[]) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" }, questions,
  flow: [{ type: "page", id: "p1", questionIds: ids }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const Q1 = { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "One", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] };
const Q2 = { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Two" };
const Q3 = { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Three (added after publishing)" };

/** the four reads the guard makes, over plain rows */
function fakeDb(o: { live: number; softDelete?: boolean; liveVersion?: unknown; draft?: unknown; current?: unknown }) {
  const calls: string[] = [];
  const db = {
    calls,
    from(table: string) {
      const f: Record<string, unknown> = {};
      const q: any = {
        select() { return q; }, eq(c: string, v: unknown) { f[c] = v; return q; },
        is(c: string) { f[`is:${c}`] = true; return q; },
        single: async () => {
          calls.push(`${table}:single`);
          if (table === "survey_versions") return { data: f.id === "v_live" ? { definition: o.liveVersion } : f.id === "v_cur" ? { definition: o.current } : null };
          if (table === "surveys") return { data: { draft_definition: o.draft ?? null, current_version_id: o.current ? "v_cur" : null } };
          return { data: null };
        },
        then(res: (v: unknown) => void) {
          calls.push(`${table}:list`);
          if (table === "responses") {
            if (f["is:deleted_at"] && o.softDelete === false) return res({ count: null, error: { message: "column deleted_at does not exist" } });
            return res({ count: f.is_test === false ? o.live : 0, error: null });
          }
          if (table === "deployments") return res({ data: o.liveVersion ? [{ version_id: "v_live" }] : [] });
          return res({ data: [] });
        },
      };
      return q;
    },
  };
  return db;
}

test("no live responses: one count, nothing read, nothing changed — deletion is deletion", async () => {
  const db = fakeDb({ live: 0, liveVersion: def([Q1, Q2], ["q1", "q2"]) });
  const incoming = def([Q1], ["q1"]);
  const r = await guardLiveData(db, "s", incoming);
  assert.equal(r.definition, incoming); assert.deepEqual(r.kept, []); assert.equal(r.liveResponses, 0);
  assert.deepEqual(db.calls, ["responses:list"]);
});

test("one live response: a question missing from the incoming definition is kept, hidden", async () => {
  const db = fakeDb({ live: 1, liveVersion: def([Q1, Q2], ["q1", "q2"]) });
  const r = await guardLiveData(db, "s", def([Q1], ["q1"]), null);
  assert.deepEqual(r.kept.map((k) => [k.kind, k.questionCode]), [["question", "Q2"]]);
  assert.equal(r.definition.questions.find((q) => q.id === "q2")!.settings.hidden, true);
  assert.deepEqual((r.definition.flow[0] as { questionIds: string[] }).questionIds, ["q1", "q2"]);
});

test("the live version AND what the row held are both baselines; an option removed is kept too", async () => {
  const draft = def([Q1, Q2, Q3], ["q1", "q2", "q3"]);
  const db = fakeDb({ live: 3, liveVersion: def([Q1, Q2], ["q1", "q2"]), draft });
  const incoming = def([{ ...Q1, options: [{ code: 1, label: "Yes" }] }], ["q1"]);
  const r = await guardLiveData(db, "s", incoming);
  assert.deepEqual(r.kept.map((k) => `${k.kind}:${k.questionCode}:${k.code ?? ""}`).sort(), ["option:Q1:2", "question:Q2:", "question:Q3:"]);
  assert.equal(r.definition.questions.find((q) => q.id === "q1")!.options[1].logic?.visibility, "always_hide");
  SurveyDefinition.parse(r.definition);
});

test("an unchanged or merely reworded definition passes through untouched", async () => {
  const live = def([Q1, Q2], ["q1", "q2"]);
  const db = fakeDb({ live: 5, liveVersion: live, draft: live });
  const incoming = def([{ ...Q1, text: "One, reworded" }, Q2], ["q1", "q2"]);
  const r = await guardLiveData(db, "s", incoming);
  assert.equal(r.definition, incoming); assert.deepEqual(r.kept, []);
});

test("a database without soft delete still counts its live responses", async () => {
  assert.equal(await liveResponseTotal(fakeDb({ live: 4, softDelete: false }), "s"), 4);
});
