/**
 * COLLABORATORS & ADVANCED ACCESS — the browser half (2026-10-17,
 * docs/COLLABORATORS-ACCESS-2026-10-17.md).
 *
 * WHAT THIS PROVES: that the screens behave — the Research Workspace card's
 * ⋯ → Collaborators… and the Project Overview's avatar button open the SAME
 * panel; inviting with a preset; the per-module cards, the permission search
 * and the before-you-save preview; expiry chosen and shown; a pending
 * invitation resent and cancelled; the history; copying another person's
 * access; a grant the signed-in person does not hold is not offered; the
 * Overview hides what the caller's capabilities do not include.
 *
 * WHAT IT DOES NOT PROVE, AND WHERE THAT IS PROVEN: enforcement. The Studio
 * has no database in the container, so the API is route-intercepted by a fake
 * server in this file (as `collaboration-test.mjs` does) that answers in the
 * shapes the real routes return, using the real `@rescript/access` build for
 * every label, expiry sentence and normalisation. That a Data: None member
 * gets 403 from the data and export routes, that View-only programming cannot
 * save, that expired access is refused, and that nobody grants what they do
 * not hold is proven by `apps/studio/lib/projectAccess.test.ts` (the guard's
 * decision), `packages/access/src/collaborators.test.ts` (the model) and
 * `scripts/collaborators-access-sql-test.sql` (the database).
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/collaborators-access-test.mjs
 *   (needs `pnpm --filter @rescript/access build` first — it imports the built package)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import {
  accessLabel, describeExpiry, isExpired, normalizePermissions, resolveExpiry,
} from "../packages/access/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const S1 = "11111111-1111-4111-8111-111111111111";
const SURVEYS = [
  { id: S1, code: "ACME-01", title: "Acme brand tracker", status: "live", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-10-09T10:00:00Z", current_version_id: null, created_by: "u1", myRole: "owner", roleSource: "owner", owner: { userId: "u1", name: "Test Researcher", userCode: "USR-10000", isMe: true }, collaborators: 5, version: "3.0", editing: null },
];
const STATS = { [S1]: { questionCount: 24, responseCount: 310, testResponseCount: 12, liveResponseCount: 298, completeCount: 240, lastResponseAt: "2026-10-09T09:00:00Z", contributorIds: ["u1"], versionCount: 3 } };
const OVERVIEW = (extra = {}) => ({
  ok: true,
  project: { id: "sandbox", code: "ACME-01", title: "Acme brand tracker", status: "live", version: "3.0", revision: 41, draftSavedAt: null, updatedAt: "2026-10-09T10:00:00Z", createdAt: "2026-09-01T10:00:00Z", locked: false, role: "owner", accessLabel: "Owner", clientName: null, projectManager: null, fieldworkFrom: null, fieldworkTo: null, dueDate: null, languages: 0, sourceLanguage: "en", ...extra },
  counts: { questions: 24, pages: 9, responses: 310, live: 298, test: 12, complete: 240, lastResponseAt: null },
  modules: [], summary: { configured: 0, total: 0, attention: [] }, spend: null, activity: [], warnings: [],
});

/* ============================================================ the fake server's world */

const world = {
  myRole: "owner",
  myAccess: { role: "owner", permissions: null, expiresAt: null },
  members: [],
  invitations: [],
  lookup: null,
  lastShare: null,
  lastPatch: null,
  lastResend: null,
  history: [],
};

