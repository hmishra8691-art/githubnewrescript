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

/**
 * THE SECOND RULE, added for P0-6 and P0-7.
 *
 * A capability check alone is not enough to accept a change to the survey.
 * §16 of the original spec and the P0 list both state the condition three
 * ways over: current user == locked_by_user_id AND current session ==
 * locked_by_session_id AND the lock is still valid. `requireProject(…,
 * "survey.edit")` answers only the first third of that, so a handler that
 * mutates the definition behind it would accept two editors' writes and lose
 * one of them — which is P0-6 — while looking perfectly guarded to the
 * original version of this audit.
 *
 * So: any handler that asks for one of these capabilities must go through
 * `requireEditRight`.
 */
const LOCKED_CAPABILITIES = ["survey.edit", "survey.save_version"];

/**
 * Capabilities deliberately guarded by ROLE ALONE, with the reason.
 *
 * Not an oversight, and worth stating so the next person does not "fix" it.
 * The edit lock exists to stop two people overwriting one DOCUMENT — the
 * survey definition. It is the wrong instrument for anything else, and
 * applying it everywhere would mean a deployment manager could not publish
 * while a programmer had the questions open, which is precisely the
 * separation of duties §11 asks for.
 */
const CAPABILITY_ONLY = {
  "responses.manage":
    "response data is not the survey document: concurrent changes to different rows are not a lost update, "
    + "and purging test data must not require taking editing away from a colleague",
  "deploy.manage":
    "a deployment manager holds no editing capability at all (§11), so they can never hold the lock — "
    + "requiring it would leave the role unable to do its only job",
};

/**
 * Handlers that ask for a locked capability but are exempt, with the reason.
 *
 * One route, and it is a judgement rather than a gap. `quality_profiles` is a
 * WORKSPACE-level library of reusable quality settings, keyed by
 * (customer_id, name) and shared across every project. It borrows
 * `survey.edit` on some project as a proxy for "may configure quality", which
 * correctly refuses a viewer or a reviewer — so P0-7 is closed here — but the
 * row it writes belongs to no survey's definition. Requiring a particular
 * survey's edit lock to save a reusable profile would be arbitrary (which
 * survey?) and a regression in the quality workflow.
 */
const LOCK_EXEMPT = {
  "surveys/[id]/quality/profiles/route.ts POST":
    "writes a workspace-level reusable profile, not the survey definition",
  "surveys/[id]/quality/profiles/route.ts DELETE":
    "deletes a workspace-level reusable profile, scoped to the caller's own workspace",
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
const lockExempt = [];
const capabilityOnly = [];

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

    /*
     * P0-6 / P0-7: capability is not enough for a change to the survey.
     *
     * Only non-GET handlers are asked this. A GET that reads with
     * `survey.edit` is answering "may this person edit?", which is a question
     * about capability and has nothing to do with who currently holds the
     * lock.
     */
    const asksForLocked = LOCKED_CAPABILITIES.filter((c) => body.includes(`"${c}"`));
    const usesEditRight = /requireEditRight(For)?\s*\(/.test(body);
    const exemptKey = `${rel} ${verb}`;
    if (verb !== "GET" && asksForLocked.length && !usesEditRight) {
      if (LOCK_EXEMPT[exemptKey]) {
        lockExempt.push(`${exemptKey} — ${LOCK_EXEMPT[exemptKey]}`);
      } else {
        failures.push(
          `${rel} ${verb} — asks for ${asksForLocked.join(", ")} but never calls requireEditRight, `
          + "so it would accept a write from an editor who does not hold the lock (P0-6)",
        );
        continue;
      }
    }

    // which write capabilities this handler guards by role alone, reported so
    // the shape of the whole surface is visible rather than assumed
    for (const [cap, why] of Object.entries(CAPABILITY_ONLY)) {
      if (verb !== "GET" && body.includes(`"${cap}"`) && !usesEditRight) {
        capabilityOnly.push(`${exemptKey} — ${cap}: ${why}`);
      }
    }

    console.log(`  ok   ${rel} ${verb} — ${guard}${usesEditRight && verb !== "GET" ? " + edit lock" : ""}`);
  }
}

console.log(`\nDeliberately public (${exempt.length}):`);
for (const e of exempt) console.log(`  · ${e}`);

if (capabilityOnly.length) {
  console.log(`\nWrite handlers guarded by role alone, by design (${capabilityOnly.length}):`);
  for (const e of capabilityOnly) console.log(`  · ${e}`);
}
if (lockExempt.length) {
  console.log(`\nExempt from the edit-lock rule, with a stated reason (${lockExempt.length}):`);
  for (const e of lockExempt) console.log(`  · ${e}`);
}

console.log(`\n${checked} handlers checked, ${failures.length} problem(s)`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
