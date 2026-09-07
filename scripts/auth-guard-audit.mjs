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
  "share/[token]/route.ts":
    "a report share link is given to people with no account: the TOKEN is the credential, resolved by the "
    + "security-definer function `rescript_resolve_share`, which applies expiry, revocation, password and "
    + "permission in the database. A session guard here would make the feature impossible",
};

/**
 * ROUTERS — one handler, many actions, each with its own guard.
 *
 * The analytics module is one route file with a path-based router behind it:
 * `GET .../analyses/<id>` and `GET .../variables` are different actions
 * needing different capabilities, so the guard cannot be the handler's first
 * statement — it belongs inside the branch that knows which action was asked
 * for. Splitting the file into thirty routes to satisfy a lint would be the
 * lint choosing the architecture.
 *
 * So a router is held to a DIFFERENT and arguably stronger rule, checked
 * below: no QUERY may be issued before the first guard call. Constructing a
 * client is not access; `db.from(...)` and `.rpc(...)` are, and neither may
 * happen on an unauthorized request.
 */
const ROUTERS = {
  "surveys/[id]/analytics/[[...path]]/route.ts":
    "path-based router: each action guards with the analytics capability it needs",
};

/**
 * Handlers that must read the request body BEFORE guarding, with the reason.
 *
 * One route, and it is a real constraint rather than an oversight: the
 * project-configuration PATCH chooses its capability FROM the payload —
 * changing the freeze switch needs `project.lock_settings`, changing a due
 * date needs `survey.edit` — so it cannot know which guard to call until it
 * has seen which fields are being written. Parsing JSON is not access, and
 * the same no-query-before-the-guard rule is applied to these.
 */
const BODY_FIRST = {
  "surveys/[id]/config/route.ts PATCH":
    "the capability depends on which fields the payload changes, so the body decides which guard to call",
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
  "surveys/[id]/tests/route.ts POST":
    "runs and edits the QA test suite (\u00a755/\u00a756), which is not the questionnaire. Needing to take editing "
    + "away from a colleague in order to check whether their change broke path C would defeat the point of "
    + "having a regression suite — and a run writes only its own result rows",
  "surveys/[id]/quotas/audit/route.ts POST":
    "writes an audit_logs row and nothing else — the quota change itself went through the ordinary "
    + "definition autosave, which does hold the lock. Requiring it here would mean an editor who has "
    + "since lost the lock cannot record what they already changed",
  "surveys/[id]/sample-sources/route.ts POST":
    "declares a supplier in public.sample_sources — a row in a table, not a change to the questionnaire",
  "surveys/[id]/sample-sources/route.ts DELETE":
    "removes a declared supplier; the responses that cite it keep their provenance either way",
  "surveys/[id]/themes/route.ts POST":
    "saves a workspace theme in public.themes, shared across projects — a theme is COPIED into a "
    + "definition when applied, never referenced, so saving one changes no survey",
  "surveys/[id]/themes/route.ts DELETE":
    "deletes a workspace theme; surveys already using it are unaffected because they hold their own copy",
  "surveys/[id]/config/route.ts PATCH":
    "records the project's client, manager, fieldwork dates and deadline (\u00a760). Recording a deadline "
    + "is not an act of authorship on the questionnaire, and blocking it behind a colleague's edit lock "
    + "would stop a project manager doing their job",
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
const routed = [];

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

    /*
     * A DELEGATE COUNTS AS A GUARD IF IT DEMONSTRABLY CALLS ONE.
     *
     * The analytics router wraps `requireProject` in a one-line local helper
     * so that thirty branches do not each repeat the argument list. Refusing
     * to see through that would have left the platform's largest route file
     * unaudited, which is the opposite of what this script is for — and
     * simply adding "gate" to the guard list would let any function called
     * `gate` satisfy the audit by name alone.
     *
     * So the file is read for local helpers whose own body calls a real
     * guard, and only those names are honoured. A helper renamed, or emptied
     * out, stops counting immediately.
     */
    const delegates = [...src.matchAll(/(?:async\s+function|const)\s+(\w+)\s*(?:=\s*async\s*)?\(/g)]
      .map((dm) => {
        const from = dm.index ?? 0;
        const nextDecl = src.slice(from + dm[0].length).search(/\n(?:export\s+)?(?:async\s+function|const|function)\s/);
        const scope = src.slice(from, nextDecl === -1 ? src.length : from + dm[0].length + nextDecl);
        return GUARDS.some((g) => scope.includes(`${g}(`)) ? dm[1] : null;
      })
      .filter((n) => n && !VERBS.includes(n));

    const guard = [...GUARDS, ...delegates].find((g) => body.includes(`${g}(`));
    if (!guard) {
      failures.push(`${rel} ${verb} — NO GUARD CALL`);
      continue;
    }

    /*
     * The guard must come FIRST. A handler that reads the body, touches the
     * database, or decides anything before authorizing has already acted on
     * an unauthenticated request — and "it returns 401 eventually" is not the
     * same as "it did nothing".
     *
     * Two shapes cannot satisfy that literally and are held to the
     * no-query-before-the-guard rule instead: a ROUTER, whose guard belongs
     * in the branch that knows which action was asked for, and a handler
     * whose capability is decided BY the payload. Both are declared above
     * with a reason, and both are checked more strictly than the ordering
     * rule can be — a query is access, a JSON parse and an env read are not.
     */
    const guardAt = body.indexOf(`${guard}(`);
    const before = body.slice(0, guardAt);
    const strippedBefore = before
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    const exemptFromOrder = ROUTERS[rel] ?? BODY_FIRST[`${rel} ${verb}`];
    if (exemptFromOrder) {
      const QUERY = /\.\s*(?:from|rpc)\s*\(/;
      const early = QUERY.exec(before);
      if (early) {
        failures.push(
          `${rel} ${verb} — queries the database before its first guard call (${JSON.stringify(before.slice(Math.max(0, early.index - 40), early.index + 30).trim())})`,
        );
        continue;
      }
      routed.push(`${rel} ${verb} — ${exemptFromOrder}`);
    } else {
      // only a declaration of the guard's own result may precede it
      const preambleOk = strippedBefore === "" || /^const\s+\w+\s*=\s*await\s*$/.test(strippedBefore);
      if (!preambleOk) {
        failures.push(`${rel} ${verb} — guard is not the first statement; ${JSON.stringify(strippedBefore.slice(0, 90))} runs first`);
        continue;
      }
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

    const viaDelegate = !GUARDS.includes(guard);
    console.log(
      `  ok   ${rel} ${verb} — ${guard}${viaDelegate ? "() → a real guard" : ""}`
      + `${usesEditRight && verb !== "GET" ? " + edit lock" : ""}`,
    );
  }
}

console.log(`\nDeliberately public (${exempt.length}):`);
for (const e of exempt) console.log(`  · ${e}`);

if (capabilityOnly.length) {
  console.log(`\nWrite handlers guarded by role alone, by design (${capabilityOnly.length}):`);
  for (const e of capabilityOnly) console.log(`  · ${e}`);
}
if (routed.length) {
  console.log(`\nGuarded inside the branch, not on the first line (${routed.length}):`);
  for (const e of routed) console.log(`  · ${e}`);
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
