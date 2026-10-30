import { NextResponse } from "next/server";
import { buildRuntimeCsp } from "./lib/csp";

/*
 * Respondent pages carry the runtime's Content-Security-Policy (S0b — `lib/csp.ts` says what it blocks and why).
 * Built once, from the environment the server booted with; RUNTIME_CSP=off|report|enforce (default enforce).
 */
const CSP = buildRuntimeCsp(process.env);

export function middleware() {
  const res = NextResponse.next();
  if (CSP.enforce) res.headers.set("Content-Security-Policy", CSP.enforce);
  if (CSP.reportOnly) res.headers.set("Content-Security-Policy-Report-Only", CSP.reportOnly);
  return res;
}

/* every page and route except Next's static assets (a CSP on a script file does nothing) */
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
