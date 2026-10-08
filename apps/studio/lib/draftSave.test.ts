import { test } from "node:test";
import assert from "node:assert/strict";
import { serialRunner, isOwnWrite, canonicalJson, rememberSent } from "./draftSave.ts";

/*
 * 07-10-2026 review, Suraj #5 — "Changed elsewhere" appeared with nobody
 * else editing. The model below is the database's revision guard: a write
 * names the revision it read; the row accepts it only if that is still the
 * revision, and bumps it.
 */
function fakeServer() {
  let revision = 1;
  let draft: unknown = null;
  return {
    get revision() { return revision; },
    get draft() { return draft; },
    async save(def: unknown, base: number) {
      await new Promise((r) => setTimeout(r, 5));
      if (base !== revision) return { conflict: true, revision, serverDraft: draft };
      revision += 1; draft = def;
      return { ok: true, revision };
    },
  };
}

test("two writers waiting on one save no longer send the same revision", async () => {
  const server = fakeServer();
  let rev = 1;
  const run = serialRunner<string>();
  const write = (def: string) => run(async () => {
    const out = await server.save(def, rev);
    if ("ok" in out) { rev = out.revision; return "saved"; }
    return "conflict";
  });
  // an autosave in flight, then a debounce tick and a flush (Preview) arriving while it is
  const results = await Promise.all([write("a"), write("b"), write("c")]);
  assert.deepEqual(results, ["saved", "saved", "saved"]);
  assert.equal(server.draft, "c", "the last edit is what the server holds");
  assert.equal(server.revision, 4);
});

test("the old pattern — await the one in flight, then go — is the bug this replaces", async () => {
  const server = fakeServer();
  let rev = 1;
  let inFlight: Promise<string> | null = null;
  const write = async (def: string) => {
    if (inFlight) await inFlight;
    const run = (async () => {
      const out = await server.save(def, rev);
      if ("ok" in out) { rev = out.revision; return "saved"; }
      return "conflict";
    })();
    inFlight = run;
    return run;
  };
  const results = await Promise.all([write("a"), write("b"), write("c")]);
  assert.ok(results.includes("conflict"), `two waiters woke on one revision: ${results.join(",")}`);
});

test("a job that throws does not stall the queue", async () => {
  const run = serialRunner<number>();
  const a = run(async () => { throw new Error("network"); });
  const b = run(async () => 2);
  await assert.rejects(a);
  assert.equal(await b, 2);
});

test("isOwnWrite: the server holding what this editor sent is not someone else's work", () => {
  const mine = { meta: { id: "s", title: "T" }, questions: [{ id: "q1", text: "Hi" }] };
  const reordered = { questions: [{ text: "Hi", id: "q1" }], meta: { title: "T", id: "s" } };
  assert.ok(isOwnWrite(reordered, [mine]), "key order is not a difference");
  assert.ok(!isOwnWrite({ ...mine, questions: [{ id: "q1", text: "Hello" }] }, [mine]), "different content is a real conflict");
  assert.ok(!isOwnWrite(null, [mine]), "no draft on the server: nothing to recognise");
  assert.ok(!isOwnWrite(mine, []), "nothing sent yet: cannot be ours");
  assert.equal(canonicalJson({ b: 1, a: undefined, c: [{ y: 1, x: 2 }] }), '{"b":1,"c":[{"x":2,"y":1}]}');
  assert.deepEqual(rememberSent([1, 2, 3, 4], 5), [2, 3, 4, 5]);
});

test("a lost answer is recovered: adopt the revision, send again, no alarm", async () => {
  const server = fakeServer();
  let rev = 1;
  const sent: unknown[] = [];
  const run = serialRunner<string>();
  const write = (def: string, loseAnswer = false) => run(async () => {
    const attempt = async (retried: boolean): Promise<string> => {
      sent.push(def);
      const out = await server.save(def, rev);
      if ("ok" in out) { if (!loseAnswer) rev = out.revision; return "saved"; }
      if (!retried && isOwnWrite(out.serverDraft, sent)) { rev = out.revision; return attempt(true); }
      return "conflict";
    };
    return attempt(false);
  });
  assert.equal(await write("a", true), "saved", "the server took it; the answer was lost");
  assert.equal(await write("b"), "saved", "the next save recognises its own work and goes through");
  assert.equal(server.draft, "b");
  // someone else's write is still a conflict
  await server.save("theirs", server.revision);
  assert.equal(await write("c"), "conflict");
});
