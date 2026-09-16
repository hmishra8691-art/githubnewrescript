import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getMeter } from "@/lib/metering";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * RELEASE HOLDS NOTHING EVER CAME BACK FOR.
 *
 * `reserve` puts money aside, `settle` or `release` gives it back, and every
 * reservation carries a TTL because the third case is real: a function timeout
 * on a long transcription or TTS, an instance recycled mid-request, a deploy
 * while a hold is open. The TTL was written on every row, documented as
 * "released back to the wallet", implemented at all three layers —
 * `SupabaseMeterStore.expireReservations`, `Meter`'s store interface,
 * `rescript_billing_expire_reservations` — and CALLED BY NOTHING. There was
 * exactly one scheduled job in the platform and it delivers media.
 *
 * What that looks like to the person it happens to: fifty abandoned $0.50
 * holds on a $25 wallet make `available` zero, so spending and transfers are
 * refused while the balance on the screen still reads $25.00. Nothing ages
 * out, so it only ever gets worse.
 *
 * This is that caller. It is deliberately the whole job — no discovery, no
 * email, nothing that can half-happen: the SQL function releases each expired
 * hold through `rescript_billing_release`, which is the same path a normal
 * release takes and puts the project's `reserved` back too.
 *
 * Batched, because the first run against an installation that has been up for
 * months has a backlog, and one statement over thousands of rows is how a
 * cron job becomes an outage. `rescript_billing_expire_reservations` takes a
 * bounded slice (migration 0034); this loops until a slice comes back short or
 * the time budget is spent, and the next run picks up the rest.
 */

const BUDGET_MS = 45_000;
const SLICE = 1000;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  /* no secret, no run — the same rule as the media job */
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });

  const meter = getMeter();
  const startedAt = Date.now();
  let expired = 0;
  let more = false;
  try {
    for (;;) {
      const n = await meter.store.expireReservations(new Date());
      expired += n;
      if (n < SLICE) break;
      if (Date.now() - startedAt > BUDGET_MS) { more = true; break; }
    }
  } catch (e) {
    console.error("[rescript:billing] reservation expiry failed", { error: (e as Error).message });
    return NextResponse.json({ ok: false, expired, error: (e as Error).message }, { status: 503 });
  }
  if (expired) console.info("[rescript:billing] expired reservations released", { expired, more, ms: Date.now() - startedAt });
  return NextResponse.json({ ok: true, expired, more });
}
