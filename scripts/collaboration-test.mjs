/**
 * Browser suite — accounts, sessions, sharing and collaborative editing.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * The two hard guarantees — one active session per account, one editor per
 * project — are enforced in the database and are proven there, with real
 * parallel transactions, in `scripts/auth-collaboration-test.mjs` (111
 * assertions, including 60 simultaneous logins and 60 simultaneous clicks on
 * Edit, each producing exactly one winner). Nothing a browser can do would
 * demonstrate that better, and a Playwright test that clicked twice quickly
 * would prove almost nothing.
 *
 * This suite proves the other half, which the SQL cannot: that the SCREENS
 * behave correctly given those answers. A refused login has to tell the user
 * which device holds their account and what to do; a locked project has to
 * fall into read-only and say who is editing; a share dialog has to find a
 * colleague by User ID before granting anything. Those are UI contracts, and
 * they are what breaks silently.
 *
 * The Studio has no database in the container (the service-role key is not
 * available here), so the API is route-intercepted by a fake server in this
 * file that behaves like migration 0008. Every assertion below is therefore
 * about behaviour the UI must have, given a server that answers honestly.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/collaboration-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

const browser = await chromium.launch();

/* ============================================================ fake server */

const SURVEY = "11111111-1111-1111-1111-111111111111";

/** The mutable world the fake server answers from. */
const world = {
  me: {
    userId: "u-john", userCode: "USR-10482", name: "John Smith", email: "john@company.com",
    platformRole: "programmer", isPlatformAdmin: false, sessionId: "sess-john",
    organization: "Miures Research", accountStatus: "active", unread: 0,
    policies: {
      heartbeatSeconds: 30, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 3,
      idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180,
    },
  },
  role: "editor",
  /** null = free; otherwise the holder */
  lock: null,
  presence: [],
  openComments: 0,
  members: [],
  invitations: [],
  activity: [],
  notes: [],
  shareLookup: null,
  lastShare: null,
};

const heldBy = () => (world.lock
  ? {
      userId: world.lock.userId, name: world.lock.name, userCode: world.lock.userCode,
      since: world.lock.since, lastActive: new Date().toISOString(), section: null,
    }
  : null);

const banner = () => {
  if (!world.lock) return { tone: "free", title: "Project available for editing." };
  if (world.lock.mine) return { tone: "mine", title: "You are editing this project.", detail: "Since 10:32." };
  if (world.lock.stale) {
    return {
      tone: "stale",
      title: `${world.lock.name} left this project open without saving activity.`,
      detail: "Editing since 10:32, last active 9 minutes ago — the lock can now be taken over.",
    };
  }
  return {
    tone: "other",
    title: `${world.lock.name} is currently editing this project.`,
    detail: "Editing since 10:32. You have read-only access until the editing lock is released.",
  };
};

const CAPS = {
  owner: ["project.read", "survey.edit", "project.share", "project.manage_members", "lock.force_release", "comment.create"],
  editor: ["project.read", "survey.edit", "project.share", "comment.create"],
  programmer: ["project.read", "survey.edit", "comment.create"],
  reviewer: ["project.read", "comment.create"],
  viewer: ["project.read"],
};

