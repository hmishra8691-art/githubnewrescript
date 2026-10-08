/**
 * "CHANGED ELSEWHERE" ONLY WHEN SOMETHING CHANGED ELSEWHERE (07-10-2026
 * review, Suraj #5: "the highlighted issue popup appears every time, even
 * when there is no new action or issue").
 *
 * A draft save sends the revision this editor is working on top of, and the
 * database refuses it when the row has moved on — which is right, and is the
 * only protection two editors have against overwriting each other. The popup
 * was appearing when the only editor that had moved the row was THIS one.
 * Two causes, both in the client:
 *
 * 1. TWO SAVES ON ONE REVISION. Every writer awaited the save in flight and
 *    then started its own — but nothing re-checked after waking, so when an
 *    autosave tick and a flush (Preview, Test, an Intelligent apply, Save
 *    version, switching tab) were both waiting on the same save, both woke,
 *    both read the same revision and both sent it. The first was accepted
 *    and bumped the revision; the second was refused as stale, and the editor
 *    stopped saving and told the programmer someone else had changed the
 *    survey. Typing while a save is in flight and then pressing Preview is
 *    enough. `serialRunner` makes the writes a queue: each starts only after
 *    the one before it has finished, so each reads the revision its
 *    predecessor returned.
 *
 * 2. A SAVE WHOSE ANSWER WAS LOST. A write the server accepted but whose
 *    response never arrived (a dropped connection, a tab put to sleep) leaves
 *    the editor one revision behind its own work. The next save is refused,
 *    and the "newer work" on the server is the editor's own. The refusal
 *    carries the server's draft, so `isOwnWrite` asks the question the popup
 *    is supposed to answer — does the server hold anything this editor did
 *    not send? — and when it does not, the editor adopts the server's
 *    revision and saves again instead of raising an alarm.
 *
 * A real conflict — another tab, another person, a version restored
 * elsewhere — still blocks autosave and still says so, exactly as before.
 */

/** Run async jobs one at a time, in call order; each sees what the last one left. */
export function serialRunner<T>(): (job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const next = tail.then(job, job);
    // the queue continues whether this job succeeded or not
    tail = next.catch(() => undefined);
    return next;
  };
}

/** JSON with object keys sorted, so key order never makes two equal values differ. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

/**
 * Is the server's draft one this editor wrote? `sent` holds the definitions
 * this editor has sent (most recent last), each already in the form the
 * server stores (`normalize` — the schema's defaults and element ids — is
 * applied by the caller, so this stays pure).
 */
export function isOwnWrite(serverDraft: unknown, sent: readonly unknown[]): boolean {
  if (serverDraft == null || !sent.length) return false;
  const server = canonicalJson(serverDraft);
  return sent.some((d) => canonicalJson(d) === server);
}

/** A short memory of what was sent — enough to recognise a lost answer, small enough to keep. */
export function rememberSent<T>(list: readonly T[], next: T, keep = 4): T[] {
  return [...list, next].slice(-keep);
}
