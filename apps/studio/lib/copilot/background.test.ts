import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BILLING_CONFIG, type Meter, type ProjectSpending, type Wallet } from "@rescript/billing";
import type { ExecStep, ExecTask } from "@rescript/engine";
import {
  backgroundContextFor, isRefused, refusalMessage, taskCeiling, taskSpentSoFar,
  CEILING_FLOOR, CEILING_MAX, CEILING_PER_STEP,
  type BackgroundDb, type BackgroundDeps, type BackgroundQuery, type BackgroundRefusal, type BackgroundResolution,
} from "./background.ts";

/*
 * THE GATE ON A SLICE NOBODY IS WATCHING.
 *
 * Everything here runs without a database, without a meter and without a
 * provider: `backgroundContextFor` takes all four seams as optional
 * parameters, so the decisions can be held to account on their own. What is
 * proved:
 *
 *   · the authority is the TASK'S AUTHOR, re-asked every slice, through the
 *     request gate's own `decideProjectGate` — an author downgraded to
 *     viewer, removed, disabled or pointed at an unknown project stops the
 *     work;
 *   · a locked project stops it too, with the gate's owner exemption;
 *   · anything that is not plainly the PLATFORM'S connection stops it, so no
 *     background slice ever spends a person's own key;
 *   · the wallet and the per-task ceiling each stop it, and the ceiling is
 *     asked before anything is priced;
 *   · no path throws — a broken database, a provider lookup that explodes, a
 *     meter that is down and a task full of rubbish all come back as values;
 *   · and the sentence a researcher sees carries no status code, no provider
 *     name and no fragment of an error.
 */

const SURVEY = "11111111-1111-1111-1111-111111111111";
const AUTHOR = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;

/* ------------------------------------------------------------- fixtures */

const step = (stepId: string, extra: Partial<ExecStep> = {}): ExecStep => ({
  taskId: "t1", stepId, planVersion: 1, dependsOn: [], status: "pending", retryCount: 0,
  idempotencyKey: `idem-${stepId}`, ...extra,
});

const aTask = (over: Partial<ExecTask> = {}): ExecTask => ({
  id: "t1", surveyId: SURVEY, customerId: "cust-1", createdBy: AUTHOR,
  kind: "survey_build", request: "Build me a forty-question tracker", status: "running",
  planVersion: 1, deliverable: { kind: "survey_build", questionCount: 40 },
  steps: [step("a"), step("b"), step("c")],
  ...over,
});

const ACTIVE = { id: AUTHOR, customer_id: "cust-1", role: "programmer", status: "active" };
const OPEN = { id: SURVEY, customer_id: "cust-9", locked: false, owner_id: AUTHOR };
const EDITOR = { project_role: "editor", role_source: "member" };

interface DbSpec {
  profiles?: Row | null;
  surveys?: Row | null;
  project_members?: Row | null;
  access?: unknown;
  /** tables whose read returns `{ error }` — a read that could not be completed */
  errorOn?: string[];
  /** tables whose read throws outright */
  throwOn?: string[];
  /** the RPC throws */
  rpcThrows?: boolean;
  /** the RPC answers `{ error }` */
  rpcErrors?: boolean;
}

function fakeDb(spec: DbSpec): BackgroundDb & { reads: string[] } {
  const reads: string[] = [];
  const db: BackgroundDb & { reads: string[] } = {
    reads,
    from(table: string): BackgroundQuery {
      reads.push(table);
      if (spec.throwOn?.includes(table)) throw new Error("the database is unreachable");
      const q: BackgroundQuery = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (spec.errorOn?.includes(table)) return { data: null, error: { message: "read failed" } };
          const row = (spec as Record<string, unknown>)[table];
          return { data: (row ?? null) as Row | null };
        },
      };
      return q;
    },
    async rpc() {
      reads.push("rpc");
      if (spec.rpcThrows) throw new Error("the function is not there");
      if (spec.rpcErrors) return { data: null, error: { message: "rpc failed" } };
      /* the real function answers a one-row set; the gate tolerates either shape and so must this */
      return { data: spec.access === undefined ? [EDITOR] : [spec.access] };
    },
  };
  return db;
}

