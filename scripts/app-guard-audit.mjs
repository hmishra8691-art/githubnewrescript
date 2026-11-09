#!/usr/bin/env node
/**
 * THE TWO APPLICATIONS THE AUTHORISATION AUDIT NEVER READ (platform audit 2026-11-05).
 *
 * scripts/auth-guard-audit.mjs begins `const ROOT = "apps/studio/app/api"`. Its headline — 279 handlers, 0
 * problems — is a statement about the Studio alone. The Interviews app's 31 routes and the runtime's 32 were
 * correctly guarded on the day of the audit, and nothing would have noticed if one stopped being: a route added
 * to either app that forgot its gate produced no failure anywhere, while the same mistake in the Studio failed
 * immediately. This script closes that.
 *
 * The two apps authenticate differently, so they are held to different rules — the rule each actually follows:
 *
 *   INTERVIEWS   like the Studio: every handler calls one of the app's gates (`requireUser`, `requireProject`,
 *                `requireMedia`, `candidateGate`, the cron's `authorised`) and the call is the first thing it
 *                does after parsing its input. A route with no gate is listed in PUBLIC with the reason.
 *
 *   RUNTIME      respondent-facing: there is no account, so there is no `requireUser`. Each route authenticates
 *                by a credential it carries — the session id the runner was issued, a signed media ticket, a
 *                participant token, the versioned definition's access check, the response id a redirect was
 *                built with, CRON_SECRET — and the credential is checked inside the service it calls. So every
 *                route is DECLARED below with the credential it relies on and the evidence of it in the source
 *                (a call, a header, a token name), and a route that is not declared, or whose evidence has
 *                disappeared, fails. Adding a runtime route means writing down what authenticates it.
 *
 * Exit code 1 on any failure. Run by `pnpm audit:code` beside the Studio audit.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const failures = [];
let checked = 0;

function routes(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") out.push(full);
    }
  })(root);
  return out.sort();
}

function handlerBody(src, verb) {
  const re = new RegExp(`export async function ${verb}\\s*\\(|export function ${verb}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const from = m.index;
  const next = src.slice(from + m[0].length).search(/\n(?:export\s+)?(?:async\s+)?function\s|\nexport const\s/);
  return src.slice(from, next === -1 ? src.length : from + m[0].length + next);
}

/* ================================================================ interviews */

const INTERVIEWS_ROOT = "apps/interviews/app/api";
const INTERVIEWS_GATES = ["requireUser", "requireProject", "requireProjectFor", "requireMedia", "candidateGate", "authorised"];
const INTERVIEWS_PUBLIC = {
  "auth/callback/route.ts": "the sign-in callback from the Studio's hand-off: it is what CREATES the session, so it cannot require one; it verifies the signed code",
};

