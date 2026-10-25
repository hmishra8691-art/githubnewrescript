/**
 * MAY THIS TASK BE ADVANCED WITH NOBODY WATCHING? — authority, provider, spend.
 *
 * ## Why this file is written the way it is
 *
 * NO CRON JOB IN THIS REPO HAS EVER MADE A METERED AI CALL. `analysis-runs`,
 * `story-renders`, `media-delivery` and `notifications` contain no
 * `meteredAi`, no billing context and no `connectionFor` between them: every
 * model call the Studio has ever billed happened inside a request, behind
 * `requireUser` → `requireProjectFor` → `billingProjectFor`, with a live
 * session cookie as the thing that made all three possible. The persistent
 * execution engine removes the session, and this module is what has to stand
 * in its place. It is the first of its kind here, so it is deliberately
 * conservative: every answer it cannot establish is a refusal, never a run.
 *
 * `billingProjectFor`'s own header (apps/studio/lib/metering.ts) records what
 * the mistake looks like in production — a missing permission check let any
 * signed-in account spend the operator's money against the platform's key
 * while the in-memory sandbox meter reported that nothing had been spent.
 * That incident is the reason for two rules below: a task with no workspace
 * to bill is REFUSED rather than quietly routed to the sandbox, and the
 * permission check is `requireProjectFor`'s own, not a second one shaped
 * like it.
 *
 * ## The three questions, in cost order
 *
 *   1. AUTHORITY — the task's `created_by`, re-checked on EVERY slice.
 *      Not "whoever started it was allowed to once". A researcher who is
 *      removed from a project, downgraded to viewer or whose share expires
 *      between two slices must stop the work, because the work is a write to
 *      that project and nobody is present to be refused in a browser.
 *      It is the SAME check a request gets: the `rescript_project_access`
 *      RPC, the `project_members` read for a member, `decideProjectGate`
 *      with `survey.edit`, then the `survey.locked` rule. `decideProjectGate`
 *      takes an `Actor` — `{ userId, customerId, isPlatformAdmin }` — and not
 *      a session, which is exactly what makes a session-free check possible
 *      without inventing a second permission model. There is no second
 *      permission model here. Read `apps/studio/lib/guard.ts` line ~236 and
 *      this function side by side; they ask the same questions in the same
 *      order and they are meant to stay that way.
 *
 *   2. PROVIDER — the platform's key, or nothing. A background slice must
 *      never reach for a person's own credential. Their key is their money
 *      and their rate limit, and they are not here to be told it was used.
 *      A task whose connection resolves to a user connection is therefore
 *      not advanced in the background AT ALL; it waits for that person to
 *      open the page, where `meteredCore` runs it inside their scope exactly
 *      as it does today.
 *
 *   3. SPEND — a wallet check before each slice, and a per-task ceiling.
 *      The wallet check is the meter's own `check()` plus `estimateAi`, never
 *      a hand-read balance. The ceiling is this module's (`taskCeiling`), and
 *      exists because a wallet with four figures in it is not a limit on one
 *      runaway task that nobody is watching.
 *
 * ## Hitting a limit PAUSES, it never fails
 *
 * Every refusal here keeps the work. A failed task throws away completed
 * steps that were paid for; a paused one is picked up the moment the wallet
 * is topped up, the lock is lifted or the researcher opens the page. So this
 * module returns a REASON and lets the caller mark the task needs-attention.
 * `refusalMessage` is the sentence to show the researcher: it names what to
 * do and never a status code, a provider or a raw error.
 *
 * ## Nothing here throws
 *
 * A refusal is a value. A cron sweep that dies on one unreadable row stops
 * advancing every other task in the batch, so every read is wrapped and a
 * check that could not be COMPLETED (as opposed to one that was decided
 * against) is flagged `unverified`, so the caller can come back on the next
 * run instead of putting a healthy task in front of a human.
 *
 * ## Testability
 *
 * Nothing above the fold imports `server-only`, Next or Supabase. The
 * database, `connectionFor`, the meter and the estimator all arrive as
 * optional parameters that default to the real ones through a LAZY import,
 * so `background.test.ts` is an ordinary node test — the pattern the rest of
 * `lib/copilot` uses (`durable.ts`, and `taskStore.ts`'s own
 * `await import("@/lib/admin")`).
 */