const aWallet = (over: Partial<Wallet> = {}): Wallet => ({
  id: "w1", customerId: "cust-9", surveyId: SURVEY, userId: null, sharedWalletId: null,
  currency: "USD", balance: 100, reserved: 0, totalAdded: 100, totalUsed: 0, state: "active",
  overdraftEnabled: null, overdraftLimit: null, createdAt: "", updatedAt: "",
  ...over,
});

interface MeterSpec {
  allowed?: boolean;
  wallet?: Wallet | null;
  spending?: ProjectSpending | null;
  throws?: boolean;
}

function fakeMeter(spec: MeterSpec = {}): Meter & { asked: number } {
  const m = {
    asked: 0,
    async check() {
      m.asked++;
      if (spec.throws) throw new Error("the meter store is down");
      return {
        allowed: spec.allowed ?? true, state: "active" as const,
        wallet: spec.wallet === undefined ? aWallet() : spec.wallet,
        spending: spec.spending ?? null, message: "",
      };
    },
    async config() { return DEFAULT_BILLING_CONFIG; },
  };
  return m as unknown as Meter & { asked: number };
}

const platform = async (): Promise<BackgroundResolution> => ({ kind: "platform" });

/** the happy defaults; every test overrides exactly the one seam it is about */
function deps(over: Partial<BackgroundDeps> = {}, dbSpec: DbSpec = {}): BackgroundDeps {
  return {
    db: () => fakeDb({ profiles: ACTIVE, surveys: OPEN, access: EDITOR, ...dbSpec }),
    connectionFor: platform,
    meter: () => fakeMeter(),
    estimate: async () => 0.25,
    ...over,
  };
}

/** the refusal kind, or `null` when the slice was allowed */
async function kindOf(task: ExecTask, d: BackgroundDeps): Promise<BackgroundRefusal["kind"] | null> {
  const out = await backgroundContextFor(task, d);
  return isRefused(out) ? out.refused.kind : null;
}

/* ------------------------------------------------------------- authority */

test("a task with no author is not advanced: there is no one whose rights could authorise it", async () => {
  assert.equal(await kindOf(aTask({ createdBy: undefined }), deps()), "no_author");
  assert.equal(await kindOf(aTask({ createdBy: "   " }), deps()), "no_author");
});

test("an author who still holds survey.edit gets the slice, billed to the project's workspace", async () => {
  const out = await backgroundContextFor(aTask(), deps());
  assert.ok(!isRefused(out), "an editor on an open project may be advanced");
  if (isRefused(out)) return;
  assert.deepEqual(out.ctx, { customerId: "cust-9", surveyId: SURVEY, userId: AUTHOR, environment: "LIVE" });
  assert.deepEqual(out.actor, { userId: AUTHOR, customerId: "cust-1", isPlatformAdmin: false });
  assert.equal(out.ceiling, CEILING_FLOOR, "three steps is under the floor");
  assert.equal(out.spent, 0);
  assert.equal(out.estimate, 0.25);
});

test("the authority is re-asked every slice: an author downgraded to viewer stops the work", async () => {
  assert.equal(await kindOf(aTask(), deps({}, { access: { project_role: "viewer", role_source: "member" } })), "no_right");
});

test("removed from the project, access expired, account disabled, project gone — all stop it, none of them fail it", async () => {
  assert.equal(await kindOf(aTask(), deps({}, { access: { project_role: null, role_source: "none" } })), "no_right");
  assert.equal(await kindOf(aTask(), deps({}, { access: { project_role: "editor", role_source: "expired" } })), "no_right");
  assert.equal(await kindOf(aTask(), deps({}, { profiles: { ...ACTIVE, status: "disabled" } })), "no_right");
  assert.equal(await kindOf(aTask(), deps({}, { profiles: null })), "no_right");
  assert.equal(await kindOf(aTask(), deps({}, { surveys: null })), "no_right");
  assert.equal(await kindOf(aTask({ surveyId: "sandbox" }), deps()), "no_right");
});

test("an expiry stored on the membership is honoured even when the RPC has not noticed it", async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(
    await kindOf(aTask(), deps({}, { access: EDITOR, project_members: { permissions: null, expires_at: past } })),
    "no_right",
  );
});

