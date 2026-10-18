/**
 * THE HARNESS'S TEST USER (AI evaluation harness only — loaded by scripts/eval/hooks.mjs, never by Next).
 *
 * Everything is the real guard (`@/lib/guard`) except `requireUser`: a request that carries this process's random
 * eval token (header `x-rescript-eval`) is the harness's own test user — no session, no database, no customer.
 * Every other request goes to the real check. The token is generated per process and never leaves it, so nothing
 * outside the harness can present it. The harness only ever names the `sandbox` project, so billing goes to the
 * in-memory sandbox meter and no customer project is read or written.
 */
export * from "../../apps/studio/lib/guard.ts";
import { requireUser as realRequireUser } from "../../apps/studio/lib/guard.ts";

export const EVAL_USER = Object.freeze({
  userId: "00000000-0000-4000-8000-0000000e7a11", sessionId: "eval", email: "eval@harness.invalid", fullName: "AI evaluation harness",
  userCode: "EVAL", platformRole: "programmer", customerId: null, isPlatformAdmin: false,
  policies: { session: {}, password: {}, access: {} },
});

export async function requireUser(req) {
  const token = process.env.EVAL_HARNESS_TOKEN;
  if (token && req?.headers?.get?.("x-rescript-eval") === token) return EVAL_USER;
  return realRequireUser(req);
}