import { taskProgress, taskSpend, type ExecTask } from "@rescript/engine";
import { availableBalance, projectHeadroom, type BillingConfig, type Meter, type MeterContext, type ProjectSpending, type Wallet } from "@rescript/billing";
import type { Actor } from "@rescript/access";
import { decideProjectGate, type AccessRow, type MemberRow } from "../projectAccess.ts";
import { outputBudget } from "./budget.ts";

/* ------------------------------------------------------------ the answer */

/**
 * WHY A TASK MAY NOT BE ADVANCED IN THE BACKGROUND RIGHT NOW.
 *
 * Six reasons, and all six mean "pause", never "fail" — the steps that have
 * completed are paid for and stay.
 *
 * `unverified` marks the ones that are not a decision but a MISSING answer:
 * the profile row could not be read, the meter did not respond. Those are a
 * reason to try again on the next sweep, not a reason to put the task in
 * front of a person. A caller that cannot tell them apart will eventually
 * pause a healthy task over a network blip.
 */
export interface BackgroundRefusalMeta {
  /**
   * TRUE when this is a MISSING answer rather than a decided one: the
   * profile row could not be read, the access function errored, the meter
   * did not respond. The caller should come back on the next sweep instead
   * of marking the task needs-attention and calling a person over a blip.
   *
   * Carried on every refusal rather than only the three it can occur on, so
   * a caller's first question — "is this a decision, or did we simply not
   * find out?" — can be asked without narrowing on `kind` first. It is never
   * set on `no_author`, `locked` or `ceiling`: all three are decided from
   * what is already in hand, and there is nothing there to fail.
   */
  unverified?: true;
}

export type BackgroundRefusal = BackgroundRefusalMeta & (
  /** the task has no `created_by`, so there is no one whose rights could authorise it */
  | { kind: "no_author" }
  /** `created_by` no longer holds `survey.edit` here — or the check could not be completed */
  | { kind: "no_right" }
  /** the project is frozen by its owner; a background write is still a write */
  | { kind: "locked" }
  /** the connection is a person's own key — this task waits for them to open the page */
  | { kind: "byok" }
  /** the wallet cannot cover another slice — or could not be asked */
  | { kind: "wallet" }
  /** the task has spent the allowance it may spend unattended */
  | { kind: "ceiling" }
);

/** what one slice needs in order to run, once all three questions have answered yes */
export interface BackgroundContext {
  /** the billing context, built exactly as `projectContext` builds it for a request */
  ctx: MeterContext;
  meter: Meter;
  /** the task's author as the gate sees them — pass this on, never re-derive it */
  actor: Actor;
  /** what `taskCeiling` allowed, for the log line and the panel */
  ceiling: number;
  /** what the task has spent so far, in the wallet's currency */
  spent: number;
  /** what one more slice was priced at when this context was built */
  estimate: number;
}

export type BackgroundOutcome = BackgroundContext | { refused: BackgroundRefusal };

/** narrow a `BackgroundOutcome` without repeating the `in` test at every call site */
export function isRefused(o: BackgroundOutcome): o is { refused: BackgroundRefusal } {
  return "refused" in o;
}

/* ------------------------------------------------------- the per-task ceiling */

/**
 * WHAT ONE STEP MAY COST before the ceiling notices, in the wallet's own
 * currency. A drafting step asks the wallet to hold roughly 4 000 output
 * tokens (`outputBudget("item")`) on top of its prompt, which at the cost
 * registry's starting rates is a few tens of cents — so one unit leaves room
 * for a step that was retried and split, and still catches a loop inside a
 * single step rather than after fifty.
 */
export const CEILING_PER_STEP = 1;

/**
 * THE SMALLEST ALLOWANCE ANY TASK GETS. Without a floor a two-step plan
 * would be paused by its own ceiling on the slice that finishes it, which is
 * the one moment that pausing helps nobody.
 */
export const CEILING_FLOOR = 5;

/**
 * THE MOST ANY TASK MAY SPEND UNATTENDED, whatever the size of its plan.
 * Past this, a plan is not a runaway to be clipped — it is a conversation to
 * have with the researcher, so the task waits for them instead of spending
 * more of the workspace's money with nobody watching.
 */