function reset() {
  world.myRole = "owner";
  world.myAccess = { role: "owner", permissions: null, expiresAt: null };
  world.members = [
    { userId: "u1", userCode: "USR-10000", name: "Test Researcher", email: "t@example.com", role: "owner", isOwner: true, isMe: true },
    { userId: "u2", userCode: "USR-10591", name: "Sarah Lee", email: "sarah@example.com", role: "editor" },
    { userId: "u3", userCode: "USR-10592", name: "Ana Ruiz", email: "ana@example.com", role: "custom", permissions: { v: 1, modules: { data: "view", analytics: "view" } }, expiresAt: iso(NOW + 3 * DAY - 60_000) },
    { userId: "u4", userCode: "USR-10593", name: "Ben Ode", email: "ben@example.com", role: "viewer", expiresAt: iso(NOW - 2 * DAY - 60_000) },
    { userId: "u5", userCode: "USR-10594", name: "Cy Park", email: "cy@example.com", role: "programmer" },
    { userId: "u6", userCode: "USR-10595", name: "Dee Kim", email: "dee@example.com", role: "vendor" },
  ];
  world.invitations = [
    { id: "inv-1", email: "pending@client.com", userCode: null, role: "viewer", invitedAt: iso(NOW - DAY), expiresAt: iso(NOW + 13 * DAY), accessExpiresAt: null, resendCount: 0 },
  ];
  world.lookup = null;
  world.lastShare = world.lastPatch = world.lastResend = null;
  world.history = [
    { id: "h3", action: "project.access_expired", text: "Ben Ode's access expired on " + iso(NOW - 2 * DAY).slice(0, 10), at: iso(NOW - 2 * DAY), actorName: null, changes: [] },
    { id: "h2", action: "project.permission_changed", text: "Test Researcher changed Ana Ruiz's access — Data: Manage → View", at: iso(NOW - 5 * DAY), actorName: "Test Researcher", changes: ["Data: Manage → View"] },
    { id: "h1", action: "project.shared", text: "Test Researcher shared this project with Ana Ruiz as Custom, until " + iso(NOW + 3 * DAY).slice(0, 10), at: iso(NOW - 9 * DAY), actorName: "Test Researcher", changes: [] },
  ];
}

