import { NextRequest, NextResponse } from "next/server";
import type { Meter } from "@rescript/billing";
import { isFailure, requireAdmin, type AuthedUser } from "@/lib/guard";
import { getMeter, getSandboxMeter } from "@/lib/metering";

/**
 * WHO MAY ADMINISTER BILLING. A platform administrator, always. On an
 * installation with no database (the sandbox / a local developer) there is
 * no account to be an administrator of, so the in-memory meter is
 * administered without a session — nothing it holds outlives the process.
 */
const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function requireBillingAdmin(req: NextRequest): Promise<{ ok: true; user: AuthedUser | null; meter: Meter; sandbox: boolean } | { ok: false; response: NextResponse }> {
  if (!dbConfigured()) return { ok: true, user: null, meter: getSandboxMeter(), sandbox: true };
  const user = await requireAdmin(req);
  if (isFailure(user)) return { ok: false, response: user.response };
  return { ok: true, user, meter: getMeter(), sandbox: false };
}

export function billingError(e: unknown): NextResponse {
  const msg = (e as Error).message ?? String(e);
  const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
  return NextResponse.json({ error: unavailable ? "Metered usage is not enabled on this installation yet (migration 0023)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
}
