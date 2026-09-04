/**
 * THE EIGHT P0s, TESTED FROM THE OUTSIDE.
 *
 * Each check below reproduces a reported production failure and asserts the
 * behaviour that replaced it. They are deliberately about OBSERVABLE
 * behaviour — what the server answered, what the browser did next, what was
 * still on the screen afterwards — because every one of these bugs looked
 * fine from the inside:
 *
 *   P0-1  saved project data appears to disappear
 *   P0-2  cannot save after signing in from another system
 *   P0-3  session expiry causes an infinite refresh/redirect loop
 *   P0-4  an expired user cannot reach the login page
 *   P0-5  session invalidation is mistaken for data deletion
 *   P0-6  the edit lock does not reliably prevent simultaneous editing
 *   P0-7  a read-only user can send an unauthorized save
 *   P0-8  a stale lock blocks other authorized users
 *
 * P0-1/5 and P0-6/8 are proved against a real database in
 * scripts/access-sql-test.sql and scripts/lock-concurrency-test.mjs — where
 * the guarantees actually live. This file covers what only a browser can
 * show: routing, and what happens to unsaved work when a save is refused.
 *
 *   node scripts/p0-session-test.mjs        (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-2222-3333-4444-555555555555";
/* long enough to pass `sessionIdFrom`'s length test, so the app treats it as a
 * real cookie rather than discarding it before any of this is exercised */
const DEAD_COOKIE = "dead0000-0000-0000-0000-000000000000-padding";

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const browser = await chromium.launch();

/* ==================================================================== P0-4 */

console.log("\nP0-4 — an expired session can reach the login page");
{
  /*
   * THE BUG. `middleware.ts` redirected any cookie-HOLDER away from /login to
   * /, on the reasonable-sounding grounds that a signed-in user does not need
   * a sign-in form. But the middleware runs at the edge with no database, so
   * it could only see that a cookie EXISTED — not whether the session behind
   * it was still alive. For somebody whose session had expired, /login was
   * unreachable: by URL, by link, by anything.
   */
  const res = await fetch(`${STUDIO}/login`, {
    headers: { cookie: `rescript_session=${DEAD_COOKIE}` },
    redirect: "manual",
  });
  eq("holding a stale cookie no longer bounces you off /login", res.status, 200);
  const html = await res.text();
  ok("and the sign-in form is actually there", /data-testid="login-identifier"/.test(html));
  ok("...with a password field", /data-testid="login-password"/.test(html));

  // the redirect that DOES remain is the one the middleware can prove: no cookie
  const anon = await fetch(`${STUDIO}/studio/${SURVEY}`, { redirect: "manual" });
  ok("a visitor with no cookie is still sent to sign in",
    anon.status === 307 || anon.status === 308 || anon.status === 302,
    `status ${anon.status}`);
  ok("...and is brought back afterwards",
    (anon.headers.get("location") ?? "").includes("next="),
    anon.headers.get("location") ?? "no location");
}

/* ==================================================================== P0-3 */

console.log("\nP0-3 — no infinite redirect loop, and the dead cookie is thrown away");
{
  const page = await browser.newPage();
  const navigations = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  await page.context().addCookies([{
    name: "rescript_session", value: DEAD_COOKIE, domain: "localhost", path: "/",
  }]);

  /*
   * The loop was: / → page loads → /api/auth/me 401 → /login → middleware →
   * / → forever. Both halves are now closed — the middleware no longer
   * redirects on a cookie's presence, and the API deletes the cookie the
   * moment it finds the session dead — so this settles.
   */
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    // exactly what `failAndSignOut` sends, including clearing the cookie
    headers: { "set-cookie": "rescript_session=; Path=/; Max-Age=0; HttpOnly" },
    body: JSON.stringify({ error: "Your session has expired. Please sign in again.", code: "session_expired", signedOut: true }),
  }));

  await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // long enough for a loop to be obvious

  ok("the login page settles instead of ping-ponging", navigations.length <= 3,
    `${navigations.length} navigations: ${navigations.slice(0, 6).join(" → ")}`);
  ok("and it ends on the login page", page.url().includes("/login"), page.url());
  ok("with a usable form", !!(await page.$('[data-testid="login-identifier"]')));

  /*
   * The other half of the fix — the server DELETING the stale cookie when it
   * discovers the session is dead — is not asserted here, deliberately.
   *
   * A response produced by `route.fulfill` does not go through the browser's
   * cookie jar the way a real one does, so a `set-cookie` on an intercepted
   * response is not applied and a check here would be testing Playwright
   * rather than the platform. It is proved instead in
   * scripts/p0-cookie-test.mjs, which stands up a real Studio against a stub
   * database and reads the actual `set-cookie` header off the wire — along
   * with the two things that matter as much: that an unreachable database
   * does NOT clear the cookie, and that the read is not served from a cache.
   */

  await page.close();
}