export const CEILING_MAX = 50;

/**
 * This task's allowance, derived from its own plan: one unit per step of
 * real work, clamped between the floor and the hard maximum.
 *
 * Tombstones are not counted — `taskProgress().total` already excludes them
 * (audit M5) — because a step a re-plan deleted will never run and must not
 * buy the task headroom it has no use for.
 *
 * Exported so the cron, the panel and the test all read the same number off
 * the same function rather than each carrying a copy of the arithmetic.
 */
export function taskCeiling(task: Pick<ExecTask, "steps">): number {
  const steps = taskProgress(task).total;
  const n = Number.isFinite(steps) && steps > 0 ? steps : 0;
  return Math.min(CEILING_MAX, Math.max(CEILING_FLOOR, n * CEILING_PER_STEP));
}

/** what this task has spent so far: its steps, plus the turn's off-plan spend where the store keeps one (audit M7) */
export function taskSpentSoFar(task: Pick<ExecTask, "steps">): number {
  const steps = taskSpend(task).charge;
  const extra = (task as { extraCharge?: unknown }).extraCharge;
  const off = typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? extra : 0;
  return (Number.isFinite(steps) ? steps : 0) + off;
}

/* ------------------------------------------------------- what to tell the researcher */

/**
 * ONE SENTENCE PER REFUSAL, written for the person whose work stopped.
 *
 * Deliberately plain: no status code, no provider name, no wallet
 * arithmetic, no fragment of an error. Those belong in the server log, where
 * an operator can read them; a researcher who comes back to a paused task
 * needs to know what happened and what to do, and "403 insufficient_role"
 * tells them neither. Every sentence names an action.
 */
export function refusalMessage(r: BackgroundRefusal): string {
  switch (r.kind) {
    case "no_author":
      return "This work cannot carry on by itself because no one is recorded as having started it. Open the project and ask for it again.";
    case "no_right":
      return "This work is paused because the person who started it can no longer edit this project. Ask the project's owner to restore their access, or start it again yourself.";
    case "locked":
      return "This work is paused because the project is locked. Unlock the project and it will carry on from where it stopped.";
    case "byok":
      return "This work runs on your own connection, so it only continues while you have the project open. Open the project and it will finish.";
    case "wallet":
      return "This work is paused because there are not enough credits left to continue. Add credits and it will pick up where it stopped.";
    case "ceiling":
      return "This work has reached the most it may spend on its own. Open the project to look it over and carry on.";
  }
}

/* ------------------------------------------------------------ the seams */

/**
 * THE ONLY SHAPES THIS MODULE NEEDS FROM A DATABASE CLIENT. Narrowed on
 * purpose: a test hands in nine lines of object literal, and nothing here can
 * quietly start using the rest of the Supabase surface.
 */
export interface BackgroundQuery {
  select(columns: string): BackgroundQuery;
  eq(column: string, value: string): BackgroundQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error?: unknown }>;
}
export interface BackgroundDb {
  from(table: string): BackgroundQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error?: unknown }>;
}

/**
 * The part of `connectionFor`'s `Resolution` that the provider question
 * turns on. The real union (apps/studio/lib/byok/resolve.ts) is assignable
 * to this; a test can build one by hand.
 */
export type BackgroundResolution =
  | { kind: "platform" }
  | { kind: "user"; scope: { fallbacks: readonly { platform?: boolean }[] } }
  | { kind: "refused" };

export interface BackgroundDeps {
  /** the service-role client; the real one is `supabaseService()` */
  db?: () => BackgroundDb | Promise<BackgroundDb>;
  /** whose AI this operation uses; the real one is `connectionFor` */
  connectionFor?: (ask: { userId: string; customerId: string | null; surveyId: string; operation: string }) => Promise<BackgroundResolution>;
  /** the meter for real projects; the real one is `getMeter()` */
  meter?: () => Meter | Promise<Meter>;
  /** what one more slice would cost; the real one is `estimateAi` */
  estimate?: (meter: Meter, ctx: MeterContext, task: ExecTask) => Promise<number>;
  /**
   * The operation name the provider question is asked under. Every
   * `copilot_*` operation maps to the same `intelligent` feature
   * (`featureOf`, apps/studio/lib/byok/features.ts), so any of the slice's
   * real operations resolves to the same connection as this one.
   */
  operation?: string;
}

