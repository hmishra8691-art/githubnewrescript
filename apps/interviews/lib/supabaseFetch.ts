/**
 * THE FETCH EVERY SERVER-SIDE SUPABASE CLIENT IN THIS APP USES.
 *
 * A copy of `apps/studio/lib/supabaseFetch.ts`, for the same reason
 * `lib/admin.ts` is duplicated: the two apps do not share a lib directory and
 * this is not worth a package of its own. THE FULL REASONING LIVES IN THE
 * STUDIO COPY — caching off so a revoked session cannot be answered from
 * Next's Data Cache, and one retry budget so a momentary Supabase gateway
 * failure is not reported to a respondent as a broken survey.
 *
 * `scripts/supabase-fetch-test.mjs` asserts this file's code is identical to
 * the Studio's, so the two cannot silently drift apart.
 *
 * It matters more here than there. A researcher whose dashboard goes red
 * reloads it; a respondent who meets a 502 halfway through a questionnaire is
 * a lost interview and a charged sample unit.
 */

/**
 * Gateway statuses that mean "ask again", for a request that is safe to ask
 * twice. 500 is included because PostgREST answers 500 when it cannot reach
 * the database, which is the same not-attempted condition; a genuine server
 * error simply returns the same 500 after the retries and costs nothing.
 */
export const TRANSIENT_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** Waits between attempts. Two entries means at most three attempts. */
const BACKOFF_MS: readonly number[] = [150, 450];

/** A request is repeatable only if repeating it cannot change anything. */
export function repeatable(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

export interface SupabaseFetchOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  backoffMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
  onRetry?(attempt: number, why: string): void;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input === "object" && input !== null && "method" in input) {
    return (input as Request).method || "GET";
  }
  return "GET";
}

export function supabaseFetch(options: SupabaseFetchOptions = {}): typeof fetch {
  const base = options.fetchImpl ?? fetch;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const note =
    options.onRetry ??
    ((attempt: number, why: string) => {
      console.warn("[rescript:supabase] transient failure, asking again", { attempt, why });
    });

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: RequestInit = { ...(init ?? {}), cache: "no-store" };
    if (!repeatable(methodOf(input, init))) return base(input as never, request);

    for (let attempt = 0; ; attempt++) {
      /* `undefined` here means the budget is spent: return or throw what we got */
      const wait = backoff[attempt];
      try {
        const res = await base(input as never, request);
        if (wait === undefined || !TRANSIENT_STATUS.has(res.status)) return res;
        /*
         * Let the discarded body go — but NEVER WAIT FOR IT. This runs inside
         * Next's patched `fetch`, whose response streams are instrumented,
         * and awaiting the cancel there deadlocked: `p0-cookie-test` hung for
         * ever on the one check that makes the database fail on purpose. The
         * release is a courtesy to the connection pool; the retry is the job.
         */
        void res.body?.cancel().catch(() => { /* already closed */ });
        note(attempt + 1, `HTTP ${res.status}`);
      } catch (e) {
        if (wait === undefined) throw e;
        note(attempt + 1, (e as Error)?.message ?? "network error");
      }
      await sleep(wait);
    }
  };
}