test("a custom membership answers from its stored permissions, not from the word 'custom'", async () => {
  const custom = { project_role: "custom", role_source: "member" };
  assert.equal(
    await kindOf(aTask(), deps({}, { access: custom, project_members: { permissions: { survey: "read" }, expires_at: null } })),
    "no_right",
  );
});

test("the gate's own checks are the ones that run — the same RPC, and the member read only for a member", async () => {
  const db = fakeDb({ profiles: ACTIVE, surveys: OPEN, access: EDITOR });
  await backgroundContextFor(aTask(), deps({ db: () => db }));
  assert.deepEqual(db.reads.slice(0, 3).sort(), ["profiles", "rpc", "surveys"], "the account, the project and the access function");
  assert.ok(db.reads.includes("project_members"), "a member's permissions and expiry are read, as the gate reads them");

  const owner = fakeDb({ profiles: ACTIVE, surveys: OPEN, access: { project_role: "owner", role_source: "owner" } });
  await backgroundContextFor(aTask(), deps({ db: () => owner }));
  assert.ok(!owner.reads.includes("project_members"), "an owner has no membership row to read");
});

test("the member read is SOFT, as it is in the gate: a database without migration 0062 still runs the work", async () => {
  /*
   * `requireProjectFor` reads `project_members` only for a member and only
   * softly — on a database without the permissions and expiry columns the
   * query fails and the member is decided on their role, exactly as before
   * those columns existed. A background slice must not be stricter, or
   * applying the migration would become a condition of the work continuing.
   */
  const out = await backgroundContextFor(aTask(), deps({}, { errorOn: ["project_members"] }));
  assert.ok(!isRefused(out), "an editor is still an editor when the membership columns are not there");
});

/* ---------------------------------------------------------------- locked */

test("a frozen project stops a background write, exactly as it stops a request", async () => {
  assert.equal(await kindOf(aTask(), deps({}, { surveys: { ...OPEN, locked: true } })), "locked");
});

test("the owner's exemption is the gate's: an owner may still advance their own locked project", async () => {
  const out = await backgroundContextFor(
    aTask(),
    deps({}, { surveys: { ...OPEN, locked: true }, access: { project_role: "owner", role_source: "owner" } }),
  );
  assert.ok(!isRefused(out), "an owner has to be able to finish and unlock");
});

/* -------------------------------------------------------------- provider */

test("a user's own connection is never spent in the background — with or without a platform fallback", async () => {
  const byok = async (): Promise<BackgroundResolution> => ({ kind: "user", scope: { fallbacks: [] } });
  assert.equal(await kindOf(aTask(), deps({ connectionFor: byok })), "byok");

  /*
   * The turn route's test is `kind === "user" && no platform fallback`,
   * because its question is whether the PLATFORM charges. The question here
   * is whose key is tried, and `meteredCore` opens the user's scope first
   * even when a fallback is listed — so a fallback must not buy a slice.
   */
  const withFallback = async (): Promise<BackgroundResolution> => ({ kind: "user", scope: { fallbacks: [{ platform: true }] } });
  assert.equal(await kindOf(aTask(), deps({ connectionFor: withFallback })), "byok");
});

test("a connection that is refused waits for the person too — the platform is never the silent substitute", async () => {
  assert.equal(await kindOf(aTask(), deps({ connectionFor: async () => ({ kind: "refused" }) })), "byok");
});

/* ---------------------------------------------------------------- wallet */

test("a wallet the meter will not allow pauses the task", async () => {
  assert.equal(await kindOf(aTask(), deps({ meter: () => fakeMeter({ allowed: false }) })), "wallet");
});

test("a wallet that cannot cover one more slice pauses the task", async () => {
  const thin = fakeMeter({ wallet: aWallet({ balance: 0.1 }) });
  assert.equal(await kindOf(aTask(), deps({ meter: () => thin, estimate: async () => 0.25 })), "wallet");

  const held = fakeMeter({ wallet: aWallet({ balance: 100, reserved: 99.9 }) });
  assert.equal(await kindOf(aTask(), deps({ meter: () => held, estimate: async () => 0.25 })), "wallet",
    "credits held by operations in flight are not spendable");
});

