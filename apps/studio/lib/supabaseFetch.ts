/**
 * THE FETCH EVERY SERVER-SIDE SUPABASE CLIENT IN THIS APP USES.
 *
 * Two jobs, both learned the hard way.
 *
 * ## 1. Caching off — a correctness requirement, not a performance opinion
 *
 * Next's App Router patches the global `fetch` and, in this version, caches
 * GET requests in its Data Cache by default, with no expiry. supabase-js uses
 * that global `fetch`, so a `.select()` could be answered from a cache
 * indefinitely. For this platform that is a correctness bug rather than a
 * staleness annoyance:
 *
 *   · `requireUser` re-reads the session row on every request precisely so
 *     that an administrator's "revoke" takes effect immediately — a cached
 *     read gives back exactly the property the re-read exists to provide;
 *   · quota counters, List Fill allocation counts, response totals and the
 *     survey draft are all read this way, and a live quota that reads a
 *     cached count over-fills.
 *
 * RPCs happen to be POSTs and were never at risk, but relying on that is
 * relying on an implementation detail of a library. Caching is turned off at
 * the client instead — once, here, rather than at every call site where one
 * would eventually be missed.
 *
 * ## 2. A momentary gateway failure is not an answer
 *
 * On 14 September the Studio showed "Cannot verify your session right now" for
 * about ten minutes. Nothing was wrong with the deployment and nothing was
 * wrong with the database: Postgres logged no errors at all and was answering
 * its queries in well under a millisecond throughout. Supabase's API gateway
 * was returning 500, 502 and 504 for a fraction of requests, with origin times
 * of five to sixteen seconds — PostgREST unwell in front of a healthy
 * database. In the same hour, 274 identical `user_sessions` reads succeeded.
 *
 * A single-row lookup by primary key that fails that way has not been
 * answered; it has not been attempted. Asking again a moment later is the
 * honest reading of a 502, and it is what turns most of a ten-minute wobble
 * into something nobody sees.
 *
 * This does not pretend to survive a long outage — three attempts over about
 * half a second cannot, and should not try. It removes the single dropped
 * request, which is the shape the logs show on an ordinary day: isolated 504s
 * at 06:05, 07:45, 09:00, 09:45, 10:20, each one of them somebody's dashboard
 * going red for no reason they could act on.
 *
 * ### Only reads are retried, and that is the whole safety argument
 *
 * A PostgREST RPC is a POST and some of ours write: `rescript_save_draft`,
 * `rescript_acquire_lock`, the audit insert. A 504 means "no reply", NOT "did
 * not happen" — repeating a write could double it. So writes are passed
 * straight through and only GET and HEAD are ever repeated. That is enough to
 * cover the session gate, which is where the outage was felt.
 *
 * 429 is deliberately absent from the retry list: a rate limit is the one
 * failure that asking again immediately makes worse.
 *
 * NOTE: `apps/runtime/lib/supabaseFetch.ts` is a copy of this file, for the
 * same reason `lib/admin.ts` is duplicated — the two apps do not share a lib
 * and this is not worth a package. `scripts/supabase-fetch-test.mjs` asserts
 * the two copies stay identical, so the duplication cannot silently drift.
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
