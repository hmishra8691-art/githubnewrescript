import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceOperation, planUpdate, nextChangeN, withChangeN, canTransition, MemoryOperationStore, fromRow, toRow, toSummary, emptyFields, LIMITS, TRANSITIONS, OP_STATUSES,
  type OperationRecord, type OpStatus,
} from "./operations.ts";
import {
  OpsRecorder, saveFailure, appliedKicker, observeUndo, canRestore, canReapply, reapplyActions, sameSurveyCanonical, isChange, apiCallWords, statusWord, sourceWord,
  type ClientOp, type Send,
} from "./history.ts";
import { tableMissing, storeWithFallback, memoryOf } from "./durable.ts";
import { sameSurvey } from "./client.ts";
import type { SurveyDefinition } from "@rescript/schema";

/*
 * THE OPERATION HISTORY'S PURE PART (Intelligent Mode upgrade, Phase 5):
 * what a client may send (bounded, closed lists), how a record's status may
 * move, how the survey's AI change numbers are handed out (gaps, empty,
 * two at once), the memory store that stands in for the table, the
 * recorder that keeps the page and the server in step, and the history
 * view's helpers — the honest save words, the kicker, the ⌘Z observer,
 * Restore / Reapply.
 */

const def = (n: number, extra: Record<string, unknown> = {}) => ({ meta: { id: "s", code: "S", title: "t", version: "1" }, questions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, code: `Q${i + 1}` })), flow: [], ...extra }) as unknown as SurveyDefinition;

/* ------------------------------------------------------------ coercion */

test("coerceOperation (create): defaults, closed lists, and only the initial statuses", () => {
  const c = coerceOperation({ prompt: "make Q1 required", source: "engine", status: "proposed" }, "create");
  assert.ok(c.ok);
  assert.deepEqual({ ...c.value }, { ...emptyFields(), prompt: "make Q1 required" });
  const d = coerceOperation({}, "create");
  assert.ok(d.ok && d.value.status === "proposed" && d.value.source === "engine", "a bare record is an engine proposal");
  for (const st of ["answered", "refused", "clarify", "failed"]) assert.ok(coerceOperation({ status: st }, "create").ok, st);
  for (const st of ["applied", "saved", "save_failed", "reverted", "cancelled"]) {
    const r = coerceOperation({ status: st }, "create");
    assert.ok(!r.ok && /starts as/.test(r.error), `${st} is reached by an update, not created`);
  }
  const bad = coerceOperation({ status: "done" }, "create");
  assert.ok(!bad.ok && /unknown status “done”/.test(bad.error));
  const src = coerceOperation({ source: "telepathy" }, "create");
  assert.ok(!src.ok && /unknown source/.test(src.error));
  assert.ok(!coerceOperation("x", "create").ok);
  assert.ok(!coerceOperation(null, "update").ok);
});