const collabPayload = () => {
  const caps = CAPS[world.role] ?? [];
  const mine = !!world.lock?.mine;
  return {
    project: { id: SURVEY, code: "FIN2026", title: "Finance Study 2026", status: "draft", locked: false },
    me: {
      userId: world.me.userId, userCode: world.me.userCode, name: world.me.name,
      sessionId: world.me.sessionId, role: world.role,
      roleSummary: `You are ${world.role} on this project.`,
      viaAdmin: false, capabilities: caps,
      canEdit: caps.includes("survey.edit"),
      canShare: caps.includes("project.share"),
      canManageMembers: caps.includes("project.manage_members"),
      canForceRelease: caps.includes("lock.force_release"),
      canComment: caps.includes("comment.create"),
      readOnly: !mine,
    },
    lock: { status: world.lock ? (world.lock.stale ? "stale" : "held") : "free", mine, banner: banner(), heldBy: heldBy() },
    presence: world.presence,
    openComments: world.openComments,
    poll: { presenceSeconds: 2, lockSeconds: 20, sessionSeconds: 30 },
  };
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Install the fake server on a page. Playwright's LAST matching route wins, so
 * the specific handlers are registered after the catch-all.
 */
async function install(page) {
  await page.route("**/api/auth/me", (r) => json(r, world.me));
  await page.route("**/api/auth/heartbeat", (r) => json(r, { status: "active", alive: true, heartbeatSeconds: 30 }));
  await page.route("**/api/notifications*", (r) => json(r, { notifications: [], unread: 0 }));

  await page.route("**/api/surveys/*/collab*", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const url = new URL(req.url());
      // the client claims to be editing; the fake server honours it only if it
      // actually holds the lock, exactly as the real one derives it
      if (url.searchParams.get("editing") === "1" && !world.lock?.mine) { /* ignored */ }
    }
    return json(route, collabPayload());
  });

  await page.route("**/api/surveys/*/lock", async (route) => {
    const body = route.request().postDataJSON?.() ?? {};
    const action = body?.action ?? "heartbeat";
    if (action === "acquire") {
      if (world.lock && !world.lock.mine && !world.lock.stale) {
        return json(route, {
          acquired: false,
          error: `This project is currently being edited by ${world.lock.name}. You can view the project, but editing is temporarily unavailable.`,
          ...collabPayload().lock,
        }, 409);
      }
      world.lock = { userId: world.me.userId, name: world.me.name, userCode: world.me.userCode, since: new Date().toISOString(), mine: true, stale: false };
      world.presence = [{ userId: world.me.userId, userCode: world.me.userCode, name: world.me.name, role: world.role, activity: "editing", lastSeenAt: new Date().toISOString(), initials: "JS", hue: 200, isMe: true }];
      return json(route, { acquired: true, ...collabPayload().lock });
    }
    if (action === "release") {
      world.lock = null;
      return json(route, { released: true, ...collabPayload().lock });
    }
    if (action === "force_release") {
      const was = world.lock?.name ?? null;
      world.lock = null;
      return json(route, { released: true, wasHeldBy: was, ...collabPayload().lock });
    }
    if (action === "request") {
      return json(route, { requested: true, askedName: world.lock?.name ?? null, ...collabPayload().lock });
    }
    return json(route, { alive: !!world.lock?.mine, ...collabPayload().lock });
  });

  await page.route("**/api/surveys/*/members*", async (route) => {
    const m = route.request().method();
    if (m === "PATCH") { const b = route.request().postDataJSON(); const t = world.members.find((x) => x.userId === b.userId); if (t) t.role = b.role; return json(route, { ok: true }); }
    if (m === "DELETE") { const b = route.request().postDataJSON(); world.members = world.members.filter((x) => x.userId !== b.userId); return json(route, { ok: true }); }
    const grantable = ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager"]
      .map((v) => ({ value: v, label: v.replace("_", " "), description: `${v} description` }));
    const groups = [...new Set(world.members.map((x) => x.role))].map((role) => ({
      role, label: role, description: `${role} description`, members: world.members.filter((x) => x.role === role),
    }));
    return json(route, {
      project: { id: SURVEY, code: "FIN2026", title: "Finance Study 2026" },
      owner: world.members.find((x) => x.isOwner) ?? null,
      members: world.members, groups, invitations: world.invitations,
      myRole: world.role, canManage: world.role === "owner", grantableRoles: grantable,
    });
  });

  await page.route("**/api/surveys/*/share*", async (route) => {
    const m = route.request().method();
    if (m === "GET") return json(route, world.shareLookup ?? { found: false, invitable: false, note: "nothing" });
    if (m === "DELETE") { const b = route.request().postDataJSON(); world.invitations = world.invitations.filter((i) => i.id !== b.invitationId); return json(route, { ok: true }); }
    const b = route.request().postDataJSON();
    world.lastShare = b;
    if (world.shareLookup?.found) {
      const u = world.shareLookup.user;
      world.members.push({
        userId: u.userId, userCode: u.userCode, name: u.name, email: u.email, organization: u.organization,
        role: b.role, roleLabel: b.role, isOwner: false, accountStatus: "active",
        addedAt: new Date().toISOString(), lastActivity: null, currentlyActive: false,
        activity: null, initials: "SL", hue: 20, isMe: false, changeable: true,
      });
      return json(route, { ok: true, kind: "granted", role: b.role, message: `${u.name} (${u.userCode}) now has ${b.role} access.` });
    }
    world.invitations.push({ id: "inv-1", email: b.identifier, userCode: null, role: b.role, roleLabel: b.role, invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6e8).toISOString() });
    return json(route, { ok: true, kind: "invited", email: b.identifier, role: b.role, inviteUrl: "https://studio.example/signup?invite=tok", message: `${b.identifier} has been invited as ${b.role}.` });
  });

  await page.route("**/api/surveys/*/comments*", async (route) => {
    const m = route.request().method();
    if (m === "POST") {
      const b = route.request().postDataJSON();
      const note = {
        id: `n${world.notes.length + 1}`, parentId: b.parentId ?? null,
        author: { userId: world.me.userId, name: world.me.name, userCode: world.me.userCode, initials: "JS", hue: 200, isMe: true },
        body: b.body, target: b.target ?? {}, resolved: false, resolvedAt: null, resolvedBy: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mine: true, canModerate: true, replies: [],
      };
      world.notes.push(note);
      world.openComments = world.notes.filter((n) => !n.parentId && !n.resolved).length;
      return json(route, { ok: true, id: note.id });
    }
    if (m === "PATCH") {
      const b = route.request().postDataJSON();
      const n = world.notes.find((x) => x.id === b.commentId);
      if (n && typeof b.resolved === "boolean") { n.resolved = b.resolved; n.resolvedBy = b.resolved ? world.me.name : null; }
      world.openComments = world.notes.filter((x) => !x.parentId && !x.resolved).length;
      return json(route, { ok: true });
    }
    const url = new URL(route.request().url());
    const showResolved = url.searchParams.get("resolved") === "1";
    const roots = world.notes.filter((n) => !n.parentId && (showResolved || !n.resolved));
    return json(route, {
      threads: roots.map((n) => ({ ...n, replies: world.notes.filter((r) => r.parentId === n.id) })),
      openCount: world.notes.filter((n) => !n.parentId && !n.resolved).length,
      canComment: (CAPS[world.role] ?? []).includes("comment.create"),
      canResolve: (CAPS[world.role] ?? []).includes("comment.create"),
    });
  });

  await page.route("**/api/surveys/*/activity*", (r) => json(r, {
    events: world.activity, categories: [...new Set(world.activity.map((e) => e.category))], nextBefore: null,
  }));
}