const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** the members GET payload, in the real route's shape */
function membersPayload(withActivity) {
  const grantable = ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager", "project_admin", "viewer_data", "vendor", "interviewer", "custom"];
  const members = world.members.map((m) => {
    const grant = { role: m.role, permissions: m.permissions ?? null, expiresAt: m.isOwner ? null : m.expiresAt ?? null };
    const expired = isExpired(grant, Date.now());
    return {
      userId: m.userId, userCode: m.userCode, name: m.name, email: m.email, organization: null,
      role: m.role, roleLabel: m.role, isOwner: !!m.isOwner, accountStatus: "active",
      accessLabel: accessLabel(m.role), permissions: m.role === "custom" ? normalizePermissions(m.permissions) : null,
      expiresAt: grant.expiresAt, expired, expiryText: grant.expiresAt ? describeExpiry(grant.expiresAt) : null,
      status: m.isOwner ? "owner" : expired ? "expired" : "active",
      addedAt: iso(NOW - 10 * DAY), lastActivity: null, currentlyActive: false, activity: null,
      initials: initials(m.name), hue: hue(m.userId), isMe: !!m.isMe,
      changeable: !m.isOwner && !m.isMe && (world.myRole === "owner" || world.myRole === "project_admin"),
    };
  });
  return {
    project: { id: S1, code: "ACME-01", title: "Acme brand tracker" },
    owner: members.find((m) => m.isOwner) ?? null,
    members,
    invitations: world.invitations.map((i) => ({ ...i, roleLabel: i.role, accessLabel: accessLabel(i.role), linkExpired: false })),
    myRole: world.myRole,
    myAccess: world.myAccess,
    canManage: world.myRole === "owner" || world.myRole === "project_admin",
    canShare: ["owner", "project_admin", "editor"].includes(world.myRole),
    isPlatformAdmin: false,
    grantableRoles: grantable.map((r) => ({ value: r, label: r, accessLabel: accessLabel(r), description: `${accessLabel(r)} description` })),
    ...(withActivity ? { activity: world.history } : {}),
  };
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function install(page, overview = OVERVIEW()) {
  await page.route("**/api/auth/me", (r) => json(r, { userId: "u1", userCode: "USR-10000", name: "Test Researcher", email: "t@example.com", platformRole: "programmer", isPlatformAdmin: false, sessionId: "sess", unread: 0, policies: { heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15, idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180 } }));
  await page.route("**/api/auth/heartbeat", (r) => json(r, { status: "active", alive: true }));
  await page.route("**/api/notifications*", (r) => json(r, { notifications: [], unread: 0 }));
  await page.route("**/api/surveys", (r) => (r.request().method() === "GET" ? json(r, { surveys: SURVEYS, stats: STATS, contributors: { u1: { id: "u1", name: "Test Researcher", initials: "TR" } }, warnings: [] }) : r.continue()));
  const WALLET = { walletId: "w1", currency: "USD", balance: 125.5, reserved: 0, available: 125.5, totalAdded: 500, totalUsed: 374.5, transferredOut: 0, transferredIn: 0, level: "normal", state: "active" };
  await page.route("**/api/billing/**", (r) => json(r, { ok: true, currency: "USD", projects: [], wallet: WALLET, thresholds: { low: 20, critical: 5, readOnly: 0 }, isPlatformAdmin: false }));
  await page.route("**/api/surveys/sandbox/overview", (r) => json(r, overview));

  await page.route("**/api/surveys/*/members*", async (route) => {
    const req = route.request();
    const m = req.method();
    if (m === "PATCH") {
      const b = req.postDataJSON();
      world.lastPatch = b;
      const t = world.members.find((x) => x.userId === b.userId);
      if (t) {
        if (b.role) t.role = b.role;
        if (b.role === "custom") t.permissions = b.permissions ?? t.permissions;
        if (b.expiry) { const e = resolveExpiry(b.expiry.option, b.expiry.date); if (e.ok) t.expiresAt = e.expiresAt; }
      }
      world.history.unshift({ id: `h${world.history.length + 1}`, action: "project.permission_changed", text: `Test Researcher changed ${t?.name}'s access`, at: iso(Date.now()), actorName: "Test Researcher", changes: [] });
      return json(route, { ok: true, role: b.role, changes: ["changed"] });
    }
    if (m === "DELETE") {
      const b = req.postDataJSON();
      world.members = world.members.filter((x) => x.userId !== b.userId);
      return json(route, { ok: true });
    }
    const url = new URL(req.url());
    return json(route, membersPayload(url.searchParams.get("include") === "activity"));
  });

  await page.route("**/api/surveys/*/share*", async (route) => {
    const req = route.request();
    const m = req.method();
    if (m === "GET") return json(route, world.lookup ?? { found: false, invitable: false, note: "nothing" });
    if (m === "DELETE") {
      const b = req.postDataJSON();
      world.invitations = world.invitations.filter((i) => i.id !== b.invitationId);
      return json(route, { ok: true });
    }
    if (m === "PATCH") {
      const b = req.postDataJSON();
      world.lastResend = b;
      const inv = world.invitations.find((i) => i.id === b.invitationId);
      if (inv) inv.resendCount = (inv.resendCount ?? 0) + 1;
      return json(route, { ok: true, delivery: "sent", resendCount: inv?.resendCount, message: `The invitation was sent again to ${inv?.email}. The previous link no longer works.` });
    }
    const b = req.postDataJSON();
    world.lastShare = b;
    const e = b.expiry ? resolveExpiry(b.expiry.option, b.expiry.date) : { ok: true, expiresAt: null };
    world.invitations.push({ id: `inv-${world.invitations.length + 2}`, email: b.identifier, userCode: null, role: b.role, permissions: b.permissions ?? null, invitedAt: iso(Date.now()), expiresAt: iso(Date.now() + 14 * DAY), accessExpiresAt: e.ok ? e.expiresAt : null, resendCount: 0 });
    return json(route, { ok: true, kind: "invited", email: b.identifier, role: b.role, inviteUrl: "https://studio.example/signup?invite=tok", delivery: "sent", message: `${b.identifier} has been invited as ${accessLabel(b.role)}, and the invitation has been emailed to them.` });
  });
}

const browser = await chromium.launch();
async function newPage(width = 1440, overview) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addCookies([{ name: "rescript_session", value: "collaborators-access-test-0000", url: STUDIO }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await install(page, overview);
  return { page, errors, close: () => ctx.close() };
}
const text = (page, sel) => page.textContent(sel);
const panelSignature = (page) => page.$$eval('[data-testid="collaborators-panel"] [data-testid="collab-member"]', (es) => es.map((e) => `${e.getAttribute("data-user")}:${e.getAttribute("data-role")}:${e.getAttribute("data-status")}`));

/* ============================================================ 1. two doors, one panel */

console.log("\nTwo entry points, one collaborators panel");
let fromWorkspace;
{
  reset();
  const { page, errors, close } = await newPage();
  await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".survey-card");
  await page.click('.survey-card button[aria-haspopup="menu"]');
  await page.waitForSelector('[data-testid="collaborators-menu-item"]');
  const items = await page.$$eval('.survey-card .menu [class*="menu-item"]', (es) => es.map((e) => e.textContent.trim()));
  assert.equal(items[0], "Collaborators…", `first PROJECT item: ${items.join(" | ")}`);
  assert.ok(items.some((t) => /Clone project/.test(t)) && items.some((t) => /Delete survey/.test(t)), "the existing items are still there");
  ok("Workspace: the card's ⋯ menu has “Collaborators…” beside Clone, status and Delete");

  await page.click('[data-testid="collaborators-menu-item"]');
  await page.waitForSelector('[data-testid="collaborators-dialog"] [data-testid="collaborators-panel"]');
  assert.equal(await page.getAttribute('[role="dialog"]', "aria-modal"), "true");
  assert.match(await text(page, "#cx-dialog-title"), /Collaborators — Acme brand tracker/);
  fromWorkspace = await panelSignature(page);
  assert.equal(fromWorkspace.length, 6);
  /* the owner is locked: no access select, no menu, no remove */
  const ownerRow = '[data-testid="collab-member"][data-role="owner"]';
  assert.match(await text(page, `${ownerRow} [data-testid="member-access"]`), /Owner/);
  for (const t of ["member-role", "member-menu", "member-remove"]) assert.equal(await page.$(`${ownerRow} [data-testid="${t}"]`), null, `owner row has no ${t}`);
  ok("Workspace: it opens the collaborators panel in a dialog; the owner is shown locked");

  /* status and expiry on each person */
  assert.match(await text(page, '[data-testid="collab-member"][data-user="USR-10593"] [data-testid="member-expiry"]'), /^Expired 2 days ago/);
  assert.equal(await page.getAttribute('[data-testid="collab-member"][data-user="USR-10593"]', "data-status"), "expired");
  assert.match(await text(page, '[data-testid="collab-member"][data-user="USR-10592"] [data-testid="member-expiry"]'), /^Expires in 3 days/);
  assert.match(await text(page, '[data-testid="collab-member"][data-user="USR-10591"] [data-testid="member-access"]'), /^Full Access$/, "editor reads as Full Access");
  ok("expiry is shown: “Expired 2 days ago” on an ended membership, “Expires in 3 days” on a running one");

  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="collaborators-dialog"]', { state: "detached" });
  ok("Escape closes the dialog");
  assert.deepEqual(errors, []);
  await close();
}
{
  reset();
  const { page, errors, close } = await newPage();
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="project-overview"][data-loaded="true"]');
  await page.waitForSelector('[data-testid="po-collaborators"]');
  /* next to Open programming */
  const actions = await page.$$eval(".po-actions > *", (es) => es.map((e) => e.getAttribute("data-testid")));
  assert.deepEqual(actions.slice(0, 3), ["po-open-programming", "po-collaborators", "po-invite"], actions.join(" | "));
  assert.equal((await page.$$('[data-testid="po-collaborators"] .avatar')).length, 4, "four avatars");
  assert.equal(await text(page, '[data-testid="po-collaborators-more"]'), "+2");
  ok("Overview: an avatar button (four faces and “+2”) and “+ Invite” sit beside Open programming");

  await page.click('[data-testid="po-collaborators"]');
  await page.waitForSelector('[data-testid="collaborators-dialog"] [data-testid="collaborators-panel"]');
  assert.deepEqual(await panelSignature(page), fromWorkspace, "the same people, roles and statuses as the Workspace door");
  await page.click('[data-testid="collaborators-dialog-close"]');
  await page.click('[data-testid="po-invite"]');
  await page.waitForSelector('[data-testid="collaborators-dialog"] [data-testid="share-box"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "share-identifier");
  ok("Overview: both buttons open the SAME panel; “+ Invite” lands in the invite field");
  assert.deepEqual(errors, []);
  await close();
}