/* ==================================================== the editor's harness */

/**
 * The sandbox fixture wired to a server we control, so a refusal can be
 * produced on demand. `?collab=1` opts the fixture into the collaboration
 * layer; without it the sandbox is deliberately editable and none of this
 * would be exercised.
 */
async function editor(drafts) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  const state = { writes: [], revision: 0 };

  await page.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
    state.writes.push(JSON.parse(route.request().postData()));
    const answer = drafts(state);
    return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });

  // the collaboration poll: this session holds the lock, so the editor opens
  // editable — which is itself the fix for "the project became read-only
  // unexpectedly"
  await page.route(`**/api/surveys/${SURVEY}/collab*`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      project: { id: SURVEY, code: "SB", title: "Sandbox", status: "draft", locked: false },
      me: {
        userId: "u1", userCode: "USR-10001", name: "Test Editor", sessionId: "s1",
        role: "editor", roleSummary: "Editor", roleSource: "workspace",
        roleSourceNote: "You have this access because you are a member of this workspace.",
        viaAdmin: false, capabilities: ["survey.edit"],
        canEdit: true, canShare: true, canManageMembers: false,
        canForceRelease: false, canComment: true, readOnly: false,
      },
      lock: { status: "held", mine: true, banner: { tone: "mine", title: "You are editing this project." }, heldBy: null },
      presence: [], openComments: 0,
      poll: { presenceSeconds: 15, lockSeconds: 20, sessionSeconds: 30 },
    }),
  }));
  await page.route(`**/api/surveys/${SURVEY}/publish`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
  await page.route(`**/api/surveys/${SURVEY}/responses*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      userId: "u1", userCode: "USR-10001", name: "Test Editor", email: "t@e.st",
      platformRole: "programmer", isPlatformAdmin: false, sessionId: "s1",
      policies: {
        heartbeatSeconds: 300, lockHeartbeatSeconds: 300, presenceHeartbeatSeconds: 300,
        idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180,
      },
    }),
  }));

  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&rev=0&collab=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  return { page, state };
}

const addQuestion = async (page, text) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(280);
};
const settle = (page) => page.waitForTimeout(1500);
const saveState = (page) => page.$eval('[data-testid="save-state"]', (e) => e.textContent.trim());

/* ============================================================ P0-2 / lock */

console.log("\nP0-2 — a save refused for want of the lock keeps the work and does not lie about why");
{
  /*
   * THE BUG. A lost lock and a stale revision both come back as HTTP 409, and
   * the store discriminated on the STATUS. So an editor who lost the lock for
   * a moment — which is exactly what happens when the same person signs in
   * from a second machine — was told "this survey was changed somewhere else",
   * which was false, and had autosave permanently blocked until they reloaded.
   * That is the reported "I signed in on my laptop and then could not save at
   * all".
   */
  const { page, state } = await editor(() => ({
    status: 409,
    body: {
      error: "This session is not currently holding the edit lock for the project.",
      code: "lock_not_held", keepChanges: true, recoverable: true,
      lock: { userId: "u2", name: "Sarah Lee", userCode: "USR-10002" },
    },
  }));

  await addQuestion(page, "Q1 refused by the lock");
  await settle(page);

  ok("the editor did try to save", state.writes.length > 0);
  const text = await saveState(page);
  ok("the refusal is not misreported as a conflict", !/changed elsewhere/i.test(text), text);
  ok("it names the holder instead", /Sarah Lee/.test(text), text);
  ok("and says the work is still there", /still here/i.test(text), text);

  // §24: nothing was discarded, reset, or replaced with server data
  const stillOnScreen = await page.$$eval(".qcard", (n) => n.length);
  ok("the question is still in the editor", stillOnScreen > 0, `${stillOnScreen} cards`);
  const title = await page.$eval(".qcard .rte-surface", (e) => e.textContent);
  ok("with the text the user typed", /refused by the lock/i.test(title), title);
  ok("and the page did not reload itself", page.url().includes("/sandbox"), page.url());
  ok("an escape hatch is offered — the work can be taken out as a file",
    !!(await page.$('[data-testid="save-download"]')));

  /*
   * And autosave is NOT dead. A lock usually comes back within one poll, and
   * a save that then succeeds without the user doing anything is the outcome
   * they want; blocking would have turned a hiccup into a required reload.
   */
  const before = state.writes.length;
  await addQuestion(page, "Q2 after the refusal");
  await settle(page);
  ok("autosave keeps trying rather than giving up until a reload",
    state.writes.length > before, `${before} → ${state.writes.length}`);

  await page.close();
}

/* ============================================================ P0-2 session */

console.log("\nP0-2 — a save refused because the session ended keeps the work too");
{
  const { page } = await editor(() => ({
    status: 401,
    body: { error: "You signed in on another device, so this session was ended.", code: "session_taken_over", signedOut: true },
  }));

  await addQuestion(page, "Q1 typed after the takeover");
  await settle(page);

  const text = await saveState(page);
  ok("the reason is the real one, not a generic failure", /another device/i.test(text), text);
  ok("and it leads with the reassurance", /still on this screen/i.test(text), text);
  ok("signing in again is offered in a NEW tab, so this one is not navigated away",
    await page.$eval('[data-testid="save-signin"]', (e) => e.getAttribute("target")) === "_blank");
  const title = await page.$eval(".qcard .rte-surface", (e) => e.textContent);
  ok("the typing survived", /after the takeover/i.test(title), title);
  ok("the work can be exported before doing anything else",
    !!(await page.$('[data-testid="save-download"]')));

  await page.close();
}

/* ============================================================ conflict */

console.log("\n§24 — a real conflict never offers to discard the user's work as the only option");
{
  /*
   * THE BUG. The conflict indicator offered a single "Reload" button.
   * Reloading fetches the newer server draft and paints it straight over
   * everything in the editor — for somebody twenty minutes into a change,
   * that is precisely the data loss this whole round is about. The spec is
   * explicit: do not discard unsaved changes, and do not replace the user's
   * work with stale server data.
   */
  const { page } = await editor(() => ({
    status: 409,
    body: { error: "This survey was changed somewhere else after your editor last loaded it.", conflict: true, revision: 9 },
  }));

  await addQuestion(page, "Q1 in a conflicted editor");
  await settle(page);

  const text = await saveState(page);
  ok("the conflict is reported plainly", /changed elsewhere/i.test(text), text);
  ok("and says nothing was overwritten", /nothing was overwritten/i.test(text), text);
  ok("the work can be taken out as a file first", !!(await page.$('[data-testid="save-download"]')));
  const discard = await page.$('[data-testid="save-discard"]');
  ok("the destructive option exists but is NAMED as discarding", !!discard);
  const label = discard ? await discard.textContent() : "";
  ok("...rather than being labelled 'Reload'", /discard/i.test(label), label);
  const title = await page.$eval(".qcard .rte-surface", (e) => e.textContent);
  ok("and until the user chooses, their work is untouched", /conflicted editor/i.test(title), title);

  await page.close();
}

/* ============================================================ P0-7 */

console.log("\nP0-7 — a read-only user cannot save, and is told why in terms they can act on");
{
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const writes = [];
  await page.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    if (route.request().method() === "PUT") writes.push(1);
    /*
     * The BACKEND is the guarantee (§17, §23, §40): even a manipulated client
     * that sends this is refused. The frontend not sending it is the courtesy.
     */
    return route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: "Your role on this project does not allow changes.", code: "no_capability", keepChanges: true, recoverable: false }),
    });
  });
  await page.route(`**/api/surveys/${SURVEY}/collab*`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      project: { id: SURVEY, code: "SB", title: "Sandbox", status: "draft", locked: false },
      me: {
        userId: "u3", userCode: "USR-10003", name: "Read Only", sessionId: "s3",
        role: "viewer", roleSummary: "Read-only.",
        roleSource: "workspace",
        roleSourceNote: "You have this access because you are a member of this workspace.",
        viaAdmin: false, capabilities: ["project.read"],
        canEdit: false, canShare: false, canManageMembers: false,
        canForceRelease: false, canComment: false, readOnly: true,
      },
      lock: { status: "free", mine: false, banner: { tone: "free", title: "Project available for editing." }, heldBy: null },
      presence: [], openComments: 0,
      poll: { presenceSeconds: 15, lockSeconds: 20, sessionSeconds: 30 },
    }),
  }));
  await page.route(`**/api/surveys/${SURVEY}/publish`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
  await page.route(`**/api/surveys/${SURVEY}/responses*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      userId: "u3", userCode: "USR-10003", name: "Read Only", email: "r@o.st",
      platformRole: "programmer", isPlatformAdmin: false, sessionId: "s3",
      policies: {
        heartbeatSeconds: 300, lockHeartbeatSeconds: 300, presenceHeartbeatSeconds: 300,
        idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180,
      },
    }),
  }));

  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&rev=0&collab=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  await page.waitForTimeout(600);

  const body = await page.$('[data-readonly="1"], .is-readonly');
  ok("the editing surface is marked read-only", !!body);
  ok("and the client sends no draft write at all", writes.length === 0, `${writes.length} writes`);

  /*
   * P0-1's other half. Telling a colleague "your role on this project is
   * viewer" sends them to look for themselves in a member list that has never
   * mentioned them; naming the workspace points at a setting an administrator
   * can actually change.
   */
  const notice = await page.textContent("body");
  ok("the read-only reason explains where the access came from",
    /workspace/i.test(notice), "no mention of the workspace in the read-only explanation");

  await page.close();
}