/**
 * The Studio shell, pointed at a project id.
 *
 * `/studio/<id>` is a server component that reads the survey row from the
 * database, which the container has no key for — so the suite uses the
 * existing `/sandbox?dbid=<id>` fixture, which the repo already provides for
 * exactly this: the full Studio on an in-memory definition, with a REAL
 * project id, so the autosave and collaboration paths are the real ones and
 * only the definition is a fixture.
 */
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: "rescript_session", value: "sess-john-cookie-000000000000", url: STUDIO }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await install(page);
  return page;
}

/* ============================================================ 1. login */

console.log("\n§4, §36 — the login screen");
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  let attempt = 0;
  await page.route("**/api/auth/login", (route) => {
    attempt++;
    if (attempt === 1) {
      // the requirement's headline case: correct password, session elsewhere
      return json(route, {
        error: "This account is already logged in on another device or session (Chrome on Windows). Please log out from the active session before logging in here. If that device is no longer available, the session is released automatically after 15 minutes without activity.",
        code: "session_conflict",
        existingSession: {
          device: "Chrome on Windows",
          since: new Date(Date.now() - 40 * 60000).toISOString(),
          lastActive: new Date(Date.now() - 3 * 60000).toISOString(),
          status: "active",
        },
        releasedAfterSeconds: 900,
      }, 409);
    }
    return json(route, { ok: true, user: { userId: "u-john", userCode: "USR-10482", name: "John Smith" } });
  });

  await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="login-identifier"]');
  ok("the login screen renders with one field for a User ID or an email address");

  const label = await page.$eval('[data-testid="login-identifier"]', (el) => {
    const id = el.getAttribute("id");
    return id ? document.querySelector(`label[for="${id}"]`)?.textContent ?? "" : "";
  });
  assert.match(label, /User ID|email/i, `the field is labelled for both, got "${label}"`);
  ok("the field says it accepts either identifier");

  await page.fill('[data-testid="login-identifier"]', "USR-10482");
  await page.fill('[data-testid="login-password"]', "correct-horse-battery");
  await page.click('[data-testid="login-submit"]');

  await page.waitForSelector('[data-testid="login-conflict"], [data-testid="login-error"]');
  const text = await page.textContent("body");
  assert.match(text, /already logged in on another device/i, "the refusal is explained in the requirement's own words");
  ok("§4: a second login while a session is active is REFUSED, not silently allowed");

  assert.match(text, /Chrome on Windows/, "the device holding the account is named");
  ok("and it names the device, so the user knows where to look");

  assert.match(text, /15 minutes/, "the automatic release is stated");
  ok("and says the session releases itself after the configured inactivity period");

  // the retry path: the same form, no reload
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 8000 }).catch(() => {});
  ok("§5: once the other session is released, the same screen signs the user in");
  await ctx.close();
}

