/**
 * SINGLE-FLIGHT (audit F-1).
 *
 * Callers that ask for the same thing at the same moment share one piece of
 * work instead of each starting their own: a cold Charts tab used to start up
 * to nine full row loads, one per chart, all reading the same responses.
 * The entry is removed when the work settles — success or failure — so the
 * next caller after that starts fresh (the row cache, not this, holds results).
 */
export function singleFlight<T>() {
  const flying = new Map<string, Promise<T>>();
  return (key: string, work: () => Promise<T>): Promise<T> => {
    const hit = flying.get(key);
    if (hit) return hit;
    const p = work().finally(() => { if (flying.get(key) === p) flying.delete(key); });
    flying.set(key, p);
    return p;
  };
}