test("coerceOperation bounds every field: prompt 4000, lists 200, strings 500, a flat intent, small actions", () => {
  const long = "x".repeat(600);
  const c = coerceOperation({
    prompt: "p".repeat(5000),
    intent: { kind: "actions", nested: { a: 1 }, n: 3, ok: true, none: null, long, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])) },
    detected: [{ what: "condition", value: long }, { nothing: 1 }, "x"],
    targets: Array.from({ length: 300 }, (_, i) => `q${i}`),
    proposed: ["Make Q1 required", { description: "Add Q2", action: { op: "create_question", type: "text", text: "Hi" } }, { description: "huge", action: { op: "create_question", text: "y".repeat(LIMITS.actionBytes) } }, { action: { op: "x" } }],
    applied: [long, 5, "", null],
    failed: [{ description: "Delete Q9", reason: "Q9 does not exist" }, "plain"],
    apiCalls: [{ route: "/api/copilot/turn", mode: "edit", charge: 0.01, cached: false, promptChars: 1234.6 }, { mode: "no route" }, { route: "/x", charge: "lots" }],
    engineOps: ["set_required", "y".repeat(100)],
    statusDetail: "d".repeat(3000),
    savedRevision: "7",
  }, "create");
  assert.ok(c.ok);
  const v = c.value;
  assert.equal(v.prompt.length, LIMITS.prompt);
  assert.ok(c.warnings.some((w) => /cut to 4000/.test(w)));
  assert.equal(v.targets.length, LIMITS.items, "lists stop at 200");
  assert.equal(v.intent.long!.toString().length, LIMITS.text);
  assert.equal("nested" in v.intent, false, "nested values are not an intent's business");
  assert.ok(Object.keys(v.intent).length <= LIMITS.intentKeys);
  assert.deepEqual([v.intent.n, v.intent.ok, v.intent.none], [3, true, null]);
  assert.deepEqual(v.detected.map((d) => d.value.length), [LIMITS.text], "a detection with neither part is dropped");
  assert.deepEqual(v.proposed.map((p) => [p.description, !!p.action]), [["Make Q1 required", false], ["Add Q2", true], ["huge", false]]);
  assert.ok(c.warnings.some((w) => /kept as words only/.test(w)), "an action too big for Reapply is said");
  assert.deepEqual(v.applied.map((a) => a.length), [LIMITS.text, 1], "strings ≤ 500; empties dropped; numbers as text");
  assert.deepEqual(v.failed, [{ description: "Delete Q9", reason: "Q9 does not exist" }, { description: "plain", reason: "" }]);
  assert.deepEqual(v.apiCalls, [{ route: "/api/copilot/turn", mode: "edit", charge: 0.01, cached: false, promptChars: 1235 }, { route: "/x", charge: 0 }]);
  assert.equal(v.engineOps[1].length, 60);
  assert.equal(v.statusDetail!.length, LIMITS.detail);
  assert.equal(v.savedRevision, null, "a revision is a number");
});

test("coerceOperation: before / after — a survey ≤ 2 MB, kept only once applied (dropped with a warning otherwise)", () => {
  const created = coerceOperation({ status: "proposed", before: def(2), after: def(3) }, "create");
  assert.ok(created.ok && !("before" in created.value) && !("after" in created.value));
  assert.ok(created.warnings.some((w) => /kept only once an operation is applied/.test(w)));
  const u = coerceOperation({ status: "applied", before: def(2), after: def(3) }, "update");
  assert.ok(u.ok && u.value.before && u.value.after);
  const notDef = coerceOperation({ status: "applied", before: { hello: 1 } }, "update");
  assert.ok(notDef.ok && notDef.value.before === undefined && notDef.warnings.some((w) => /not a survey definition/.test(w)));
  const big = def(1, { notes: "z".repeat(LIMITS.snapshotBytes + 10) });
  const tooBig = coerceOperation({ status: "applied", after: big }, "update");
  assert.ok(tooBig.ok && tooBig.value.after === undefined && tooBig.warnings.some((w) => /over the 2 MB/.test(w)));
  const src = coerceOperation({ source: "model", status: "saved" }, "update");
  assert.ok(src.ok && !("source" in src.value) && src.warnings.some((w) => /does not change/.test(w)), "the source of a record never changes");
  const missing = coerceOperation({ statusDetail: null }, "update");
  assert.ok(missing.ok);
  assert.deepEqual(missing.value, { statusDetail: null }, "an update carries only the keys sent");
});

/* ------------------------------------------------------------ transitions */