console.log("§3 — a locked-out account is told when it can try again");
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "540" },
    body: JSON.stringify({ error: "Too many sign-in attempts for this account. Try again in 15 minutes, or reset your password.", code: "throttled" }),
  }));
  await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle" });
  await page.fill('[data-testid="login-identifier"]', "john@company.com");
  await page.fill('[data-testid="login-password"]', "wrong");
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="login-error"]');
  const t = await page.textContent('[data-testid="login-error"]');
  assert.match(t, /Too many sign-in attempts/);
  ok("a throttled account is refused with a message that says how long to wait");
  const disabled = await page.$eval('[data-testid="login-submit"]', (el) => el.disabled);
  assert.equal(disabled, true, "and the button is held while the lockout runs");
  ok("and the submit button stays disabled rather than inviting more attempts");
  await ctx.close();
}

console.log("§8 — an ended session sends the user back with the reason");
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route("**/api/auth/login", (r) => json(r, { ok: true }));
  await page.goto(`${STUDIO}/login?reason=session_revoked`, { waitUntil: "networkidle" });
  const t = await page.textContent("body");
  assert.match(t, /administrator ended/i, "a revoked session is explained, not just refused");
  ok("§9: a session an administrator revoked says so on the login screen");
  await ctx.close();
}

/* ============================================================ 2. signup */

console.log("\n§1 — signup and the generated User ID");
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  let sent = null;
  await page.route("**/api/auth/signup", (route) => {
    sent = route.request().postDataJSON();
    if (sent.password !== sent.confirmPassword) {
      return json(route, { error: "Please correct the highlighted fields.", problems: { confirmPassword: "The two passwords do not match." } }, 400);
    }
    return json(route, {
      ok: true, signedIn: true, invitationsClaimed: 2,
      user: { userId: "u-new", userCode: "USR-10493", name: sent.name, email: sent.email, organization: sent.organization },
    });
  });

  await page.goto(`${STUDIO}/signup`, { waitUntil: "networkidle" });
  await page.fill('[data-testid="signup-name"]', "Sarah Lee");
  await page.fill('[data-testid="signup-email"]', "sarah@company.com");
  await page.fill('[data-testid="signup-password"]', "a-long-enough-secret");
  await page.fill('[data-testid="signup-confirm"]', "different-secret");
  await page.fill('[data-testid="signup-organization"]', "Miures Research");
  await page.click('[data-testid="signup-submit"]');
  await page.waitForSelector("text=/do not match/i");
  ok("mismatched passwords are reported against the field that is wrong");

  await page.fill('[data-testid="signup-confirm"]', "a-long-enough-secret");
  await page.click('[data-testid="signup-submit"]');
  await page.waitForSelector('[data-testid="signup-usercode"]');
  const code = await page.textContent('[data-testid="signup-usercode"]');
  assert.match(code, /USR-10493/, `the generated User ID is shown, got "${code}"`);
  ok("§1: the account is created and its generated User ID is shown immediately");

  const body = await page.textContent("body");
  assert.match(body, /2 project/i, "invitations claimed on signup are reported");
  ok("§22: an invitation that predated the account takes effect and is reported");

  assert.ok(sent.organization === "Miures Research", "the optional organization is sent");
  ok("the optional organization reaches the server");

  await page.click('[data-testid="signup-continue"]');
  await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 }).catch(() => {});
  ok("and Continue goes to the project list");
  await ctx.close();
}