for (const file of routes(INTERVIEWS_ROOT)) {
  const rel = relative(INTERVIEWS_ROOT, file);
  const src = readFileSync(file, "utf8");
  if (INTERVIEWS_PUBLIC[rel]) { console.log(`  pub  interviews/${rel} — ${INTERVIEWS_PUBLIC[rel]}`); continue; }
  for (const verb of VERBS) {
    const body = handlerBody(src, verb);
    if (!body) continue;
    checked++;
    const gate = INTERVIEWS_GATES.find((g) => body.includes(`${g}(`));
    if (!gate) { failures.push(`interviews/${rel} ${verb} — NO GATE CALL (one of ${INTERVIEWS_GATES.join(", ")})`); continue; }
    /* nothing but input parsing before the gate: a query before it is access on an unauthenticated request */
    const before = body.slice(0, body.indexOf(`${gate}(`));
    if (/\.(from|rpc)\(|supabase|Store\(\)\./.test(before)) { failures.push(`interviews/${rel} ${verb} — touches data before ${gate}()`); continue; }
    console.log(`  ok   interviews/${rel} ${verb} — ${gate}`);
  }
}

/* =================================================================== runtime */

const RUNTIME_ROOT = "apps/runtime/app/api";
/** route → what authenticates it, and the evidence that must still be in the source */
const RUNTIME_CREDENTIALS = {
  "ai-interview/begin/route.ts": { by: "the study's participant token (aiInterviewDeps → the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/media/[action]/route.ts": { by: "the participant's session and a signed media ticket", evidence: /aiInterviewDeps\(|signed/ },
  "ai-interview/realtime/session/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/sandbox/route.ts": { by: "a runtime with no database only; in-memory sandbox state keyed by its own token", evidence: /sandbox/i },
  "ai-interview/session/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/speak/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/study/route.ts": { by: "the study's participant token (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/transcribe/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/listen/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "ai-interview/turn/route.ts": { by: "the participant's session (the service checks it)", evidence: /aiInterviewDeps\(/ },
  "assessment/sandbox/route.ts": { by: "a runtime with no database only (403 elsewhere); attempts bound to their own token", evidence: /sandboxAvailable\(\)/ },
  "geocode/route.ts": { by: "the session id, through definitionForProviderCall (a provider call needs a session whose survey asks for it)", evidence: /definitionForProviderCall\(/ },
  "group/route.ts": { by: "the group session's participant token (participant() checks it)", evidence: /participant\(/ },
  "live/media/[action]/route.ts": { by: "the live room's member token and a signed media ticket", evidence: /liveStore\(\)|signed/ },
  "live/route.ts": { by: "the live room's member / invitation token (the store checks it per action)", evidence: /liveStore\(\)/ },
  "media/[...path]/route.ts": { by: "a signed, expiring media URL (the signature is verified before any byte is read)", evidence: /signed|verify/ },
  "panel/exit/route.ts": { by: "the response id (a random UUID, the respondent's own); answers only that response's end link", evidence: /searchParams\.get\("r"\)|\.get\("r"\)/ },
  "runtime-definition/[versionId]/route.ts": { by: "definitionAccess: the version's access rule (test / live / token)", evidence: /definitionAccess|access/ },
  "session/ai/route.ts": { by: "the session id (aiSession resolves and checks it)", evidence: /aiSession|sessionId/ },
  "session/assessment/route.ts": { by: "the session id", evidence: /sessionId/ },
  "session/balance/route.ts": { by: "the session id", evidence: /sessionId/ },
  "session/build-stamp/route.ts": { by: "none needed — returns one revision counter for a survey id, no respondent data", evidence: /revision/ },
  "session/dictate/route.ts": { by: "the session id (x-session-id), through definitionForProviderCall", evidence: /definitionForProviderCall\(|x-session-id/ },
  "session/listfill/route.ts": { by: "the session id", evidence: /sessionId/ },
  "session/media/confirm/route.ts": { by: "the session id and the ticket it was issued", evidence: /sessionId/ },
  "session/media/parts/route.ts": { by: "the session id and the ticket it was issued", evidence: /sessionId/ },
  "session/media/ticket/route.ts": { by: "the session id; issues a signed ticket", evidence: /sessionId|signed/ },
  "session/media/transcript/route.ts": { by: "the session id (gateFor)", evidence: /gateFor\(/ },
  "session/probe/route.ts": { by: "the session id (aiSession)", evidence: /aiSession/ },
  "session/sandbox/route.ts": { by: "a runtime with no database only; the sandbox's own session id", evidence: /sessionId/ },
  "session/save/route.ts": { by: "the session id (the row is updated only where it matches, and only while in progress)", evidence: /sessionId/ },
  "session/start/route.ts": { by: "the deployed link (test / live) plus the access token when the gateway issued one; the row is created here", evidence: /accessToken|sessionId/ },
  "upload/route.ts": { by: "retired — answers 410 and touches nothing", evidence: /410/ },
};

for (const file of routes(RUNTIME_ROOT)) {
  const rel = relative(RUNTIME_ROOT, file);
  const src = readFileSync(file, "utf8");
  const decl = RUNTIME_CREDENTIALS[rel];
  const verbs = VERBS.filter((v) => handlerBody(src, v));
  checked += verbs.length;
  if (!decl) { failures.push(`runtime/${rel} — NOT DECLARED: say what authenticates it in RUNTIME_CREDENTIALS (scripts/app-guard-audit.mjs)`); continue; }
  if (!decl.evidence.test(src)) { failures.push(`runtime/${rel} — the declared credential's evidence (${decl.evidence}) is no longer in the source`); continue; }
  console.log(`  ok   runtime/${rel} ${verbs.join("/")} — ${decl.by}`);
}
for (const rel of Object.keys(RUNTIME_CREDENTIALS)) {
  try { statSync(join(RUNTIME_ROOT, rel)); } catch { failures.push(`runtime/${rel} — declared but no longer exists; remove it from RUNTIME_CREDENTIALS`); }
}

console.log(`\n${checked} Interviews and runtime handlers checked, ${failures.length} problem(s)`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