test("the status transitions: the allowed ones, and every other one refused", () => {
  const allowed: [OpStatus, OpStatus][] = [
    ["proposed", "applied"], ["proposed", "cancelled"], ["proposed", "failed"],
    ["applied", "saved"], ["applied", "save_failed"], ["applied", "reverted"],
    ["saved", "reverted"], ["save_failed", "saved"], ["save_failed", "reverted"], ["reverted", "applied"],
  ];
  for (const from of OP_STATUSES) for (const to of OP_STATUSES) {
    const want = from === to || allowed.some(([a, b]) => a === from && b === to);
    assert.equal(canTransition(from, to), want, `${from} → ${to}`);
  }
  assert.deepEqual(TRANSITIONS.answered, [], "a turn that proposed nothing is final");
  const r = planUpdate({ status: "cancelled", changeN: null }, { status: "applied" });
  assert.ok(!r.ok && r.code === 409 && /final/.test(r.error));
  const r2 = planUpdate({ status: "saved", changeN: 2 }, { status: "applied" });
  assert.ok(!r2.ok && /can become reverted/.test(r2.error));
});

test("planUpdate: the first applied asks for a number, a redo keeps its own; surveys only for a status that wrote something", () => {
  const first = planUpdate({ status: "proposed", changeN: null }, { status: "applied", before: def(1), after: def(2) });
  assert.ok(first.ok && first.assignChangeN && first.next.before && first.next.after);
  const redo = planUpdate({ status: "reverted", changeN: 4 }, { status: "applied" });
  assert.ok(redo.ok && !redo.assignChangeN, "reverted → applied keeps #004");
  const same = planUpdate({ status: "proposed", changeN: null }, { prompt: "a → b" });
  assert.ok(same.ok && !same.assignChangeN, "a revision folded into the open proposal is not a transition");
  const cancel = planUpdate({ status: "proposed", changeN: null }, { status: "cancelled", after: def(1) });
  assert.ok(cancel.ok && cancel.next.after === undefined && cancel.warnings.length === 1);
});

/* ------------------------------------------------------------ numbering */

test("nextChangeN: empty, gaps, nulls, and either rows or numbers", () => {
  assert.equal(nextChangeN([]), 1);
  assert.equal(nextChangeN([null, undefined, { changeN: null }]), 1);
  assert.equal(nextChangeN([1, 3]), 4, "a gap is not refilled");
  assert.equal(nextChangeN([{ changeN: 2 }, { changeN: 7 }, { changeN: null }, 5]), 8);
  assert.equal(nextChangeN([{ changeN: Number.NaN }]), 1);
});

test("withChangeN: two changes applied at once get two numbers — the loser of the unique index reads again and retries once", async () => {
  const taken: number[] = [];
  let raced = false;
  const read = async () => [...taken];
  // another request takes the number between our read and our write, once
  const write = async (n: number) => {
    if (!raced) { raced = true; taken.push(n); return { ok: false as const, conflict: true, error: "duplicate key" }; }
    if (taken.includes(n)) return { ok: false as const, conflict: true, error: "duplicate key" };
    taken.push(n); return { ok: true as const, value: `row#${n}` };
  };
  const r = await withChangeN(read, write);
  assert.deepEqual(r, { ok: true, value: "row#2", n: 2 });
  assert.deepEqual(taken, [1, 2]);
  // a conflict every time: one retry, then a sentence — never a duplicate
  const always = await withChangeN(async () => [1], async () => ({ ok: false as const, conflict: true, error: "dup" }));
  assert.ok(!always.ok && /taken by another change/.test(always.error));
  // any other failure is not retried
  let calls = 0;
  const other = await withChangeN(async () => [], async () => { calls++; return { ok: false as const, conflict: false, error: "permission denied" }; });
  assert.ok(!other.ok && other.error === "permission denied" && calls === 1);
});

/* ------------------------------------------------------------ the memory store */