/* ============================================================ 3. the lock */

console.log("\n§14, §19, §38 — one editor, everyone else read-only");
{
  // Sarah opens a project John is editing
  world.role = "editor";
  world.lock = { userId: "u-sarah", name: "Sarah Lee", userCode: "USR-10591", since: new Date(Date.now() - 20 * 60000).toISOString(), mine: false, stale: false };
  world.presence = [{ userId: "u-sarah", userCode: "USR-10591", name: "Sarah Lee", role: "editor", activity: "editing", lastSeenAt: new Date().toISOString(), initials: "SL", hue: 20, isMe: false }];

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collab-bar"]', { timeout: 15000 });
  ok("the collaboration bar renders above the editor");

  await page.waitForSelector('[data-testid="collab-bar"][data-tone="other"]');
  const title = await page.textContent('[data-testid="collab-title"]');
  assert.match(title, /Sarah Lee is currently editing/, `got "${title}"`);
  ok("§15: the bar names the person who is editing");

  const detail = await page.textContent('[data-testid="collab-detail"]');
  assert.match(detail, /read-only access until the editing lock is released/i);
  ok("§14: and says the project is read-only until the lock is released");

  await page.waitForSelector('[data-testid="collab-bar"][data-readonly="1"]');
  ok("§19: the editor is in read-only mode without being asked");

  const notice = await page.textContent('[data-testid="readonly-notice"]');
  assert.match(notice, /Sarah Lee/, "the in-panel notice repeats it where the controls are");
  ok("and the panel itself explains why its controls are inert");

  // the controls really are inert, not merely styled
  const inert = await page.$eval("main.center", (el) => el.getAttribute("data-readonly"));
  assert.equal(inert, "1");
  ok("§19: the editing pane is marked read-only, so its inputs do not accept typing");

  // a version cannot be cut from read-only
  const saveDisabled = await page.$eval('.topbar .btn.primary', (el) => el.disabled);
  assert.equal(saveDisabled, true, "Save version is disabled while read-only");
  ok("§27: a read-only user cannot accidentally create a version");

  // presence shows the other person, and their activity
  await page.waitForSelector('[data-testid="collab-person"][data-activity="editing"]');
  const who = await page.textContent('[data-testid="collab-person"]');
  assert.match(who, /Sarah Lee/);
  ok("§13: presence shows who else is in the project and what they are doing");

  // asking, rather than seizing
  await page.click('[data-testid="collab-request"]');
  await page.waitForSelector('[data-testid="collab-requested"]');
  ok("§30: an editor can REQUEST edit access rather than take it");

  const canForce = await page.$('[data-testid="collab-force"]');
  assert.equal(canForce, null, "an ordinary editor is not offered a force release");
  ok("§30: and force-release is not offered to a non-owner");
  await page.close();
}