/* ============================================================ 2. invite with a preset, preview, expiry */

console.log("\nInviting with a preset — preview and expiry before sending");
{
  reset();
  const { page, errors, close } = await newPage();
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "networkidle" });
  await page.click('[data-testid="po-invite"]');
  await page.waitForSelector('[data-testid="share-box"]');

  await page.click('[data-testid="access-options-toggle"]');
  await page.click('[data-testid="preset-external_vendor"]');
  assert.equal(await page.$eval('[data-testid="share-role"]', (s) => s.value), "custom", "a preset is a starting point stored as Custom");
  const levels = await page.$$eval('[data-testid="perm-card"]', (es) => Object.fromEntries(es.map((e) => [e.getAttribute("data-module"), e.getAttribute("data-level")])));
  assert.deepEqual(levels, { programming: "view", deployment: "view", fieldwork: "view", data: "none", analytics: "none", collaboration: "none", usage: "none", admin: "none" });
  ok("the External Vendor preset fills the module cards (Data, Reports, Admin: None)");

  /* the radio sits inside its visible chip (a <label>); a person clicks the chip */
  const pick = (scope, id) => page.click(`${scope} label:has([data-testid="expiry-${id}"])`);
  await pick('[data-testid="share-box"]', "7d");
  assert.match(await text(page, '[data-testid="expiry-text"]'), /^Expires in 7 days .* access ends automatically$/);
  await pick('[data-testid="share-box"]', "custom");
  await page.fill('[data-testid="expiry-date"]', "2000-01-01");
  assert.match(await text(page, '[data-testid="expiry-text"]'), /must be in the future/);
  await pick('[data-testid="share-box"]', "7d");
  ok("expiry: 1 day / 7 / 30 / custom date / none — a past date is refused before sending");

  world.lookup = { found: false, invitable: true, identifier: "vendor@panel.com", note: "No account uses that address yet." };
  await page.fill('[data-testid="share-identifier"]', "vendor@panel.com");
  await page.click('[data-testid="share-lookup"]');
  await page.waitForSelector('[data-testid="share-lookup-result"] [data-testid="access-preview"]');
  const allowed = await text(page, '[data-testid="preview-allowed"]');
  const restricted = await text(page, '[data-testid="preview-restricted"]');
  assert.match(allowed, /See fieldwork progress and live quota counts/);
  assert.match(allowed, /Open the project and read the questionnaire/);
  assert.doesNotMatch(allowed, /response data/i);
  await page.click('[data-testid="preview-restricted"] button');
  const restrictedAll = await text(page, '[data-testid="preview-restricted"]');
  assert.match(restrictedAll, /Export \/ download the response dataset/);
  assert.match(restrictedAll, /See respondent contact details/);
  assert.match(restrictedAll, /Delete the project \(owner only\)/);
  assert.match(await text(page, '[data-testid="preview-summary"]'), /^Custom · \d+ of \d+ permissions$/);
  ok("the preview lists Allowed and Restricted in words before anything is sent");
  void restricted;

  await page.click('[data-testid="share-invite"]');
  await page.waitForSelector('[data-testid="collab-invitation"][data-email="vendor@panel.com"]');
  assert.equal(world.lastShare.role, "custom");
  assert.equal(world.lastShare.permissions.modules.data, "none");
  assert.equal(world.lastShare.permissions.modules.fieldwork, "view");
  assert.deepEqual(world.lastShare.expiry, { option: "7d", date: world.lastShare.expiry.date });
  assert.match(await text(page, '[data-testid="collab-invitation"][data-email="vendor@panel.com"]'), /Custom .* access until/);
  assert.match(await text(page, '[data-testid="collab-note"]'), /invited as Custom/);
  ok("Send: the invitation carries role + permissions + expiry, and is listed as pending with its access end date");
  assert.deepEqual(errors, []);
  await close();
}