test("the memory store: create, list newest first without the surveys, get with them, update, numbering per survey", async () => {
  const store = new MemoryOperationStore(new Map());
  const f = (prompt: string, status: OpStatus = "proposed") => ({ ...emptyFields(), prompt, status });
  const a = await store.create("S1", f("make Q1 required"), { userId: "u", surveyId: "S1" });
  const b = await store.create("S1", f("what depends on Q1?", "answered"), { userId: "u", surveyId: "S1" });
  const c = await store.create("S1", f("randomize Q2"), { userId: null, surveyId: "S1" });
  await store.create("S2", f("elsewhere"), { userId: null, surveyId: "S2" });
  assert.ok(a.id !== b.id && b.createdAt > a.createdAt, "strictly ordered even within a millisecond");
  const applied = await store.update("S1", a.id, { status: "applied", before: def(1), after: def(2), applied: ["Made Q1 required"], engineOps: ["update_question"] });
  assert.ok(applied.ok && applied.record.changeN === 1 && applied.record.hasBefore);
  const list = await store.list("S1");
  assert.deepEqual(list.map((x) => x.prompt), ["randomize Q2", "what depends on Q1?", "make Q1 required"]);
  assert.ok(list.every((x) => !("before" in x) && !("after" in x)), "the list carries no surveys");
  assert.deepEqual(list.map((x) => x.hasBefore), [false, false, true]);
  const one = await store.get("S1", a.id);
  assert.equal(one!.before!.questions.length, 1);
  assert.equal(one!.after!.questions.length, 2);
  one!.before!.questions.length = 0;
  assert.equal((await store.get("S1", a.id))!.before!.questions.length, 1, "a copy is handed out, the store's row is untouched");
  const second = await store.update("S1", c.id, { status: "applied" });
  assert.ok(second.ok && second.record.changeN === 2, "the survey's next number");
  const s2 = await store.list("S2");
  const other = await store.update("S2", s2[0].id, { status: "applied" });
  assert.ok(other.ok && other.record.changeN === 1, "numbering is per survey");
  // saved, reverted, redone: the number stays
  assert.ok((await store.update("S1", a.id, { status: "saved", savedRevision: 9 })).ok);
  assert.ok((await store.update("S1", a.id, { status: "reverted", statusDetail: "undone with ⌘Z" })).ok);
  const redo = await store.update("S1", a.id, { status: "applied" });
  assert.ok(redo.ok && redo.record.changeN === 1);
  // refused transitions, unknown ids
  const refused = await store.update("S1", b.id, { status: "applied" });
  assert.ok(!refused.ok && refused.status === 409);
  const gone = await store.update("S1", "nope", { status: "cancelled" });
  assert.ok(!gone.ok && gone.status === 404);
  assert.equal(await store.get("S1", "nope"), null);
  assert.equal(store.durable, false);
});

test("the memory store keeps a bounded number of records per survey (oldest first out)", async () => {
  const store = new MemoryOperationStore(new Map());
  for (let i = 0; i < LIMITS.memoryRows + 5; i++) await store.create("S", { ...emptyFields(), prompt: `p${i}` }, { userId: null, surveyId: "S" });
  const list = await store.list("S", 1000);
  assert.equal(list.length, LIMITS.memoryRows);
  assert.equal(list.at(-1)!.prompt, "p5");
});

test("rows: the table's columns ↔ the record", () => {
  const row = { id: "r1", survey_id: "S", created_by: null, created_at: "2026-10-05T10:00:00Z", change_n: 3, prompt: "x", source: "model", intent: { mode: "edit" }, detected: [], targets: ["q1"], proposed: [], applied: ["a"], excluded: [], failed: [], warnings: [], engine_ops: ["set_required"], api_calls: [{ route: "/api/copilot/turn", charge: 0.2 }], status: "saved", status_detail: null, saved_revision: 12, has_before: "{}", has_after: null };
  const r = fromRow(row);
  assert.equal(r.changeN, 3); assert.equal(r.updatedAt, row.created_at); assert.deepEqual(r.engineOps, ["set_required"]);
  assert.equal(r.hasBefore, true); assert.equal(r.hasAfter, false, "the list's `before->>meta` says whether a survey was kept");
  assert.equal(fromRow({ id: "x", status: "weird", source: "weird" }).status, "proposed");
  assert.deepEqual(toRow({ engineOps: ["a"], apiCalls: [], statusDetail: null, savedRevision: 4 }), { engine_ops: ["a"], api_calls: [], status_detail: null, saved_revision: 4 });
  const full: OperationRecord = { ...r, before: def(1), after: null };
  assert.deepEqual(Object.keys(toSummary(full)).filter((k) => k === "before" || k === "after"), []);
});