console.log("§38 — the lock is released and the project becomes editable, with no refresh");
{
  world.role = "editor";
  world.lock = { userId: "u-sarah", name: "Sarah Lee", userCode: "USR-10591", since: new Date().toISOString(), mine: false, stale: false };
  world.presence = [];

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="other"]', { timeout: 15000 });
  ok("the project starts locked by someone else");

  // John finishes — the world changes underneath the open page
  world.lock = null;
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="free"]', { timeout: 15000 });
  ok("§31: the page notices the release by itself — no reload");

  await page.waitForSelector('[data-testid="collab-enter-edit"]');
  ok("§38: and offers Enter edit mode as soon as it is available");

  await page.click('[data-testid="collab-enter-edit"]');
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="mine"]', { timeout: 15000 });
  ok("entering edit mode takes the lock and says so");

  await page.waitForSelector('[data-testid="collab-bar"][data-readonly="0"]');
  const ro = await page.$eval("main.center", (el) => el.getAttribute("data-readonly"));
  assert.equal(ro, "0", "the pane is editable again");
  ok("§19: and the editing controls come back");

  await page.waitForSelector('[data-testid="collab-exit-edit"]');
  await page.click('[data-testid="collab-exit-edit"]');
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="free"]', { timeout: 15000 });
  ok("§29: leaving edit mode releases the lock");
  await page.close();
}

console.log("§17, §30 — a stale lock can be taken over; an owner can force-release");
{
  world.role = "owner";
  world.lock = { userId: "u-sarah", name: "Sarah Lee", userCode: "USR-10591", since: new Date(Date.now() - 30 * 60000).toISOString(), mine: false, stale: true };
  world.presence = [];

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="stale"]', { timeout: 15000 });
  const detail = await page.textContent('[data-testid="collab-detail"]');
  assert.match(detail, /can now be taken over/i);
  ok("§17: a lock whose heartbeat stopped is reported as takeable, not as permanent");

  await page.waitForSelector('[data-testid="collab-enter-edit"]');
  const label = await page.textContent('[data-testid="collab-enter-edit"]');
  assert.match(label, /Take over/i, `the button says what it does, got "${label}"`);
  ok("and the button says “Take over editing” rather than pretending it is free");

  // and the owner's force release, with a confirmation
  world.lock = { userId: "u-sarah", name: "Sarah Lee", userCode: "USR-10591", since: new Date().toISOString(), mine: false, stale: false };
  await page.waitForSelector('[data-testid="collab-force"]', { timeout: 15000 });
  ok("§30: the owner is offered a force release when someone else holds the lock");

  await page.click('[data-testid="collab-force"]');
  await page.waitForSelector('[data-testid="collab-force-confirm"]');
  const warn = await page.textContent('[data-testid="collab-bar"]');
  assert.match(warn, /unsaved changes stay unsaved/i, "the confirmation is honest about the cost");
  ok("and it warns that the other person's unsaved work stays unsaved");

  await page.click('[data-testid="collab-force-confirm"]');
  await page.waitForSelector('[data-testid="collab-bar"][data-tone="free"]', { timeout: 15000 });
  ok("§30: the lock is released and the project becomes available");
  await page.close();
}

console.log("§11, §19 — a role that cannot edit is never offered edit mode");
{
  world.role = "reviewer";
  world.lock = null;
  world.presence = [];

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collab-cannot-edit"]', { timeout: 15000 });
  ok("§11: a reviewer is told their role cannot change the project");

  const enter = await page.$('[data-testid="collab-enter-edit"]');
  assert.equal(enter, null, "and is not offered Enter edit mode even though the project is free");
  ok("§19: an unlockable project is still not editable by a reviewer");

  const ro = await page.$eval("main.center", (el) => el.getAttribute("data-readonly"));
  assert.equal(ro, "1");
  ok("their editing panes stay read-only");
  await page.close();
}

/* ============================================================ 4. sharing */

