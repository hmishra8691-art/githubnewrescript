import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AiStoreUnavailable, SupabaseAiStore, isMissingTable } from "./store.ts";

/**
 * AN INSTALLATION WHERE MIGRATION 0054 HAS NOT BEEN APPLIED: the settings page said "Request failed (500)", and — worse — every
 * AI call began with a read of the missing table. A missing table now means "nobody has chosen their own provider yet".
 */
const root = new URL("../../../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");

const failing = (message: string, code?: string) => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "update", "upsert", "delete", "insert"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: { message, code } });
  (chain as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: null, error: { message, code } });
  return { from: () => chain } as never;
};

test("the database's ways of saying 'no such table' are recognised, and an ordinary fault is not", () => {
  for (const m of ['relation "public.user_ai_settings" does not exist', "Could not find the table 'public.user_ai_credentials' in the schema cache", "column customers.ai_byok_allowed does not exist", "42P01", "PGRST205"]) assert.equal(isMissingTable(m), true, m);
  for (const m of ["connection terminated", "permission denied for table user_ai_settings", "duplicate key value", ""]) assert.equal(isMissingTable(m), false, m);
});

test("the store raises AiStoreUnavailable for a missing table and a plain Error for anything else", async () => {
  await assert.rejects(new SupabaseAiStore(failing('relation "public.user_ai_settings" does not exist')).getSetting("u", "intelligent"), AiStoreUnavailable);
  await assert.rejects(new SupabaseAiStore(failing("Could not find the table 'public.user_ai_credentials' in the schema cache", "PGRST205")).listCredentials("u"), AiStoreUnavailable);
  await assert.rejects(new SupabaseAiStore(failing("connection terminated")).listSettings("u"), (e: Error) => !(e instanceof AiStoreUnavailable) && /connection terminated/.test(e.message));
});

test("every account-AI route runs inside storeSafe, which never returns the database's own text", () => {
  for (const f of ["route", "credentials/route", "credentials/[id]/route", "test/route", "models/route"]) {
    const s = read(`apps/studio/app/api/account/ai/${f}.ts`);
    assert.match(s, /storeSafe\(/, f);
    assert.ok(s.indexOf("requireUser(req)") < s.indexOf("storeSafe("), `${f}: authenticate first`);
  }
  const server = read("apps/studio/lib/byok/server.ts");
  assert.match(server, /status: 501/); assert.match(server, /byok_unavailable/); assert.match(server, /status: 503/);
  assert.doesNotMatch(server.slice(server.indexOf("storeSafe")), /error: \(e as Error\)|e\.message \}|error: e\.message/, "the fault's own text goes to the log, not the response");
});

test("an unavailable store means platform behaviour for everyone — except a project that demanded each person's own AI, which is refused in words", () => {
  const c = read("apps/studio/lib/byok/connect.ts");
  const body = c.slice(c.indexOf("export async function connectionFor"), c.indexOf("export async function connectionTag"));
  assert.match(body, /instanceof AiStoreUnavailable/);
  assert.match(body, /source === "user"\) return \{ kind: "refused"/);
  assert.match(body, /return \{ kind: "platform", reason: "default" \}/);
  assert.match(body, /if \(!\(e instanceof AiStoreUnavailable\)\) throw e/, "any other fault still surfaces");
});
