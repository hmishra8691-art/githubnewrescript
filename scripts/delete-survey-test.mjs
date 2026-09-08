/**
 * SURVEY DELETE — HONEST FAILURE REPORTING (P0).
 *
 * The reported bug: clicking Delete "appears to run" but the survey stays.
 * Root cause found by reading the code (not guessing): the confirm button's
 * handler closed the modal and refetched the list UNCONDITIONALLY, even when
 * `!r.ok` — so a refused delete (wrong role, a locked project, a transient
 * 500) looked pixel-for-pixel identical to a real one. The backend hard
 * delete itself (`rescript_delete_project`, cascading FKs) was already
 * correct; this suite is about the one place that was lying to the user.
 *
 * Supabase is not available here, so `/api/surveys` and
 * `DELETE /api/surveys/:id` are intercepted with fixtures — this still
 * exercises the real page: the confirm dialog, the type-to-confirm gate, the
 * modal's open/close decision, the inline error, and the permission-aware
 * disabled state on the menu item (Fix 3).
 *
 *   node scripts/delete-survey-test.mjs        (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60_000).toISOString();

/*
 * One survey per scenario so each can carry its own DELETE behaviour without
 * suites interfering with each other's state.
 */
const SURVEYS = [
  { id: "s-ok", code: "OK_DELETE", title: "Deletes Cleanly", status: "draft",
    created_at: ago(60), updated_at: ago(10), current_version_id: "v1", myRole: "owner" },
  { id: "s-403", code: "FORBIDDEN_DELETE", title: "Refused By Server", status: "draft",
    created_at: ago(60), updated_at: ago(10), current_version_id: "v2", myRole: "owner" },
  { id: "s-404", code: "ALREADY_GONE", title: "Already Deleted Elsewhere", status: "draft",
    created_at: ago(60), updated_at: ago(10), current_version_id: "v3", myRole: "owner" },
  { id: "s-net", code: "NETWORK_DELETE", title: "Network Drops The Request", status: "draft",
    created_at: ago(60), updated_at: ago(10), current_version_id: "v4", myRole: "owner" },
  { id: "s-editor", code: "EDITOR_SURVEY", title: "Not My Project To Delete", status: "draft",
    created_at: ago(60), updated_at: ago(10), current_version_id: "v5", myRole: "editor" },
];
const STATS = Object.fromEntries(SURVEYS.map((s) => [s.id, {
  questionCount: 5, responseCount: 0, testResponseCount: 0, liveResponseCount: 0,
  completeCount: 0, lastResponseAt: null, contributorIds: [], versionCount: 1,
}]));

const deletedIds = new Set();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "delete-survey-test-session-0000", url: "http://localhost:3000" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.route("**/api/auth/me", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    userId: "u-test", userCode: "USR-10000", name: "Test Owner",
    email: "owner@example.com", platformRole: "programmer", isPlatformAdmin: false,
    sessionId: "sess-test", unread: 0,
    policies: {
      heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15,
      idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180,
    },
  }),
}));
await page.route("**/api/auth/heartbeat", (route) => route.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }),
}));

await page.route("**/api/surveys", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      surveys: SURVEYS.filter((s) => !deletedIds.has(s.id)),
      stats: STATS, contributors: {}, statsSource: "rpc", warnings: [],
    }),
  });
});

/*
 * The exact shapes the real DELETE route actually produces, per
 * apps/studio/app/api/surveys/[id]/route.ts and lib/guard.ts's
 * `requireProjectFor` — a 403 carries a specific, human-readable `error`
 * that the modal must show verbatim, not a generic message.
 */
await page.route("**/api/surveys/*", async (route) => {
  const req = route.request();
  const id = req.url().split("/").pop();
  if (req.method() !== "DELETE") return route.continue();
  if (id === "s-ok") {
    deletedIds.add(id);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  }
  if (id === "s-403") {
    return route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({
        error: "Your role on this project (Editor) does not allow this.",
        code: "insufficient_role", role: "editor", roleSource: "member", capability: "project.delete",
      }),
    });
  }
  if (id === "s-404") {
    deletedIds.add(id); // it really is gone — someone else got there first
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  }
  if (id === "s-net") {
    return route.abort("failed");
  }
  return route.continue();
});

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".survey-card:not(.skeleton)");
assert.equal((await page.$$(".survey-card:not(.skeleton)")).length, 5, "all five fixture surveys render");

const openDeleteModal = async (title, code) => {
  await page.click(`.survey-card:has-text("${title}") .menu-anchor button`);
  await page.waitForSelector('[data-testid="delete-survey-menu-item"]');
  await page.click('[data-testid="delete-survey-menu-item"]');
  await page.waitForSelector('[data-testid="delete-modal"]');
  await page.fill('[data-testid="delete-confirm-input"]', code);
};