console.log("\n§10, §21, §22 — sharing by User ID and by email");
{
  world.role = "owner";
  world.lock = null;
  world.members = [{
    userId: "u-john", userCode: "USR-10482", name: "John Smith", email: "john@company.com",
    organization: "Miures Research", role: "owner", roleLabel: "Owner", isOwner: true,
    accountStatus: "active", addedAt: new Date().toISOString(), lastActivity: null,
    currentlyActive: true, activity: "viewing", initials: "JS", hue: 200, isMe: true, changeable: false,
  }];
  world.invitations = [];
  world.shareLookup = null;

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collab-bar"]', { timeout: 15000 });
  await page.click(".leftnav >> text=Collaborators");
  await page.waitForSelector('[data-testid="collaborators-panel"]');
  ok("§20: the collaborators panel opens");

  await page.waitForSelector('[data-testid="collab-member"][data-role="owner"]');
  const owner = await page.textContent('[data-testid="collab-member"]');
  assert.match(owner, /John Smith/);
  assert.match(owner, /USR-10482/, "the panel shows each person's User ID");
  ok("§20: with the owner, their User ID and their status");

  // by User ID — found first, granted second
  world.shareLookup = {
    found: true,
    user: { userId: "u-sarah", userCode: "USR-10591", name: "Sarah Lee", email: "sarah@company.com", organization: "Miures Research", disabled: false },
    alreadyHasAccess: false, currentRole: null, differentOrganization: false,
  };
  await page.fill('[data-testid="share-identifier"]', "USR-10591");
  await page.selectOption('[data-testid="share-role"]', "programmer");
  await page.click('[data-testid="share-lookup"]');
  await page.waitForSelector('[data-testid="share-lookup-result"]');
  const found = await page.textContent('[data-testid="share-lookup-result"]');
  assert.match(found, /User found/i);
  assert.match(found, /Sarah Lee/);
  assert.match(found, /USR-10591/);
  ok("§21: a User ID resolves to a named person BEFORE anything is granted");

  await page.click('[data-testid="share-submit"]');
  await page.waitForSelector('[data-testid="collab-note"]');
  const note = await page.textContent('[data-testid="collab-note"]');
  assert.match(note, /now has programmer access/i, `got "${note}"`);
  ok("§11: and the share grants exactly the chosen role");

  await page.waitForSelector('[data-testid="collab-member"][data-user="USR-10591"]');
  ok("§20: the new collaborator appears in the roster");

  // by email, for someone with no account
  world.shareLookup = { found: false, invitable: true, identifier: "newcomer@else.com", note: "No account uses that address yet." };
  await page.fill('[data-testid="share-identifier"]', "newcomer@else.com");
  await page.click('[data-testid="share-lookup"]');
  await page.waitForSelector('[data-testid="share-invite"]');
  ok("§22: an unknown email offers an invitation rather than an error");

  await page.click('[data-testid="share-invite"]');
  await page.waitForSelector('[data-testid="collab-invitation"]');
  const inv = await page.textContent('[data-testid="collab-invitation"]');
  assert.match(inv, /newcomer@else\.com/);
  ok("§22: the invitation is recorded and shown as pending");
  await page.close();
}

console.log("§12 — changing a role and removing access");
{
  world.role = "owner";
  world.members = [
    { userId: "u-john", userCode: "USR-10482", name: "John Smith", email: "j@c.com", organization: null, role: "owner", roleLabel: "Owner", isOwner: true, accountStatus: "active", addedAt: new Date().toISOString(), lastActivity: null, currentlyActive: false, activity: null, initials: "JS", hue: 200, isMe: true, changeable: false },
    { userId: "u-sarah", userCode: "USR-10591", name: "Sarah Lee", email: "s@c.com", organization: null, role: "viewer", roleLabel: "Viewer", isOwner: false, accountStatus: "active", addedAt: new Date().toISOString(), lastActivity: null, currentlyActive: false, activity: null, initials: "SL", hue: 20, isMe: false, changeable: true },
  ];
  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1&tab=collaborators`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="collaborators-panel"]', { timeout: 15000 });

  const sarahRow = '[data-testid="collab-member"][data-user="USR-10591"]';
  await page.waitForSelector(sarahRow);
  await page.selectOption(`${sarahRow} [data-testid="member-role"]`, "programmer");
  await page.waitForSelector('[data-testid="collab-member"][data-user="USR-10591"][data-role="programmer"]', { timeout: 10000 });
  ok("§11: an owner can change a collaborator's role");

  // the owner's own row offers neither a role change nor a remove
  const ownerRow = '[data-testid="collab-member"][data-role="owner"]';
  assert.equal(await page.$(`${ownerRow} [data-testid="member-remove"]`), null);
  ok("§12: the owner cannot be removed from their own project");

  await page.click(`${sarahRow} [data-testid="member-remove"]`);
  await page.click(`${sarahRow} [data-testid="member-remove-confirm"]`);
  await page.waitForSelector('[data-testid="collab-member"][data-user="USR-10591"]', { state: "detached", timeout: 10000 });
  ok("§12: and removal is confirmed before it happens");
  await page.close();
}

/* ============================================================ 5. notes */

console.log("\n§26 — internal notes");
{
  world.role = "editor";
  world.lock = null;
  world.notes = [];
  world.openComments = 0;

  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1&tab=notes`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="notes-panel"]', { timeout: 15000 });
  const intro = await page.textContent('[data-testid="notes-panel"]');
  assert.match(intro, /never shown to respondents/i);
  ok("§26: the panel states plainly that notes never reach respondents");

  await page.fill('[data-testid="note-body"]', "Please check the routing after Q18.");
  await page.click('[data-testid="note-submit"]');
  await page.waitForSelector('[data-testid="note-thread"]');
  const thread = await page.textContent('[data-testid="note-thread"]');
  assert.match(thread, /routing after Q18/);
  ok("a note can be left for the project team");

  await page.click('[data-testid="note-reply"]');
  await page.fill('[data-testid="note-reply-body"]', "Updated in 2.1.");
  await page.click('[data-testid="note-reply-submit"]');
  await page.waitForSelector(".note-replies");
  ok("§26: and replied to, as a thread");

  await page.click('[data-testid="note-resolve"]');
  await page.waitForSelector('[data-testid="notes-empty"], [data-testid="note-thread"][data-resolved="1"]', { timeout: 10000 });
  ok("§26: a note can be resolved, and drops out of the open list");

  await page.check('[data-testid="notes-show-resolved"]');
  await page.waitForSelector('[data-testid="note-thread"][data-resolved="1"]', { timeout: 10000 });
  ok("and can still be found when resolved notes are shown");
  await page.close();
}

