import { test } from "node:test";
import assert from "node:assert/strict";
import { totpAt, stepOf, mfaPolicy } from "@rescript/access/mfa";
import { secondFactorCore, type MfaDeps, type MfaRow } from "./mfaCore.ts";

/* the sign-in's second factor, end to end against an in-memory user_mfa table (audit P1-07) */
const KEY = "a".repeat(64);
function world(opts: { table?: boolean } = {}) {
  const rows = new Map<string, MfaRow>();
  const audits: string[] = []; const attempts: string[] = [];
  const deps: MfaDeps = {
    load: async (id) => (opts.table === false ? "unavailable" : rows.get(id) ?? null),
    saveRecovery: async (id, h) => { rows.get(id)!.recovery_hashes = h; },
    claimStep: async (id, prev, step) => { const r = rows.get(id)!; if (r.last_step !== prev) return false; r.last_step = step; return true; },
    insert: async (row) => { rows.set(row.user_id, { ...row }); return null; },
    recordAttempt: async (a) => { attempts.push(a.reason); },
    audit: async (a) => { audits.push(a.action); },
    qr: async () => "<svg/>",
  };
  return { rows, audits, attempts, deps };
}
const admin: { id: string; email: string; role: string; customer_id: string | null } = { id: "u-admin", email: "admin@example.test", role: "platform_admin", customer_id: null };
const prog = { id: "u-prog", email: "prog@example.test", role: "programmer", customer_id: "c1" };
const call = (w: ReturnType<typeof world>, account: typeof admin, body: Record<string, unknown>, policy = mfaPolicy(null)) =>
  secondFactorCore({ account, policy, body, ipHash: "ip", throttleKey: account.email }, w.deps);

test("an administrator with no app set up is enrolled inside the sign-in: secret proposed in a ticket, stored only after the first good code, recovery codes once", async () => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  const w = world();
  const first = await call(w, admin, {});
  assert.equal(first.pass, false);
  const b = (first as unknown as { body: Record<string, string> }).body;
  assert.equal(b.mfa, "enrol"); assert.match(b.otpauthUrl, /^otpauth:\/\/totp\//); assert.ok(b.ticket && b.qrSvg);
  assert.equal(w.rows.size, 0, "nothing stored before the code checks out");
  const secret = b.secret.replace(/\s/g, "");
  const wrong = await call(w, admin, { mfaTicket: b.ticket, mfaCode: totpAt(secret, stepOf(Date.now()) + 5) });
  assert.equal(wrong.pass, false); assert.deepEqual(w.attempts, ["bad_mfa_code"]);
  const ok = await call(w, admin, { mfaTicket: b.ticket, mfaCode: totpAt(secret, stepOf(Date.now())) });
  assert.equal(ok.pass, true);
  assert.equal((ok as unknown as { recoveryCodes: string[] }).recoveryCodes.length, 10);
  const row = w.rows.get(admin.id)!;
  assert.ok(row && !row.secret_sealed.includes(secret), "stored sealed, never in clear");
  assert.equal(row.recovery_hashes.length, 10);
  assert.ok(w.audits.includes("user.mfa_enabled"));
  /* a ticket is bound to its person */
  const other = await call(w, { ...admin, id: "someone-else" }, { mfaTicket: b.ticket, mfaCode: totpAt(secret, stepOf(Date.now())) });
  assert.equal(other.pass, false);
});

test("enrolled: asked for a code; a wrong code is a failed attempt; the right one passes once; the conflict retry uses the pass; a recovery code works once", async () => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  const w = world();
  const e = await call(w, admin, {});
  const secret = (e as unknown as { body: Record<string, string> }).body.secret.replace(/\s/g, "");
  const enrolled = await call(w, admin, { mfaTicket: (e as unknown as { body: Record<string, string> }).body.ticket, mfaCode: totpAt(secret, stepOf(Date.now()) - 1) });
  const codes = (enrolled as unknown as { recoveryCodes: string[] }).recoveryCodes;

  const ask = await call(w, admin, {});
  assert.equal((ask as unknown as { body: { mfa: string; code: string } }).body.mfa, "challenge");
  assert.equal((ask as unknown as { body: { code: string } }).body.code, "mfa_required");
  const bad = await call(w, admin, { mfaCode: "000000" === totpAt(secret, stepOf(Date.now())) ? "111111" : "000000" });
  assert.equal(bad.pass, false);
  const code = totpAt(secret, stepOf(Date.now()));
  const good = await call(w, admin, { mfaCode: code });
  assert.equal(good.pass, true);
  const again = await call(w, admin, { mfaCode: code });
  assert.equal(again.pass, false); assert.equal((again as unknown as { body: { code: string } }).body.code, "mfa_replayed", "a code works once");
  const retry = await call(w, admin, { mfaPass: (good as unknown as { passToken: string }).passToken });
  assert.equal(retry.pass, true, "'sign in here' after a session conflict needs no second code");
  const rec = await call(w, admin, { recoveryCode: codes[0] });
  assert.equal(rec.pass, true); assert.match((rec as unknown as { note: string }).note, /9 recovery codes left/);
  const reused = await call(w, admin, { recoveryCode: codes[0] });
  assert.equal(reused.pass, false);
});

test("not set up on this server (no table, or no sealing key): the administrator signs in with the password and it is audited, not silent", async () => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  const noTable = world({ table: false });
  assert.equal((await call(noTable, admin, {})).pass, true);
  assert.deepEqual(noTable.audits, ["user.login_without_mfa"]);
  delete process.env.INTEGRATIONS_SECRET_KEY;
  const noKey = world();
  assert.equal((await call(noKey, admin, {})).pass, true);
  assert.deepEqual(noKey.audits, ["user.login_without_mfa"]);
  /* nobody who is not required and not enrolled is bothered */
  const quiet = world();
  assert.equal((await call(quiet, prog, {})).pass, true);
  assert.deepEqual(quiet.audits, []);
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  const everyone = await call(world(), prog, {}, mfaPolicy({ require: "everyone" }));
  assert.equal((everyone as unknown as { body: { mfa: string } }).body.mfa, "enrol", "a workspace can require it of everyone");
});