/* ============================================================ auto-acquire */

console.log("\nEditing works on open — no 'enter edit mode' step to find first");
{
  /*
   * The reported "the project became read-only unexpectedly" and "my changes
   * did not persist" were the same thing: the editor opened read-only and
   * waited for a button to be found, so anyone who started typing first was
   * typing into a form that was not going to save. The collaboration poll now
   * asks for the lock as soon as an editing tab is open, and the atomic claim
   * in SQL is what keeps that from producing two editors.
   */
  const { page, state } = await editor((s) => ({
    status: 200, body: { ok: true, savedAt: new Date().toISOString(), revision: ++s.revision },
  }));

  const ro = await page.$('[data-readonly="1"]');
  ok("the editor is editable immediately, with nothing to click", !ro);

  await addQuestion(page, "Q1 typed straight away");
  await settle(page);
  ok("and a question typed straight away is saved", state.writes.length > 0, `${state.writes.length} writes`);
  ok("with the text intact",
    state.writes.at(-1)?.definition?.questions?.length > 0,
    JSON.stringify(state.writes.at(-1)?.definition?.questions?.length));
  ok("the header confirms it", /saved/i.test(await saveState(page)), await saveState(page));

  await page.close();
}

/* ============================================================ diagnostics */

console.log("\n§27 — the diagnostics view answers 'why can I not save' without a DBA");
{
  const { page } = await editor((s) => ({
    status: 200, body: { ok: true, savedAt: new Date().toISOString(), revision: ++s.revision },
  }));

  await page.route(`**/api/surveys/${SURVEY}/diagnostics`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      canSaveRightNow: { result: false, roleAllowsEditing: true, thisSessionHoldsTheLock: false, projectFrozenByOwner: false },
      session: { id: "s1", storedStatus: "active", effectiveStatus: "active" },
      myRecentSessions: [
        { id: "s0", isThisOne: false, status: "revoked", device: "Chrome on Windows", startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), endedAt: new Date().toISOString(), endedReason: "taken_over" },
        { id: "s1", isThisOne: true, status: "active", device: "Chrome on macOS", startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), endedAt: null, endedReason: null },
      ],
      access: { role: "editor", roleSource: "workspace", why: "You have this access because you are a member of this workspace." },
      lock: { status: "held", mine: false, heldByName: "Sarah Lee", holderSessionLive: true },
      persistence: { surveyId: SURVEY, serverRevision: 4, revisionGuardActive: true },
    }),
  }));

  await page.click(".leftnav >> text=Activity");
  await page.waitForSelector('[data-testid="diagnostics"]');

  const verdict = await page.$eval('[data-testid="diagnostics-verdict"]', (e) => ({
    text: e.textContent.trim(), canSave: e.getAttribute("data-can-save"),
  }));
  eq("it leads with the only question anybody asks", verdict.canSave, "0");
  ok("and names which of the three conditions failed", /edit lock/i.test(verdict.text), verdict.text);

  await page.click('[data-testid="diagnostics-toggle"]');
  const body = await page.textContent('[data-testid="diagnostics"]');
  ok("the takeover that ended an earlier session is visible", /taken_over/.test(body));
  ok("so is where the access came from", /workspace/i.test(body));
  ok("and the server revision, which is the stale-write condition", /Server Revision/i.test(body));
  ok("it says plainly that the work lives on the server, not in the browser",
    /stored on the server/i.test(body));

  await page.close();
}

await browser.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