/* ============================================================ 3. custom cards, search, change with preview */

console.log("\nCustom permission cards, search and a change with its preview");
{
  reset();
  const { page, errors, close } = await newPage();
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "networkidle" });
  await page.click('[data-testid="po-collaborators"]');
  const cy = '[data-testid="collab-member"][data-user="USR-10594"]';
  await page.waitForSelector(cy);
  await page.click(`${cy} [data-testid="member-menu"]`);
  await page.click('[data-testid="member-edit"]');
  await page.waitForSelector('[data-testid="member-editor"]');
  await page.click('[data-testid="member-editor"] [data-testid="access-customize"]');
  assert.equal((await page.$$('[data-testid="member-editor"] [data-testid="perm-card"]')).length, 8, "eight real modules");
  assert.equal(await page.getAttribute('[data-testid="member-editor"] [data-testid="perm-card"][data-module="programming"]', "data-level"), "manage", "Edit Access as custom starts from what it is");
  assert.equal(await page.$('[data-testid="member-editor"] [data-testid="perm-card"][data-module="programming"] [data-testid="level-none"]:not([disabled])'), null, "the questionnaire cannot be set to None");
  assert.equal(await page.$('[data-testid="member-editor"] [data-testid="perm-card"][data-module="admin"] [data-testid="level-manage"]:not([disabled])'), null, "administration has no Manage level");
  ok("“Customize” turns a role into eight module cards, each with None / View / Edit / Manage (only the levels it has)");

  const dataCard = '[data-testid="member-editor"] [data-testid="perm-card"][data-module="data"]';
  await page.click(`${dataCard} [data-testid="level-none"]`);
  assert.equal(await page.getAttribute(`${dataCard} [data-testid="level-none"]`, "aria-checked"), "true");
  await page.click(`${dataCard} [data-testid="level-none"]`);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute(dataCard, "data-level"), "view", "arrow keys move the radio-like control");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getAttribute(dataCard, "data-level"), "none");
  ok("one level per module, radio-like, keyboard operable");

  await page.fill('[data-testid="member-editor"] [data-testid="perm-search"]', "export");
  await page.waitForSelector('[data-testid="member-editor"] [data-testid="perm-search-count"]');
  assert.equal(await text(page, '[data-testid="member-editor"] [data-testid="perm-search-count"]'), "2 permissions in 2 modules");
  const shown = await page.$$eval('[data-testid="member-editor"] [data-testid="perm-card"]', (es) => es.map((e) => e.getAttribute("data-module")).sort());
  assert.deepEqual(shown, ["analytics", "data"]);
  assert.ok(await page.$('[data-testid="member-editor"] [data-testid="perm-cap"][data-cap="responses.export"].hit'));
  assert.ok(await page.$('[data-testid="member-editor"] [data-testid="perm-cap"][data-cap="analytics.export"].hit'));
  ok("searching “export” finds the export permissions across Data and Reports, and highlights them");
  await page.fill('[data-testid="member-editor"] [data-testid="perm-search"]', "");

  const changes = await text(page, '[data-testid="member-editor"] [data-testid="preview-changes"]');
  assert.match(changes, /Access: Edit Access → Custom/);
  await page.click('[data-testid="member-editor"] label:has([data-testid="expiry-30d"])');
  assert.match(await text(page, '[data-testid="member-editor"] [data-testid="preview-changes"]'), /Expiry: none → \d{4}-\d{2}-\d{2}/);
  await page.click('[data-testid="edit-save"]');
  await page.waitForSelector('[data-testid="member-editor"]', { state: "detached" });
  assert.equal(world.lastPatch.userId, "u5");
  assert.equal(world.lastPatch.role, "custom");
  assert.equal(world.lastPatch.permissions.modules.data, "none");
  assert.equal(world.lastPatch.expiry.option, "30d");
  await page.waitForSelector(`${cy}[data-role="custom"] [data-testid="member-expiry"]`);
  ok("Save sends role + permissions + expiry; the row now reads Custom with its expiry");

  /* copy permissions from another collaborator */
  await page.click('[data-testid="access-options-toggle"]');
  await page.selectOption('[data-testid="share-box"] [data-testid="copy-from"]', "u3");
  assert.equal(await page.$eval('[data-testid="share-role"]', (s) => s.value), "custom");
  assert.equal(await page.getAttribute('[data-testid="share-box"] [data-testid="perm-card"][data-module="data"]', "data-level"), "view", "Ana's Data: View is copied");
  assert.equal(await page.$eval('[data-testid="share-box"] [data-testid="expiry-none"]', (r) => r.checked), true, "the expiry is NOT copied");
  ok("Copy from… takes another collaborator's access (not their expiry) as the starting point");
  assert.deepEqual(errors, []);
  await close();
}