/**
 * HOW BIG A SLICE'S PROMPT IS ASSUMED TO BE for the wallet check. The real
 * prompt is assembled inside `buildStep`, which has not run yet and must not
 * be run to find out whether it may be afforded. This is the guides, the
 * outline and one item, as the turn route sends them — the same
 * `"x".repeat(n)` stand-in the import analyser uses for its cost preview.
 */
export const SLICE_PROMPT_CHARS = 24_000;

/* ------------------------------------------------------------ the check */

const refuse = (refused: BackgroundRefusal): { refused: BackgroundRefusal } => ({ refused });

/**
 * The workspace a task with no customer of its own would be billed to.
 *
 * It is NOT used as a fallback. `meterContextFor` falls back to the sandbox
 * customer for a page that has no project, and `billingProjectFor`'s header
 * records what happened when a spending path inherited that habit: the
 * in-memory sandbox meter said nothing had been spent while the platform's
 * key paid for every call. A background task that cannot name a workspace is
 * refused instead, and the constant is here only so the comparison is
 * explicit rather than implied.
 */
const SANDBOX_CUSTOMER = "sandbox";

/** the gate's own test for "this is a project id at all" (guard.ts, `requireProjectFor`) */
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * THE AUTHORITY, PROVIDER AND SPEND CHECKS FOR ONE SLICE.
 *
 * Returns the context a slice runs under, or the reason it may not run.
 * Never throws, never partially applies a check, and never falls back to a
 * cheaper answer when an expensive one fails.
 */