/* ------------------------------------------------------------ the shared fallback */

test("a missing table is recognised by Postgres' and PostgREST's codes and words — anything else is a real failure", async () => {
  assert.ok(tableMissing({ code: "42P01", message: "x" }));
  assert.ok(tableMissing({ code: "PGRST205", message: "Could not find the table 'public.intelligent_operations' in the schema cache" }));
  assert.ok(tableMissing(new Error('relation "public.intelligent_operations" does not exist')));
  assert.ok(!tableMissing({ code: "42501", message: "permission denied for table x" }));
  const mem = { durable: false }, db = { durable: true };
  assert.equal(await storeWithFallback({ memoryOnly: true, durable: () => db, probe: async () => {}, memory: () => mem, what: "t" }), mem);
  assert.equal(await storeWithFallback({ memoryOnly: false, durable: () => db, probe: async () => {}, memory: () => mem, what: "t" }), db);
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await storeWithFallback({ memoryOnly: false, durable: () => db, probe: async () => { throw { code: "42P01" }; }, memory: () => mem, what: "t-test" }), mem);
  } finally { console.warn = warn; }
  await assert.rejects(storeWithFallback({ memoryOnly: false, durable: () => db, probe: async () => { throw new Error("connection refused"); }, memory: () => mem, what: "t" }), /connection refused/);
  assert.equal(memoryOf("x-test"), memoryOf("x-test"), "one map per name, for the life of the process");
});

/* ------------------------------------------------------------ the history view's helpers */

test("saveFailure: the store's reason, in its words; appliedKicker says only what is true", () => {
  assert.deepEqual(saveFailure({ kind: "conflict", message: "this survey changed elsewhere; your save was refused" }), { kind: "conflict", short: "conflict", message: "this survey changed elsewhere; your save was refused" });
  assert.equal(saveFailure({ kind: "lock_lost", heldByName: "Asha" }).message, "this session no longer holds the editing lock (Asha has it)");
  assert.equal(saveFailure({ kind: "signed_out" }).short, "signed out");
  assert.equal(saveFailure({ kind: "error", message: "save failed (500)" }).message, "save failed (500)");
  assert.equal(saveFailure({ kind: "dirty" }, true).kind, "read_only");
  assert.equal(saveFailure(null).kind, "incomplete");
  assert.equal(appliedKicker(undefined, null), "APPLIED");
  assert.equal(appliedKicker({ state: "saving" }, null), "APPLIED · SAVING…");
  assert.equal(appliedKicker({ state: "saved" }, 1), "APPLIED · SAVED · AI CHANGE #001");
  assert.equal(appliedKicker({ state: "sandbox" }, 12), "APPLIED · SANDBOX (NOT SAVED) · AI CHANGE #012");
  assert.equal(appliedKicker({ state: "failed", ...saveFailure({ kind: "lock_lost" }) }, 2), "APPLIED · NOT SAVED — LOCK LOST · AI CHANGE #002");
  assert.deepEqual([statusWord("save_failed"), statusWord("reverted"), sourceWord("grammar"), sourceWord("fix")], ["Not saved", "Reverted", "Grammar", "Fix"]);
  assert.equal(apiCallWords({ route: "/api/copilot/turn", mode: "edit", charge: 0.5, cached: true, promptChars: 12345 }), "/api/copilot/turn · edit · 0.5 credits · cached · 12,345 chars sent");
  assert.equal(apiCallWords({ route: "/api/copilot/turn", charge: 0, error: "timeout" }), "/api/copilot/turn · no charge · failed: timeout");
});