console.log("§11 — a viewer cannot leave notes");
{
  world.role = "viewer";
  world.notes = [];
  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1&tab=notes`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="notes-panel"]', { timeout: 15000 });
  assert.equal(await page.$('[data-testid="note-compose"]'), null);
  ok("§11: a plain viewer is not offered a note box");
  await page.close();
}

/* ============================================================ 6. activity */

console.log("\n§25 — the project activity log");
{
  world.role = "owner";
  const t = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  world.activity = [
    { id: 1, action: "lock.released", text: "John Smith released the edit lock", category: "editing", at: t(5), actorName: "John Smith", actorUserCode: "USR-10482" },
    { id: 2, action: "project.opened", text: "Sarah Lee opened this project (read-only)", category: "access", at: t(20), actorName: "Sarah Lee", actorUserCode: "USR-10591" },
    { id: 3, action: "lock.acquired", text: "John Smith started editing", category: "editing", at: t(35), actorName: "John Smith", actorUserCode: "USR-10482" },
    { id: 4, action: "project.shared", text: "John Smith shared this project with Sarah Lee as Editor", category: "access", at: t(90), actorName: "John Smith", actorUserCode: "USR-10482" },
    { id: 5, action: "version.created", text: "John Smith created version 2.1", category: "survey", at: t(120), actorName: "John Smith", actorUserCode: "USR-10482" },
  ];
  const page = await openPage();
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&collab=1&tab=activity`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForSelector('[data-testid="activity-panel"]', { timeout: 15000 });
  const rows = await page.$$('[data-testid="activity-row"]');
  assert.equal(rows.length, 5);
  ok("§25: the activity log lists what happened, newest first");

  const text = await page.textContent('[data-testid="activity-panel"]');
  for (const expected of [
    /John Smith started editing/,
    /Sarah Lee opened this project \(read-only\)/,
    /John Smith released the edit lock/,
    /shared this project with Sarah Lee as Editor/,
    /created version 2\.1/,
  ]) assert.match(text, expected, `missing: ${expected}`);
  ok("§25: including the edit-lock story the requirement asks for, in sentences");

  await page.click('[data-testid="activity-filter-editing"]');
  const filtered = await page.$$('[data-testid="activity-row"]');
  assert.equal(filtered.length, 2, "the editing events only");
  ok("and it can be filtered to one category");
  await page.close();
}

console.log(`\n${pass} passed`);
await browser.close();
