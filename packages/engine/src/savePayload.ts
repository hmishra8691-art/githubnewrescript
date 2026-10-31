import type { ResponseState } from "./state.js";

/**
 * S2c — THE RESPONSE PART OF A SAVE, as the runtime's Runner posts it (`apps/runtime/components/Runner.tsx`
 * `saveBody` spreads exactly this). Extracted so the Studio's verification harness can ask "would this value be
 * saved?" with the same builder the respondent's browser uses — the owner's "verifies that responses are saved
 * correctly". Pure: no session, no network.
 */
export interface ResponseSavePayload {
  status: ResponseState["status"];
  stepIndex: number;
  answers: ResponseState["answers"];
  calculated: ResponseState["calculated"];
  embedded: ResponseState["embedded"];
  flags: ResponseState["flags"];
  /** S1a: which values sandboxed scripts wrote (script, target, time — never a value); the replay reads it */
  scriptWrites?: ResponseState["scriptWrites"];
}

export function responseSavePayload(state: ResponseState): ResponseSavePayload {
  return {
    status: state.status,
    stepIndex: state.stepIndex,
    answers: state.answers,
    calculated: state.calculated,
    embedded: state.embedded,
    flags: state.flags,
    scriptWrites: state.scriptWrites?.length ? state.scriptWrites : undefined,
  };
}

/** one accepted script write, as the harness saw it: what kind, the key / name the engine wrote, and the state's value after it */
export interface CheckedWrite { kind: "answer" | "embedded" | "calculated" | "flag"; target: string; value: unknown }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Is every accepted write in the state AND in the payload the Runner would post (serialised as it would be sent)?
 * Returns the problems in words; empty when every value would be saved as written.
 */
export function savedWriteProblems(state: ResponseState, writes: CheckedWrite[]): string[] {
  const posted = JSON.parse(JSON.stringify(responseSavePayload(state))) as ResponseSavePayload;
  const out: string[] = [];
  for (const w of writes) {
    if (w.kind === "flag") {
      if (!state.flags.includes(w.target)) out.push(`flag ${w.target}: accepted but not in the response state`);
      else if (!posted.flags?.includes(w.target)) out.push(`flag ${w.target}: in the state but not in the save payload`);
      continue;
    }
    const pick = (p: Pick<ResponseSavePayload, "answers" | "embedded" | "calculated">) => (w.kind === "answer" ? p.answers : w.kind === "embedded" ? p.embedded : p.calculated)?.[w.target];
    const inState = pick(state);
    const inPost = pick(posted);
    if (inState === undefined) { out.push(`${w.kind} ${w.target}: accepted but not in the response state`); continue; }
    if (!same(inState, w.value)) { out.push(`${w.kind} ${w.target}: the state holds ${JSON.stringify(inState).slice(0, 80)}, the harness saw ${JSON.stringify(w.value).slice(0, 80)}`); continue; }
    if (!same(inPost, inState)) out.push(`${w.kind} ${w.target}: the save payload holds ${JSON.stringify(inPost ?? null).slice(0, 80)}, the state ${JSON.stringify(inState).slice(0, 80)}`);
    if (!posted.scriptWrites?.some((r) => r.target === w.target)) out.push(`${w.kind} ${w.target}: not labelled as script-written in the save payload (scriptWrites)`);
  }
  return out;
}