test("observeUndo: ⌘Z back to a change's before reverts it, ⌘⇧Z back to its after applies it again; an unrelated edit is not either", () => {
  const s0 = def(0), s1 = def(1), s2 = def(2), s3 = def(3);
  const changes = [{ key: "A", before: s0, after: s1 }, { key: "B", before: s1, after: s2 }];
  const same = sameSurvey;
  assert.equal(observeUndo(changes, s2, same), null, "nothing undone");
  assert.deepEqual(observeUndo(changes, s1, same), { key: "B", to: "reverted" });
  const bOut = [changes[0], { ...changes[1], reverted: true }];
  assert.equal(observeUndo(bOut, s1, same), null, "B is already reverted, A still stands");
  assert.deepEqual(observeUndo(bOut, s0, same), { key: "A", to: "reverted" }, "a second ⌘Z takes A back");
  const bothOut = [{ ...changes[0], reverted: true }, { ...changes[1], reverted: true }];
  assert.deepEqual(observeUndo(bothOut, s1, same), { key: "A", to: "applied" }, "⌘⇧Z redoes A first");
  assert.deepEqual(observeUndo(bOut, s2, same), { key: "B", to: "applied" });
  assert.equal(observeUndo(changes, s3, same), null, "an edit after B is what ⌘Z would take back — no AI change moved");
  assert.deepEqual(observeUndo(changes, JSON.parse(JSON.stringify(s1)), same), { key: "B", to: "reverted" }, "equal by value, not only by identity");
});

test("Restore: offered for a standing change with its survey kept, said when later changes go with it; Reapply: applied, reverted or cancelled, with actions", () => {
  const op = (key: string, status: OpStatus, at: string, extra: Partial<ClientOp> = {}): ClientOp => ({ key, serverId: key, createdAt: at, prompt: key, source: "engine", intent: {}, detected: [], targets: [], proposed: [], applied: [], excluded: [], failed: [], warnings: [], engineOps: [], apiCalls: [], status, statusDetail: null, savedRevision: null, changeN: null, hasBefore: true, hasAfter: true, local: true, ...extra });
  const a = op("a", "saved", "1"), b = op("b", "applied", "2"), c = op("c", "reverted", "3"), d = op("d", "answered", "4"), e = op("e", "save_failed", "0", { hasBefore: false });
  const all = [a, b, c, d, e];
  assert.deepEqual(canRestore(a, all), { offered: true, latest: false }, "b still stands after a");
  assert.deepEqual(canRestore(b, all), { offered: true, latest: true });
  assert.deepEqual(canRestore(c, all), { offered: false, latest: false }, "already reverted");
  assert.deepEqual(canRestore(d, all), { offered: false, latest: false }, "an answer changed nothing");
  assert.deepEqual(canRestore(e, all).offered, false, "no survey before was kept");
  assert.deepEqual([isChange(a), isChange(c), isChange(d)], [true, true, false]);
  const withAction = op("f", "cancelled", "6", { proposed: [{ description: "Make Q1 required", action: { op: "update_question", target: "Q1", required: true } }, { description: "words only" }] });
  assert.deepEqual(reapplyActions(withAction).map((x) => x.op), ["update_question"]);
  assert.ok(canReapply(withAction));
  assert.ok(!canReapply(op("g", "applied", "7")), "no actions to replay");
  assert.ok(canReapply(op("g", "applied", "7"), [{ op: "page_break", after: "Q1" } as never]), "the page's own copy of the actions");
  assert.ok(!canReapply({ ...withAction, status: "proposed" }), "an open proposal is in the review already");
  assert.ok(sameSurveyCanonical({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }), "jsonb's sorted keys are the same survey");
  assert.ok(!sameSurveyCanonical({ a: [1, 2] }, { a: [2, 1] }), "order inside a list still matters");
});