export async function backgroundContextFor(task: ExecTask, deps: BackgroundDeps = {}): Promise<BackgroundOutcome> {
  try {
    /* ---------------------------------------------------- 1. authority */

    const author = typeof task.createdBy === "string" ? task.createdBy.trim() : "";
    if (!author) return refuse({ kind: "no_author" });

    const surveyId = typeof task.surveyId === "string" ? task.surveyId.trim() : "";
    /*
     * The gate answers 404 for an id that is not a project id, and the
     * sandbox project never reaches a durable sweep. Either way there is no
     * project here whose rights could authorise a write, which is what
     * `no_right` means — a background job has no one to disclose anything to,
     * so the gate's careful 404/403 distinction has no work to do.
     */
    if (!UUID.test(surveyId)) return refuse({ kind: "no_right" });

    const db = await (deps.db ?? defaultDb)();

    /*
     * The author's account and the project, read together. The account read
     * is the gate's own (`userForSession`): the same `profiles` columns, the
     * same `status !== "active"` rule — a disabled account authorises
     * nothing, which is the whole point of disabling it — and the same
     * derivation of `isPlatformAdmin` from `role`. What is deliberately NOT
     * read is anything about a session: there is no session, that is the
     * premise, and `Actor` is all `decideProjectGate` ever wanted.
     */
    const [profile, survey] = await Promise.all([
      one(db, "profiles", "id, customer_id, role, status", ["id", author]),
      one(db, "surveys", "id, customer_id, locked, owner_id", ["id", surveyId]),
    ]);
    if (!profile.ok || !survey.ok) return refuse({ kind: "no_right", unverified: true });
    if (!profile.row || !survey.row) return refuse({ kind: "no_right" });
    if (str(profile.row.status) !== "active") return refuse({ kind: "no_right" });

    const actor: Actor = {
      userId: author,
      customerId: str(profile.row.customer_id) || null,
      isPlatformAdmin: str(profile.row.role) === "platform_admin",
    };

    /* the same RPC the gate runs, and the same array-or-scalar shape it tolerates */
    let accessRow: AccessRow | null = null;
    try {
      const { data, error } = await db.rpc("rescript_project_access", { p_user: actor.userId, p_survey: surveyId });
      if (error) return refuse({ kind: "no_right", unverified: true });
      const raw = Array.isArray(data) ? data[0] : data;
      accessRow = (raw ?? null) as AccessRow | null;
    } catch {
      return refuse({ kind: "no_right", unverified: true });
    }

    /*
     * The membership columns, for a member only, read soft — exactly as the
     * gate reads them. On a database without migration 0062 the query fails
     * and the member is decided on their role, which is what happened before
     * per-module permissions and expiry existed.
     */
    let memberRow: MemberRow | null = null;
    if (accessRow?.role_source === "member" || accessRow?.role_source === "expired") {
      const m = await one(db, "project_members", "permissions, expires_at", ["survey_id", surveyId], ["user_id", actor.userId]);
      if (m.ok && m.row) memberRow = m.row as MemberRow;
    }

    const gate = decideProjectGate({ user: actor, access: accessRow, member: memberRow, capability: "survey.edit" });
    if (!gate.ok) return refuse({ kind: "no_right" });

    /*
     * A frozen project refuses every write, whatever the role — and
     * `survey.edit` is in the gate's `WRITE_CAPABILITIES`, so the rule here
     * reduces to exactly this. The owner's exemption is the gate's too: an
     * owner has to be able to unlock, and a task they started is theirs.
     */
    if (survey.row.locked === true && gate.role !== "owner") return refuse({ kind: "locked" });

    /* ---------------------------------------------------- the billing context */

    /*
     * Built the way `projectContext` builds it for a request — the project's
     * workspace, else the acting account's — with one difference that
     * matters: there is no `?? SANDBOX_CUSTOMER` on the end. See the comment
     * on that constant. LIVE and stated rather than defaulted: this is
     * authoring work on a real study and has no respondent environment to
     * inherit (`meterContextFor`).
     */
    const customerId = str(survey.row.customer_id) || actor.customerId || "";
    if (!customerId || customerId === SANDBOX_CUSTOMER) return refuse({ kind: "wallet" });
    const ctx: MeterContext = { customerId, surveyId, userId: actor.userId, environment: "LIVE" };

    /* ---------------------------------------------------- 2. provider */

    /*
     * THE PLATFORM'S KEY OR NOTHING.
     *
     * `estimateAi` and the turn route test `kind === "user" && no platform
     * fallback` — that is their question, "does the platform charge for
     * this", and the answer there is a price. The question HERE is different
     * and the test has to be wider: `meteredCore` opens the user's scope and
     * tries THEIR key first even when a platform fallback is listed, so a
     * connection with a fallback would still spend a person's credential
     * while they are asleep. Anything that is not plainly the platform's
     * connection therefore waits for them.
     *
     * `refused` is folded in here on purpose: it means this project or person
     * is set to use their own provider and it cannot be resolved right now.
     * The answer the researcher needs is the same — open the page — and the
     * platform's key is never the silent substitute (`resolveConnection`'s
     * first rule).
     */
    const ask = { userId: actor.userId, customerId: ctx.customerId, surveyId, operation: deps.operation ?? "copilot_background_slice" };
    let conn: BackgroundResolution;
    try {
      conn = await (deps.connectionFor ?? defaultConnectionFor)(ask);
    } catch {
      return refuse({ kind: "byok", unverified: true });
    }
    if (!conn || conn.kind !== "platform") return refuse({ kind: "byok" });

    /* ---------------------------------------------------- 3. spend */

    const ceiling = taskCeiling(task);
    const spent = taskSpentSoFar(task);
    /* free, so it is asked before anything is priced: a task already past its allowance costs no round trips */
    if (spent >= ceiling) return refuse({ kind: "ceiling" });

    /* a meter that cannot even be built is a spend problem, and must not be reported as a permission one */
    let meter: Meter;
    try {
      meter = await (deps.meter ?? defaultMeter)();
    } catch {
      return refuse({ kind: "wallet", unverified: true });
    }

    /*
     * THE WALLET, through the meter's own gate.
     *
     * `check()` is the question "may this project run a billable operation
     * right now" — wallet state, suspension, and the project's own spending
     * limit, each already told apart by the meter so this module does not
     * have to guess which one stopped it. No balance is read by hand: the
     * headroom comes from `availableBalance` (which is where the overdraft
     * and the minimum-remaining-balance rules live) and the project's room
     * from `projectHeadroom`, both exported by @rescript/billing and both
     * what `Meter.reserve` itself uses.
     */
    let allowed: boolean;
    let wallet: Wallet | null;
    let spending: ProjectSpending | null;
    let cfg: BillingConfig;
    try {
      const w = await meter.check(ctx);
      allowed = w.allowed;
      wallet = w.wallet;
      spending = w.spending ?? null;
      cfg = await meter.config();
    } catch {
      return refuse({ kind: "wallet", unverified: true });
    }
    if (!allowed) return refuse({ kind: "wallet" });
    /*
     * No wallet at all means the store could not answer: `walletFor` is
     * asked with `create`, so a real project always has one. A request would
     * carry on and be refused by `reserve`; a background slice stops here
     * instead, because the alternative is the sandbox-meter failure mode
     * that `billingProjectFor` documents — spending that nothing records.
     */
    if (!wallet) return refuse({ kind: "wallet", unverified: true });

    /* what one more slice costs, priced exactly as `meteredAi` would reserve it */
    let estimate: number;
    try {
      estimate = await (deps.estimate ?? defaultEstimate)(meter, ctx, task);
    } catch {
      return refuse({ kind: "wallet", unverified: true });
    }
    if (!Number.isFinite(estimate) || estimate < 0) return refuse({ kind: "wallet", unverified: true });

    if (estimate > availableBalance(wallet, cfg)) return refuse({ kind: "wallet" });
    const room = projectHeadroom(spending);
    if (room != null && estimate > room) return refuse({ kind: "wallet" });

    /* the ceiling again, now that the next slice has a price on it */
    if (spent + estimate > ceiling) return refuse({ kind: "ceiling" });

    return { ctx, meter, actor, ceiling, spent, estimate };
  } catch {
    /*
     * The promise of this module is that a refusal is a value. Anything that
     * got past the individual guards above is a programming error, and the
     * safe reading of a programming error in a spending path is "do not
     * spend": the task is left exactly as it was and the next sweep tries
     * again.
     */
    return refuse({ kind: "no_right", unverified: true });
  }
}

