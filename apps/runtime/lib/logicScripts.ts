/**
 * S1b — HOW THE RUNNER RUNS A SURVEY'S SCRIPTS-PANEL (LOGIC) SCRIPTS.
 *
 * The scripts run in the page's sandboxed logic frame (`@rescript/renderer` LogicFrameHost, `LOGIC_SHIM` in the
 * engine) — never on the respondent's page. One event:
 *
 *   1. the engine selects the event's scripts (enabled, scope, `when`) and runs each through the code gate
 *      (`prepareLogicScripts`): a refused script is logged, never sent;
 *   2. the host takes a snapshot of what the ctx getters read and sends code + snapshot to the frame, bounded by
 *      `timeoutMs` (a frame that does not answer is disposed; its scripts count as not run, and nothing is written);
 *   3. the frame answers with each script's queued writes, logs and errors, in order;
 *   4. the host applies the writes IN ORDER through `apply` (the Runner's `applyScriptWrite` with the script's
 *      declared scope) — only then does the caller continue (the next lifecycle step, the save).
 *
 * Kept out of the component so it can be tested without a browser (`logicScripts.test.ts`).
 */
import { prepareLogicScripts, logicSnapshot } from "@rescript/engine";
import type { LogicScriptOutcome, LogicSnapshot, PreparedLogicScript, ScriptWrite, ResponseState, LoopContext } from "@rescript/engine";
import type { SurveyDefinition, CustomScript } from "@rescript/schema";
import type { AskFrames } from "./scriptLifecycle";

/** on_load / on_change / on_complete: the most a run may take before it is given up */
export const LOGIC_RUN_TIMEOUT_MS = 3000;
/** an on_change is run this long after the last change of the same question */
export const ON_CHANGE_DEBOUNCE_MS = 120;

/** `null`: no answer in time; `"closed"`: the frame was disposed while the run waited (page left, or a dev double mount) */
export interface LogicRunner { run(req: { scripts: PreparedLogicScript[]; snap: LogicSnapshot }, timeoutMs: number): Promise<LogicScriptOutcome[] | null | "closed"> }

export interface LogicEventOutcome {
  logs: string[];
  errors: { message: string; questionRef?: string }[];
  /** scripts that ran (answered) */
  ran: number;
  /** names the code gate refused */
  refusedScripts: string[];
  /** writes accepted / refused by the engine */
  written: number;
  refusedWrites: number;
  /** the frame did not answer in time: nothing of this run was applied */
  timedOut: boolean;
  /** the frame was closed under the run (the page was left, or React mounted twice in dev): nothing applied, not a timeout */
  closed?: boolean;
}

const callOf = (w: ScriptWrite) => w.kind === "answer" ? `set("${w.ref}")` : w.kind === "calculated" ? `setCalc("${w.name}")` : w.kind === "embedded" ? `setEmbedded("${w.name}")` : `flag("${w.name}")`;