/* ------------------------------------------------------------ the recorder, against the memory store */

/** a `send` that is the route, in-process: the memory store behind the same coercion */
function routeOf(store: MemoryOperationStore, opts: { delayPost?: number; failPost?: number } = {}): Send & { calls: string[] } {
  let failures = opts.failPost ?? 0;
  const calls: string[] = [];
  const send = (async (method: "GET" | "POST" | "PATCH", body: Record<string, unknown> | null, query?: Record<string, string>) => {
    calls.push(`${method}${body?.status ? ` ${body.status}` : ""}`);
    if (method === "GET") {
      if (query?.id) { const op = await store.get("S", query.id); return op ? { status: 200, data: { ok: true, operation: op } } : { status: 404, data: { error: "No such operation." } }; }
      return { status: 200, data: { ok: true, durable: false, operations: await store.list("S") } };
    }
    if (method === "POST") {
      if (opts.delayPost) await new Promise((r) => setTimeout(r, opts.delayPost));
      if (failures > 0) { failures--; return { status: 409, data: { error: "This session is not currently holding the edit lock for the project." } }; }
      const c = coerceOperation(body, "create");
      if (!c.ok) return { status: 400, data: { error: c.error } };
      const rec = await store.create("S", c.value, { userId: null, surveyId: "S" });
      return { status: 200, data: { ok: true, id: rec.id, durable: false } };
    }
    const c = coerceOperation(body, "update");
    if (!c.ok) return { status: 400, data: { error: c.error } };
    const r = await store.update("S", String(body!.id), c.value);
    return r.ok ? { status: 200, data: { ok: true, durable: false, operation: toSummary(r.record), changeN: r.record.changeN } } : { status: r.status, data: { error: r.error } };
  }) as unknown as Send & { calls: string[] };
  send.calls = calls;
  return send;
}

test("the recorder: an Apply clicked before the turn's record came back still lands on it, in order, with the server's number", async () => {
  const store = new MemoryOperationStore(new Map());
  const send = routeOf(store, { delayPost: 20 });
  const rec = new OpsRecorder(send);
  let emits = 0; rec.subscribe(() => { emits++; });
  const e = rec.create({ prompt: "make Q1 required", source: "engine", status: "proposed", proposed: [{ description: "Make Q1 required" }] });
  assert.equal(rec.list()[0].key, e.key, "the entry is there at once");
  const applied = rec.update(e.key, { status: "applied", applied: ["Made Q1 required"], before: def(1), after: def(1) });
  assert.equal(rec.get(e.key)!.status, "applied", "the page is never behind what happened");
  const saved = rec.update(e.key, { status: "saved", savedRevision: 3 });
  assert.equal((await applied)!.changeN, 1);
  assert.equal((await saved)!.status, "saved");
  assert.deepEqual(send.calls, ["POST proposed", "PATCH applied", "PATCH saved"], "the create first, then the transitions in order");
  const row = await store.get("S", rec.get(e.key)!.serverId!);
  assert.equal(row!.status, "saved"); assert.equal(row!.savedRevision, 3); assert.ok(row!.before);
  assert.ok(emits > 0);
  // a second change gets the next number
  const f = rec.create({ prompt: "randomize Q2", source: "model", status: "proposed" });
  assert.equal((await rec.update(f.key, { status: "applied" }))!.changeN, 2);
});