test("a project that has reached its OWN spending limit pauses too, on a healthy wallet", async () => {
  const spending = { subjectId: SURVEY, customerId: "cust-9", mode: "budget", budgetLimit: 10, spent: 9.95, reserved: 0, state: "active" } as unknown as ProjectSpending;
  assert.equal(await kindOf(aTask(), deps({ meter: () => fakeMeter({ spending }), estimate: async () => 0.25 })), "wallet");
});

test("a task with no workspace to bill is refused, never routed to the sandbox meter", async () => {
  assert.equal(
    await kindOf(aTask(), deps({}, { surveys: { ...OPEN, customer_id: null }, profiles: { ...ACTIVE, customer_id: null } })),
    "wallet",
  );
  assert.equal(
    await kindOf(aTask(), deps({}, { surveys: { ...OPEN, customer_id: "sandbox" }, profiles: { ...ACTIVE, customer_id: null } })),
    "wallet",
  );
});

/* --------------------------------------------------------------- ceiling */

test("the ceiling comes off the task's own plan, with a floor and a hard maximum", () => {
  assert.equal(taskCeiling({ steps: [] }), CEILING_FLOOR, "an empty plan still gets the floor");
  assert.equal(taskCeiling({ steps: [step("a"), step("b")] }), CEILING_FLOOR, "a short plan is not paused by its own ceiling");

  const many = (n: number) => ({ steps: Array.from({ length: n }, (_, i) => step(`s${i}`)) });
  assert.equal(taskCeiling(many(20)), 20 * CEILING_PER_STEP);
  assert.equal(taskCeiling(many(10_000)), CEILING_MAX, "no plan buys more than the hard maximum");

  /* a step a re-plan deleted will never run, so it buys no headroom (audit M5) */
  const withTombs = { steps: [...many(20).steps, ...Array.from({ length: 40 }, (_, i) => step(`t${i}`, { status: "tombstoned" as const }))] };
  assert.equal(taskCeiling(withTombs), 20 * CEILING_PER_STEP);
});

test("what a task has spent is its steps plus the turn's off-plan charge", () => {
  const spent = aTask({
    steps: [
      step("a", { usage: { charge: 1.5 } }),
      step("b", { usage: { charge: 0.25 } }),
      step("c"),
    ],
  });
  assert.equal(taskSpentSoFar(spent), 1.75);
  assert.equal(taskSpentSoFar({ ...spent, extraCharge: 0.5 } as ExecTask), 2.25);
});

test("a task that has spent its allowance is paused — and nothing is priced to find that out", async () => {
  const meter = fakeMeter();
  const burnt = aTask({ steps: [step("a", { usage: { charge: 5 } }), step("b"), step("c")] });
  assert.equal(await kindOf(burnt, deps({ meter: () => meter })), "ceiling");
  assert.equal(meter.asked, 0, "the ceiling is free, so it is asked before the wallet costs a round trip");
});

test("a slice that would cross the ceiling is paused, not clipped", async () => {
  const nearly = aTask({ steps: [step("a", { usage: { charge: 4.9 } }), step("b"), step("c")] });
  assert.equal(await kindOf(nearly, deps({ estimate: async () => 0.25 })), "ceiling");
  assert.equal(await kindOf(nearly, deps({ estimate: async () => 0.05 })), null, "a slice that fits still runs");
});

/* ------------------------------------------------- nothing here ever throws */

