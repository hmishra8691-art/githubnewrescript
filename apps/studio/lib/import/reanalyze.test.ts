import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSource, clarifications, mapCanonical, buildReport } from "@rescript/import";
import { reanalyze, mergeDecisions } from "./reanalyze.ts";
import { digestReport, memorySessionStore, type ImportSession } from "./sessions.ts";

/** I5 — answering an import's open questions re-runs it from its session, remembering every decision */
const doc = readFileSync(new URL("../../../../packages/import/corpus/brand-instructions.txt", import.meta.url), "utf8");

async function session(over: Partial<ImportSession> = {}): Promise<ImportSession> {
  const c = (await readSource(new TextEncoder().encode(doc), "brand.txt")).canonical!;
  const m = mapCanonical(c, { surveyId: "s" });
  const r = buildReport({ format: "text", platform: "document", importType: "x", label: "Plain-text questionnaire", confidence: "high", reasons: [] } as never, c, m, "full");
  const store = memorySessionStore();
  const s = await store.create({ customerId: null, userId: null, surveyId: null, into: "new", scope: "full", fileName: "brand.txt", format: "text", platform: "document", fingerprint: "f", sizeBytes: 1, reportDigest: digestReport(r), canonical: c, decisions: [], priorDefinition: null, error: null }, null);
  return { ...s, ...over };
}

test("re-analysis applies the decisions, keeps them by id (a later answer replaces an earlier one) and returns a new preview", async () => {
  const s = await session();
  const asks = clarifications(s.canonical as never);
  const rnd = asks.find((x) => x.kind === "randomize_scope")!;
  const first = reanalyze(s, [rnd.alternatives[0].decision]);
  assert.ok(!("error" in first));
  if ("error" in first) return;
  assert.deepEqual(first.applied, [rnd.id]);
  assert.equal(first.report.clarifications.length, asks.length - 1);
  assert.ok(first.definition && first.verification && !("error" in first.verification));
  /* the same question answered again: the new answer replaces the old one */
  const second = reanalyze({ ...s, decisions: first.decisions }, [rnd.recommended!.decision]);
  if ("error" in second) throw new Error(second.error);
  assert.equal(second.decisions.length, 1);
  const s2 = second.definition!.questions.find((q) => q.code === "S2")!;
  assert.ok(s2.options.find((o) => o.label === "Other")!.flags.includes("anchor_bottom"), "Other is fixed at the end");
  assert.equal(second.report.source.label, "Plain-text questionnaire", "the report names the source as it was detected");
});

test("refusals: no stored model, an applied import, a merge without its prior survey", async () => {
  const r1 = reanalyze(await session({ canonical: null }), []); assert.equal("error" in r1 && r1.status, 410);
  const r2 = reanalyze(await session({ status: "applied" }), []); assert.equal("error" in r2 && r2.status, 409);
  const r3 = reanalyze(await session({ into: "merge", priorDefinition: null }), []); assert.equal("error" in r3 && r3.status, 410);
  assert.deepEqual(mergeDecisions([{ id: "a", type: "dismiss" }, { id: "b", type: "dismiss" }], [{ id: "a", type: "display", questionId: "Q1", when: { t: "const", value: true } }]).map((d) => d.type), ["display", "dismiss"]);
});