test("the recorder says when the server could not be told — and a refused transition — instead of swallowing it", async () => {
  const store = new MemoryOperationStore(new Map());
  const rec = new OpsRecorder(routeOf(store, { failPost: 2 }));
  const e = rec.create({ prompt: "make Q1 required", source: "engine", status: "proposed" });
  await rec.settled(e.key);
  assert.match(rec.get(e.key)!.recordError!, /^not recorded: This session is not currently holding the edit lock/);
  // the update retries the create once — refused again: still said
  await rec.update(e.key, { status: "applied" });
  assert.match(rec.get(e.key)!.recordError!, /not recorded/);
  // the next one goes through: the create, then the update
  const ok = await rec.update(e.key, { status: "applied" });
  assert.equal(ok!.recordError, undefined); assert.equal(ok!.changeN, 1);
  // a transition the server refuses
  const a = rec.create({ prompt: "what depends on Q1?", source: "engine", status: "answered" });
  const r = await rec.update(a.key, { status: "applied" });
  assert.match(r!.recordError!, /not recorded: An operation that is answered cannot become applied/);
  // an unreachable server
  const dead = new OpsRecorder(async () => { throw new Error("offline"); });
  const x = dead.create({ prompt: "x", source: "engine", status: "answered" });
  await dead.settled(x.key);
  assert.equal(dead.get(x.key)!.recordError, "not recorded: the network request failed");
});

test("the recorder merges the server's list: this page's entries keep their state, the rest join (a reload, another session)", async () => {
  const store = new MemoryOperationStore(new Map());
  await store.create("S", { ...emptyFields(), prompt: "from an earlier session", status: "answered" }, { userId: null, surveyId: "S" });
  const send = routeOf(store);
  const rec = new OpsRecorder(send);
  const mine = rec.create({ prompt: "mine", source: "engine", status: "proposed" });
  await rec.settled(mine.key);
  rec.note(mine.key, { auditError: "not in the audit log: HTTP 500" });
  await rec.refresh();
  assert.equal(rec.loaded, true); assert.equal(rec.durable, false);
  assert.deepEqual(rec.list().map((o) => [o.prompt, o.local]), [["mine", true], ["from an earlier session", false]], "newest first, no duplicate of mine");
  assert.equal(rec.get(mine.key)!.auditError, "not in the audit log: HTTP 500", "the page's own notes survive the merge");
  const theirs = rec.list()[1];
  const full = await rec.fetchOne(theirs.key);
  assert.equal(full!.prompt, "from an earlier session");
  const offline = new OpsRecorder(async () => ({ status: 503, data: { error: "The operation history could not be opened: down" } }));
  await offline.refresh();
  assert.equal(offline.loadError, "The operation history could not be opened: down");
});

test("the edges: a prompt one character over is cut and said; a non-finite number is not a change number; a clash is retried once, not twice; ⌘Z never looks past a change still standing; a refused entry is not replayed", async () => {
  const over = coerceOperation({ prompt: "x".repeat(LIMITS.prompt + 1) }, "create");
  assert.ok(over.ok && over.value.prompt.length === LIMITS.prompt && over.warnings.some((w) => /cut/.test(w)), JSON.stringify(over.ok && over.warnings));
  const exact = coerceOperation({ prompt: "x".repeat(LIMITS.prompt) }, "create");
  assert.ok(exact.ok && !exact.warnings.some((w) => /cut/.test(w)));
  assert.equal(nextChangeN([3, Infinity, Number.NaN]), 4);
  let writes = 0;
  const r = await withChangeN(async () => [1], async () => { writes++; return { ok: false as const, conflict: true, error: "dup" }; });
  assert.equal(r.ok, false);
  assert.equal(writes, 2, "the first try and one retry");
  /* B (the latest) is still standing and the survey is not back before it: ⌘Z took something after it, not A */
  const s = (n: number) => ({ meta: { id: String(n) } }) as never;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  assert.equal(observeUndo([{ key: "A", before: s(0), after: s(1) }, { key: "B", before: s(1), after: s(2) }], s(0), same), null);
  assert.deepEqual(observeUndo([{ key: "A", before: s(0), after: s(1) }, { key: "B", before: s(1), after: s(2) }], s(1), same), { key: "B", to: "reverted" });
  assert.equal(canReapply({ status: "refused", proposed: [{ description: "x", action: { op: "update_question", target: "Q1", required: true } }] } as never), false);
});