/* ============================================================ 4. invitations, history, escalation */

console.log("\nPending invitations, history, and what a non-owner is offered");
{
  reset();
  const { page, errors, close } = await newPage();
  await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
  await page.click('.survey-card button[aria-haspopup="menu"]');
  await page.click('[data-testid="collaborators-menu-item"]');
  const inv = '[data-testid="collab-invitation"][data-email="pending@client.com"]';
  await page.waitForSelector(inv);
  await page.click(`${inv} [data-testid="invitation-resend"]`);
  await page.waitForFunction(() => /sent again/.test(document.querySelector('[data-testid="collab-note"]')?.textContent ?? ""));
  assert.deepEqual(world.lastResend, { invitationId: "inv-1", action: "resend" });
  assert.match(await text(page, inv), /re-sent 1×/);
  await page.click(`${inv} [data-testid="invitation-revoke"]`);
  await page.waitForSelector(inv, { state: "detached" });
  ok("a pending invitation can be resent (a fresh link) and cancelled");

  await page.click('[data-testid="collab-tab-history"]');
  await page.waitForSelector('[data-testid="history-entry"]');
  const entries = await page.$$eval('[data-testid="history-entry"]', (es) => es.map((e) => e.getAttribute("data-action")));
  assert.ok(entries.includes("project.access_expired") && entries.includes("project.permission_changed") && entries.includes("project.shared"), entries.join(", "));
  assert.match(await text(page, '[data-testid="history-entry"][data-action="project.permission_changed"]'), /Data: Manage → View/);
  ok("History: who shared, what changed, and when access expired");
  await page.keyboard.press("Escape");

  /* an editor may invite, but not mint a Project Admin, and cannot change people */
  world.myRole = "editor";
  world.myAccess = { role: "editor", permissions: null, expiresAt: null };
  await page.click('.survey-card button[aria-haspopup="menu"]');
  await page.click('[data-testid="collaborators-menu-item"]');
  await page.waitForSelector('[data-testid="share-role"]');
  const disabled = await page.$$eval('[data-testid="share-role"] option:disabled', (os) => os.map((o) => o.value));
  assert.ok(disabled.includes("project_admin"), `disabled: ${disabled.join(", ")}`);
  assert.ok(!disabled.includes("programmer") && !disabled.includes("viewer"), "the old roles stay grantable by an editor");
  assert.equal(await page.$('[data-testid="member-role"]'), null, "no access changes without project.manage_members");
  ok("an editor is not offered Project Admin, and sees no controls to change other people");
  assert.deepEqual(errors, []);
  await close();
}