/* ===================================================== a real success */

console.log("\nA genuine 200 — the modal closes and the survey disappears");
{
  await openDeleteModal("Deletes Cleanly", "OK_DELETE");
  await page.click('[data-testid="delete-confirm-btn"]');
  await page.waitForSelector('[data-testid="delete-modal"]', { state: "detached" });
  await page.waitForSelector('.survey-card:has-text("Deletes Cleanly")', { state: "detached" });
  console.log("✔ 200 OK: modal closed, survey gone from the (re-fetched) list");
}

/* ============================================ THE BUG — a refused delete */

console.log("\nA 403 refusal — must NOT look like success (this is the reported bug)");
{
  await openDeleteModal("Refused By Server", "FORBIDDEN_DELETE");
  await page.click('[data-testid="delete-confirm-btn"]');
  // give the fetch a moment, then assert the modal is still there — the bug
  // was that this exact case silently closed the modal and reloaded as if
  // it had worked
  await page.waitForTimeout(300);
  const stillOpen = await page.$('[data-testid="delete-modal"]');
  assert.ok(stillOpen, "the modal must stay open on a refused delete");
  const errText = await page.$eval('[data-testid="delete-error"]', (e) => e.textContent);
  assert.match(errText, /Your role on this project \(Editor\) does not allow this\./,
    `the exact server reason must be shown, got: ${errText}`);
  const stillListed = await page.$('.survey-card:has-text("Refused By Server")');
  // the survey card is behind the modal backdrop but still in the DOM
  assert.ok(stillListed, "the survey must still be in the list underneath — nothing was deleted");
  console.log("✔ 403: modal stays open, exact server reason shown, survey untouched");

  // and it must be retryable without a page reload
  const retryEnabled = await page.$eval('[data-testid="delete-confirm-btn"]', (b) => !b.disabled);
  assert.ok(retryEnabled, "Delete permanently must be clickable again for a retry");
  await page.click('[data-testid="delete-cancel-btn"]');
  await page.waitForSelector('[data-testid="delete-modal"]', { state: "detached" });
}

/* ===================================================== already deleted */

console.log("\nA 404 (already deleted elsewhere) — treated as done, not an error");
{
  await openDeleteModal("Already Deleted Elsewhere", "ALREADY_GONE");
  await page.click('[data-testid="delete-confirm-btn"]');
  await page.waitForSelector('[data-testid="delete-modal"]', { state: "detached" });
  await page.waitForSelector('.survey-card:has-text("Already Deleted Elsewhere")', { state: "detached" });
  console.log("✔ 404: modal closes quietly, list reflects it's gone, no scary error");
}

/* =========================================================== network failure */

console.log("\nA dropped network request — generic, retryable, modal stays open");
{
  await openDeleteModal("Network Drops The Request", "NETWORK_DELETE");
  await page.click('[data-testid="delete-confirm-btn"]');
  await page.waitForTimeout(300);
  const stillOpen = await page.$('[data-testid="delete-modal"]');
  assert.ok(stillOpen, "the modal must stay open when the request itself fails");
  const errText = await page.$eval('[data-testid="delete-error"]', (e) => e.textContent);
  assert.match(errText, /could not reach the server/i, `expected a generic retryable message, got: ${errText}`);
  const stillListed = await page.$('.survey-card:has-text("Network Drops The Request")');
  assert.ok(stillListed, "the survey must still be listed — nothing was deleted");
  console.log("✔ network failure: generic message shown, survey untouched, retryable");
  await page.click('[data-testid="delete-cancel-btn"]');
  await page.waitForSelector('[data-testid="delete-modal"]', { state: "detached" });
}

/* ============================================== Fix 3 — permission gating */

console.log("\nA role without project.delete never gets an option that can only fail");
{
  await page.click('.survey-card:has-text("Not My Project To Delete") .menu-anchor button');
  await page.waitForSelector('[data-testid="delete-survey-menu-item"]');
  const [disabled, title] = await page.$eval('[data-testid="delete-survey-menu-item"]',
    (b) => [b.disabled, b.title]);
  assert.equal(disabled, true, "an editor must not see an enabled Delete option");
  assert.match(title, /Only the project owner/, `expected an explanatory tooltip, got: ${title}`);
  console.log("✔ editor role: Delete survey… is disabled with an ownership tooltip");
}

await browser.close();
console.log("\nALL DELETE-SURVEY CHECKS PASSED");