test("every refusal path returns a value: a broken database, provider, meter or task never throws", async () => {
  const broken: [string, ExecTask, BackgroundDeps][] = [
    ["the profiles read fails", aTask(), deps({}, { errorOn: ["profiles"] })],
    ["the surveys read fails", aTask(), deps({}, { errorOn: ["surveys"] })],
    ["the client throws on every read", aTask(), deps({}, { throwOn: ["profiles", "surveys", "project_members"] })],
    ["the access function errors", aTask(), deps({}, { rpcErrors: true })],
    ["the access function throws", aTask(), deps({}, { rpcThrows: true })],
    ["the client cannot be built", aTask(), deps({ db: () => { throw new Error("no service key"); } })],
    ["the provider lookup throws", aTask(), deps({ connectionFor: async () => { throw new Error("vault is sealed"); } })],
    ["the provider lookup answers nonsense", aTask(), deps({ connectionFor: async () => (null as unknown as BackgroundResolution) })],
    ["the meter cannot be built", aTask(), deps({ meter: () => { throw new Error("no store"); } })],
    ["the meter is down", aTask(), deps({ meter: () => fakeMeter({ throws: true }) })],
    ["there is no wallet row", aTask(), deps({ meter: () => fakeMeter({ wallet: null }) })],
    ["the estimate throws", aTask(), deps({ estimate: async () => { throw new Error("rates unreadable"); } })],
    ["the estimate is not a number", aTask(), deps({ estimate: async () => (Number.NaN) })],
    ["the estimate is negative", aTask(), deps({ estimate: async () => -1 })],
    ["the task is rubbish", { steps: [] } as unknown as ExecTask, deps()],
    ["the task is a bag of wrong types", { createdBy: 7, surveyId: {}, steps: null } as unknown as ExecTask, deps()],
    ["there are no dependencies at all", aTask(), {}],
  ];

  const kinds = new Set<string>();
  for (const [what, task, d] of broken) {
    const out = await backgroundContextFor(task, d).catch((e: unknown) => {
      assert.fail(`${what}: backgroundContextFor threw ${(e as Error)?.message}`);
    });
    assert.ok(isRefused(out), `${what}: must refuse, never run`);
    if (!isRefused(out)) continue;
    assert.ok(refusalMessage(out.refused).length > 0, `${what}: every refusal has something to say`);
    kinds.add(out.refused.kind);
  }
  /* a broken seam is reported as a problem of ITS OWN KIND — a meter that is down is never a permission refusal */
  assert.deepEqual([...kinds].sort(), ["byok", "no_author", "no_right", "wallet"]);

  /* the ones that are a missing answer rather than a decision are marked, so a sweep retries instead of calling a person */
  const unverified = await backgroundContextFor(aTask(), deps({}, { errorOn: ["profiles"] }));
  assert.ok(isRefused(unverified) && unverified.refused.kind === "no_right" && unverified.refused.unverified === true);
  const decided = await backgroundContextFor(aTask(), deps({}, { access: { project_role: "viewer", role_source: "member" } }));
  assert.ok(isRefused(decided) && decided.refused.unverified === undefined, "a decided 'no' is not marked for retry");
});

test("the real dependencies are not reached from a test process — the defaults are lazy", async () => {
  /* no `db` given, so the module would have to import `server-only` to answer; it refuses instead of exploding */
  const out = await backgroundContextFor(aTask(), { connectionFor: platform, meter: () => fakeMeter(), estimate: async () => 0 });
  assert.ok(isRefused(out), "the real Supabase client cannot be built here, and that is a refusal");
});

/* --------------------------------------------------- what the researcher reads */

test("a refusal sentence names an action and leaks nothing: no status code, no provider, no error text", () => {
  const kinds: BackgroundRefusal[] = [
    { kind: "no_author" }, { kind: "no_right" }, { kind: "locked" },
    { kind: "byok" }, { kind: "wallet" }, { kind: "ceiling" },
  ];
  const PROVIDERS = /openai|anthropic|google|gemini|claude|gpt-|azure|deepl|whisper|supabase|postgres|byok|bearer|api key/i;
  const RAW = /error|exception|stack|undefined|\bnull\b|[{}[\]<>|]|_[a-z]+_?|https?:/i;

  const seen = new Set<string>();
  for (const r of kinds) {
    const m = refusalMessage(r);
    assert.ok(m.length > 20, `${r.kind}: a sentence, not a label`);
    assert.equal(m, m.trim());
    assert.ok(!m.includes("\n"), `${r.kind}: one line`);
    assert.ok(m.endsWith("."), `${r.kind}: a finished sentence`);
    assert.ok(!/\d/.test(m), `${r.kind}: no status code and no number of any kind`);
    assert.ok(!PROVIDERS.test(m), `${r.kind}: no provider is named`);
    assert.ok(!RAW.test(m), `${r.kind}: no raw error text and no machine code`);
    assert.ok(/\b(Open|Ask|Add|Unlock|start)\b/.test(m), `${r.kind}: says what to do next`);
    seen.add(m);
  }
  assert.equal(seen.size, kinds.length, "six reasons, six different sentences");

  /* the marker is for the caller, not for the reader: it must not change the words */
  assert.equal(refusalMessage({ kind: "wallet", unverified: true }), refusalMessage({ kind: "wallet" }));
});
