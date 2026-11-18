import "server-only";
import { NextResponse } from "next/server";
import type { MfaPolicy } from "@rescript/access/mfa";
import { surveyQrSvg } from "@rescript/exporters";
import { recordAttempt } from "./authServer";
import { platformDb } from "./db";
import { audit } from "./guard";
import { secondFactorCore, type MfaRow, type SecondFactor } from "./mfaCore";

/**
 * The second factor at sign-in, wired to the database (table `user_mfa`, migration 0099), the audit trail and the
 * throttle. The decision itself — and the reasons for each branch — is `secondFactorCore` in lib/mfaCore.ts.
 */
export async function loadMfa(userId: string): Promise<MfaRow | null | "unavailable"> {
  const { data, error } = await platformDb().from("user_mfa").select("user_id, secret_sealed, recovery_hashes, last_step").eq("user_id", userId).maybeSingle();
  if (error) { if (/user_mfa|does not exist|schema cache/i.test(error.message)) return "unavailable"; throw new Error(error.message); }
  return (data as MfaRow | null) ?? null;
}

const now = () => new Date().toISOString();

export async function secondFactor(args: { account: { id: string; email: string; role: string | null; customer_id: string | null }; policy: MfaPolicy; body: Record<string, unknown>; ipHash: string | null; throttleKey: string }): Promise<{ pass: true; recoveryCodes?: string[]; note?: string; passToken?: string } | { pass: false; response: NextResponse }> {
  const r: SecondFactor = await secondFactorCore(args, {
    load: loadMfa,
    saveRecovery: async (userId, hashes) => { await platformDb().from("user_mfa").update({ recovery_hashes: hashes, last_used_at: now(), updated_at: now() }).eq("user_id", userId); },
    claimStep: async (userId, prev, step) => {
      const q = platformDb().from("user_mfa").update({ last_step: step, last_used_at: now(), updated_at: now() }).eq("user_id", userId);
      const { data } = await (prev == null ? q.is("last_step", null) : q.eq("last_step", prev)).select("user_id");
      return !!data?.length;
    },
    insert: async (row) => { const { error } = await platformDb().from("user_mfa").insert({ ...row, last_used_at: now() }); return error?.message ?? null; },
    recordAttempt: (a) => recordAttempt(a),
    audit: (a) => audit(a as never),
    qr: (url) => surveyQrSvg(url, { scale: 4 }),
  });
  return r.pass ? r : { pass: false, response: NextResponse.json(r.body, { status: r.status }) };
}
