/**
 * STATIC AUDIT — every API handler is behind the gate.
 *
 * The realistic long-term failure of an authorization layer is not that the
 * gate is wrong. It is that somebody adds a route in six months and forgets to
 * call it — and nothing fails, because an ungated route works perfectly. It
 * just works for everybody.
 *
 * So this walks every exported HTTP handler in the Studio's API and asserts
 * that its FIRST statement is a guard call. It is a lint, not a test of
 * behaviour, and that is exactly why it is worth having: a behavioural test
 * only covers the routes someone thought to write a test for.
 *
 *   node scripts/auth-guard-audit.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "apps/studio/app/api";
const GUARDS = ["requireUser", "requireProject", "requireProjectFor", "requireEditRight", "requireEditRightFor", "requireAdmin"];

/**
 * Routes that are deliberately public, with the reason.
 *
 * Every entry here is a decision, not an omission — an unauthenticated caller
 * must be able to sign in, create an account and ask for a password reset, and
 * none of those can require a session to work.
 */
const PUBLIC = {
  "auth/login/route.ts": "signing in cannot require being signed in; it throttles and audits instead",
  "auth/signup/route.ts": "creating an account cannot require an account",
  "auth/password/route.ts": "a password reset is for people who cannot sign in; answers identically for unknown addresses",
  "auth/logout/route.ts": "signing out must never fail, including from an already-dead session",
  "auth/heartbeat/route.ts": "validates the session cookie itself and answers 401 without the guard's shape",
};

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry === "route.ts") files.push(full);
  }
})(ROOT);
files.sort();

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
let checked = 0;
const failures = [];
const exempt = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");

  if (PUBLIC[rel]) {
    exempt.push(`${rel} — ${PUBLIC[rel]}`);
    continue;
  }

  for (const verb of VERBS) {
    const re = new RegExp(`export async function ${verb}\\s*\\(`, "g");
    const m = re.exec(src);
    if (!m) continue;
    checked++;

    /*
     * The handler body, found by depth counting rather than a regex.
     *
     * The parameter list has to be walked past FIRST: `(req: NextRequest, {
     * params }: { params: { id: string } })` contains braces, so reaching for
     * the next `{` after the function name reads the destructuring pattern as
     * the body and every handler looks unguarded. Close the parens, then open
     * the block.
     */
    let paren = 1, afterParams = m.index + m[0].length;
    while (paren > 0 && afterParams < src.length) {
      if (src[afterParams] === "(") paren++;
      else if (src[afterParams] === ")") paren--;
      afterParams++;
    }
    const open = src.indexOf("{", afterParams);
    let depth = 0, end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(open + 1, end);

    const guard = GUARDS.find((g) => body.includes(`${g}(`));
    if (!guard) {
      failures.push(`${rel} ${verb} — NO GUARD CALL`);
      continue;
    }

    /*
     * The guard must come FIRST. A handler that reads the body, touches the
     * database, or decides anything before authorizing has already acted on
     * an unauthenticated request — and "it returns 401 eventually" is not the
     * same as "it did nothing".
     */
    const guardAt = body.indexOf(`${guard}(`);
    const before = body.slice(0, guardAt);
    const strippedBefore = before
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    // only a declaration of the guard's own result may precede it
    const preambleOk = strippedBefore === "" || /^const\s+\w+\s*=\s*await\s*$/.test(strippedBefore);
    if (!preambleOk) {
      failures.push(`${rel} ${verb} — guard is not the first statement; ${JSON.stringify(strippedBefore.slice(0, 90))} runs first`);
      continue;
    }

    // and its refusal must be returned, not discarded
    if (!/isFailure\s*\(/.test(body)) {
      failures.push(`${rel} ${verb} — calls ${guard} but never checks isFailure(), so a refusal is ignored`);
      continue;
    }
    console.log(`  ok   ${rel} ${verb} — ${guard}`);
  }
}

console.log(`\nDeliberately public (${exempt.length}):`);
for (const e of exempt) console.log(`  · ${e}`);

console.log(`\n${checked} handlers checked, ${failures.length} unguarded`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