/* ------------------------------------------------------------ plumbing */

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** one row, with the read's failure kept apart from the row's absence — they mean different things */
async function one(
  db: BackgroundDb, table: string, columns: string, ...filters: [string, string][]
): Promise<{ ok: boolean; row: Record<string, unknown> | null }> {
  try {
    let q = db.from(table).select(columns);
    for (const [c, v] of filters) q = q.eq(c, v);
    const { data, error } = await q.maybeSingle();
    if (error) return { ok: false, row: null };
    return { ok: true, row: data ?? null };
  } catch {
    return { ok: false, row: null };
  }
}

/*
 * THE REAL DEPENDENCIES, loaded only when they are used.
 *
 * Lazily, with `await import`, because `authServer`, `byok/connect` and
 * `metering` all pull in `server-only` (and, through `metering`, `next/server`
 * and the whole guard) — and the point of this file is that its decisions can
 * be run in a plain node test. The same trick `taskStore.ts` uses for
 * `@/lib/admin`.
 */

async function defaultDb(): Promise<BackgroundDb> {
  const { supabaseService } = await import("@/lib/authServer");
  /* the one cast in this file: Supabase's builder is far wider than the four calls above */
  return supabaseService() as unknown as BackgroundDb;
}

async function defaultConnectionFor(ask: { userId: string; customerId: string | null; surveyId: string; operation: string }): Promise<BackgroundResolution> {
  const { connectionFor } = await import("@/lib/byok/connect");
  return connectionFor(ask);
}

async function defaultMeter(): Promise<Meter> {
  const { getMeter } = await import("@/lib/metering");
  return getMeter();
}

/**
 * What one more slice would cost.
 *
 * `estimateAi` is the Studio's existing "what would this cost" — it prices
 * the call through `aiSpec` exactly as `meteredAi` reserves it, and touches
 * no wallet. It asks `connectionFor` again on the way (one indexed read, and
 * it short-circuits for an account with no AI settings); that is worth paying
 * for rather than re-implementing the pricing here, and by this point the
 * answer is known to be the platform.
 */
async function defaultEstimate(meter: Meter, ctx: MeterContext, task: ExecTask): Promise<number> {
  const { estimateAi } = await import("@/lib/metering");
  const budget = outputBudget("item");
  return estimateAi(meter, ctx, "AI_REQUEST", {
    estimateText: `${typeof task.request === "string" ? task.request : ""}${"x".repeat(SLICE_PROMPT_CHARS)}`,
    maxTokens: budget.expectedTokens,
    operation: "copilot_background_slice",
  });
}