/* ============================================================ 5. the Overview obeys the caller's capabilities; phone width */

console.log("\nThe Overview offers only what the caller's access includes; the panel at phone width");
{
  reset();
  const caps = ["project.read", "lock.request", "fieldwork.read"];
  const { page, errors, close } = await newPage(390, OVERVIEW({ role: "custom", accessLabel: "Custom", capabilities: caps, accessExpiresAt: iso(NOW + 5 * DAY), accessExpiryText: describeExpiry(iso(NOW + 5 * DAY)) }));
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="project-overview"][data-loaded="true"]');
  assert.equal(await page.getAttribute('[data-testid="po-nav-data"]', "data-denied"), "true");
  assert.equal(await page.getAttribute('[data-testid="po-nav-analytics"]', "data-denied"), "true");
  assert.equal(await page.getAttribute('[data-testid="po-open-data"]', "aria-disabled"), "true");
  assert.equal(await page.getAttribute('[data-testid="po-nav-fieldwork"]', "data-denied"), null);
  assert.equal(await page.getAttribute('[data-testid="po-nav-programming"]', "href"), "/studio/sandbox?tab=questions");
  assert.match(await text(page, '[data-testid="po-access-expiry"]'), /your access: expires in 5 days/);
  ok("Data: None and Reports: None — the Overview's tiles and Data button are disabled; the expiry is stated");

  await page.click('[data-testid="po-collaborators"]');
  await page.waitForSelector('[data-testid="collaborators-panel"]');
  await page.click('[data-testid="access-options-toggle"]');
  await page.click('[data-testid="preset-data_analyst"]');
  const dialog = await page.$eval(".cx-dialog", (d) => {
    const r = d.getBoundingClientRect();
    const body = d.querySelector(".cx-dialog-body");
    return { left: r.left, right: r.right, inner: window.innerWidth, overflow: body.scrollWidth - body.clientWidth };
  });
  assert.ok(dialog.left >= 0 && dialog.right <= dialog.inner + 1, `the dialog fits the phone: ${JSON.stringify(dialog)}`);
  assert.ok(dialog.overflow <= 1, `nothing inside it scrolls sideways: ${JSON.stringify(dialog)}`);
  ok("at 390px the dialog, the cards and the segmented controls fit without horizontal scroll");
  assert.deepEqual(errors, []);
  await close();
}

await browser.close();
console.log(`\n${passed} passed`);