export async function runLogicEvent(
  def: SurveyDefinition,
  state: ResponseState,
  event: CustomScript["event"],
  opts: {
    scopeRef?: string | string[]; loop?: LoopContext | null; only?: "scoped";
    /** run exactly these scripts (a custom_script rule names one), whatever their event */
    ids?: string[];
    /** the answer under test (custom_script rules) */
    value?: unknown;
    runner: LogicRunner | null;
    apply: (write: ScriptWrite, script: PreparedLogicScript) => { ok: boolean; reason?: string };
    timeoutMs?: number;
  },
): Promise<LogicEventOutcome> {
  const out: LogicEventOutcome = { logs: [], errors: [], ran: 0, refusedScripts: [], written: 0, refusedWrites: 0, timedOut: false };
  const prep = prepareLogicScripts(def, state, event, { scopeRef: opts.scopeRef, loop: opts.loop ?? null, only: opts.only, ids: opts.ids });
  for (const r of prep.refused) { out.logs.push(`[${r.name}] refused: ${r.reason}`); out.refusedScripts.push(r.name); }
  if (!prep.scripts.length) return out;
  const names = prep.scripts.map((s) => s.name).join(", ");
  if (!opts.runner) { out.logs.push(`[${names}] not run: the script frame is not available here`); return out; }
  const timeoutMs = opts.timeoutMs ?? LOGIC_RUN_TIMEOUT_MS;
  const snap = logicSnapshot(def, state, opts.loop ?? null, prep.scripts.map((s) => s.body), opts.value);
  let results: LogicScriptOutcome[] | null | "closed";
  try { results = await opts.runner.run({ scripts: prep.scripts, snap }, timeoutMs); }
  catch { results = null; }
  if (results === "closed") {
    out.closed = true;
    out.logs.push(`[${names}] ${event}: not run — the frame was closed (the page was left or re-mounted); nothing written`);
    return out;
  }
  if (!results) {
    out.timedOut = true;
    out.logs.push(`[${names}] ${event}: no answer within ${timeoutMs} ms — not run, nothing written`);
    return out;
  }
  const answered = results;
  prep.scripts.forEach((script, i) => {
    const r = answered[i];
    if (!r) { out.logs.push(`[${script.name}] ERROR: no result`); return; }
    out.ran++;
    out.logs.push(...(r.logs ?? []).map((l) => `[${script.name}] ${l}`));
    out.errors.push(...(r.errors ?? []).filter((e) => e && typeof e.message === "string"));
    if (r.failed) out.logs.push(`[${script.name}] ERROR: ${r.failed}`);
    for (const w of r.writes ?? []) {
      let res: { ok: boolean; reason?: string };
      try { res = opts.apply(w, script); } catch (e) { res = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
      if (res.ok) out.written++;
      else { out.refusedWrites++; out.logs.push(`[${script.name}] ${callOf(w)} refused: ${res.reason ?? "not allowed"}`); }
    }
  });
  return out;
}

/**
 * A logic event as the S1a lifecycle helper's `AskFrames`: `runScriptLifecycle` then maps `error(message, ref)` to
 * the page's questions (id, code or variable) or the page banner exactly as for a sandboxed UX script's rs.error,
 * and bounds the round. `onOutcome` receives the run (logs, counts) for the Runner's inspector.
 */
export function logicAsk(label: string, run: (timeoutMs: number) => Promise<LogicEventOutcome>, onOutcome?: (o: LogicEventOutcome) => void): AskFrames {
  return async (_ev, timeoutMs) => {
    const o = await run(timeoutMs);
    onOutcome?.(o);
    if (o.timedOut) return [{ script: label, timedOut: true }];
    return [{ script: label, errors: o.errors.map((e) => ({ message: e.message, ref: e.questionRef ?? null })) }];
  };
}

/** a custom_script validation rule the engine skipped (validatePage with scripts: "skip"), run in the frame */
export interface SkippedRule { questionId?: string; script: string; value?: unknown; severity?: "error" | "warning"; failMessage?: string | { text: string; html: true } }

export async function runCustomScriptRules(
  def: SurveyDefinition,
  state: ResponseState,
  skipped: SkippedRule[],
  opts: { loop?: LoopContext | null; runner: LogicRunner | null; apply: (write: ScriptWrite, script: PreparedLogicScript) => { ok: boolean; reason?: string }; timeoutMs?: number },
): Promise<{ errors: { questionId: string; message: string; severity?: "error" | "warning" }[]; logs: string[] }> {
  const errors: { questionId: string; message: string; severity?: "error" | "warning" }[] = [];
  const logs: string[] = [];
  for (const sk of skipped) {
    const script = def.scripts.find((s) => s.id === sk.script || s.name === sk.script);
    if (!script) continue;
    const o = await runLogicEvent(def, state, script.event, { ids: [script.id], value: sk.value ?? null, loop: opts.loop, runner: opts.runner, apply: opts.apply, timeoutMs: opts.timeoutMs });
    logs.push(...o.logs);
    // refused by the gate, or no answer in time: a script nobody can run must not hold the respondent
    if (!o.ran) continue;
    const sev = sk.severity && sk.severity !== "error" ? { severity: sk.severity } : {};
    for (const e of o.errors) errors.push({ questionId: sk.questionId ?? "", message: e.message, ...sev });
    if (o.logs.some((l) => l.startsWith(`[${script.name}] ERROR: `))) {
      const m = sk.failMessage ?? "This answer could not be checked.";
      errors.push({ questionId: sk.questionId ?? "", message: typeof m === "string" ? m : m.text, ...sev });
    }
  }
  return { errors, logs };
}

/**
 * ON_CHANGE, DEBOUNCED PER QUESTION. A respondent typing into a box changes it on every key; the page's on_change
 * scripts run once the question has been still for ON_CHANGE_DEBOUNCE_MS. `flush()` runs every pending one at once
 * (Next calls it before validating, so a change made just before the click is never lost) and resolves when all
 * runs — including ones already in flight — have finished.
 */
export function onChangeScheduler(run: (questionId: string) => Promise<unknown>, delayMs = ON_CHANGE_DEBOUNCE_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let chain: Promise<unknown> = Promise.resolve();
  const fire = (id: string) => { timers.delete(id); chain = chain.then(() => run(id)).catch(() => undefined); return chain; };
  return {
    schedule(id: string) {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.set(id, setTimeout(() => { void fire(id); }, delayMs));
    },
    async flush() {
      for (const [id, t] of [...timers]) { clearTimeout(t); void fire(id); }
      await chain;
    },
    cancel() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    pending: () => timers.size,
  };
}
