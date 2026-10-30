/**
 * S1a — THE PAGE'S SCRIPT LIFECYCLE ON NEXT (validate, then submit), as the Runner runs it.
 *
 * Sandboxed scripts may register `rs.listen("validate", fn)` and `rs.listen("submit", fn)`. On Next, once the
 * page's built-in validation (and the legacy on_validate scripts) passed, the Runner asks every frame on the page
 * that registered `validate` and waits for all of them — but never longer than LIFECYCLE_TIMEOUT_MS: a frame that
 * does not answer in time is treated as "no error" and logged, so a slow or stuck script can never trap the
 * respondent. A `validate` handler raises errors with `rs.error(message, ref?)`; with a ref on the page the
 * message is shown on that question exactly like a built-in validation message, otherwise in the page banner, and
 * Next stops. Then the `submit` handlers run (their writes go through the engine-checked channel) before the page is
 * left, bounded the same way. Back and jumps run neither.
 *
 * Kept out of the component so it can be tested without a browser (`scriptLifecycle.test.ts`).
 */

export type LifecycleEvent = "validate" | "submit";
/** what one frame answered: the errors its handlers raised, or that it did not answer in time */
export interface FrameAnswer { script: string; /** S1c: the UX behaviour's id (absent for a logic run, whose failures are counted by the run itself) */ id?: string; errors?: { message: string; ref?: string | null }[]; timedOut?: boolean }
/** the UxLayer's side: ask every frame that listens for `ev`, each bounded by `timeoutMs` */
export type AskFrames = (ev: LifecycleEvent, timeoutMs: number) => Promise<FrameAnswer[]>;

/** the hard bound for one page's handlers, whatever the frames do */
export const LIFECYCLE_TIMEOUT_MS = 1500;
/** errors kept from one page's scripts */
const MAX_ERRORS = 20;

export interface LifecycleOutcome {
  /** errors in the Runner's shape: questionId "" is a page-level message (the banner) */
  errors: { questionId: string; message: string }[];
  logs: string[];
  /** how many frames were asked / timed out */
  asked: number;
  timedOut: number;
  /** S1c: the UX frames (behaviour id and label) that did not answer in time — for the session's script-health list */
  stalled: { id: string; name: string }[];
}

export async function runScriptLifecycle(
  ask: AskFrames | null | undefined,
  ev: LifecycleEvent,
  page: { questions: { id: string; code?: string | number; variableName?: string }[] },
  timeoutMs: number = LIFECYCLE_TIMEOUT_MS,
): Promise<LifecycleOutcome> {
  const out: LifecycleOutcome = { errors: [], logs: [], asked: 0, timedOut: 0, stalled: [] };
  if (!ask) return out;
  let answers: FrameAnswer[] | "timeout";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // the frames bound themselves; this bounds the whole round as well (a little slack for the messages)
    answers = await Promise.race([
      ask(ev, timeoutMs),
      new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs + 250); }),
    ]);
  } catch (e) {
    out.logs.push(`[scripts] ${ev}: ${e instanceof Error ? e.message : String(e)} — treated as no error`);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (answers === "timeout") {
    out.timedOut = 1;
    out.logs.push(`[scripts] ${ev}: no answer within ${timeoutMs} ms — treated as no error`);
    return out;
  }
  out.asked = answers.length;
  const byRef = (ref: string) => page.questions.find((q) => q.id === ref || String(q.code ?? "") === ref || q.variableName === ref);
  for (const a of answers) {
    if (a.timedOut) {
      out.timedOut++;
      out.logs.push(`[ux script “${a.script}”] ${ev}: no answer within ${timeoutMs} ms — treated as no error`);
      if (a.id) out.stalled.push({ id: a.id, name: a.script });
      continue;
    }
    for (const e of a.errors ?? []) {
      const message = String(e?.message ?? "").trim().slice(0, 500);
      if (!message) continue;
      if (ev === "submit") { out.logs.push(`[ux script “${a.script}”] rs.error in a submit handler is ignored (use "validate"): ${message}`); continue; }
      if (out.errors.length >= MAX_ERRORS) break;
      const ref = e.ref == null ? "" : String(e.ref);
      const q = ref ? byRef(ref) : undefined;
      if (ref && !q) out.logs.push(`[ux script “${a.script}”] rs.error: “${ref}” is not a question on this page — shown as a page message`);
      out.errors.push({ questionId: q ? q.id : "", message });
    }
  }
  return out;
}
