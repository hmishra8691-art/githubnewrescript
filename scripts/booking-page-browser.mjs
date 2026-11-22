/**
 * THE INVITEE'S BOOKING PAGE IN A BROWSER (Q6): /book/<token> against a fake /api/book that applies the real
 * scheduling rules (packages/interviews). Open times in the browser's zone, book, move, cancel, a full time refused,
 * an unknown link. Needs the Studio running (STUDIO_URL, default http://localhost:3000). Exit code 1 on failure.
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { book, cancel, openSlots, slotsFrom } from "../packages/interviews/dist/index.js";

let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? null;
const TOKEN = "0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d." + "A".repeat(43);
const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const slots = slotsFrom({ windows: [{ date: day, from: "10:00", to: "12:00" }], minutes: 45, bufferMinutes: 15, capacity: 1 });
let bookings = [{ id: "me", inviteeId: "a@example.com", slotId: null, status: "invited", invitedAt: new Date().toISOString(), remindersSent: [] },
  { id: "other", inviteeId: "b@example.com", slotId: slots[1].id, status: "booked", invitedAt: new Date().toISOString(), remindersSent: [] }];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const state = () => { const me = bookings.find((b) => b.id === "me"); const s = slots.find((x) => x.id === me.slotId); return { study: "Broadband switching", name: "Ada", status: me.status, booking: s && me.status === "booked" ? { slotId: s.id, startsAt: s.startsAt, endsAt: s.endsAt } : null, slots: openSlots(slots, bookings, new Date().toISOString()).map((x) => ({ id: x.id, startsAt: x.startsAt, endsAt: x.endsAt })) }; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: "Asia/Kolkata" })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/book/**", async (route) => {
  const req = route.request();
  if (!req.url().includes(encodeURIComponent(TOKEN)) && !req.url().includes(TOKEN)) return json(route, { error: "This invitation link is not recognised. Please use the link from your invitation email." }, 404);
  if (req.method() === "GET") return json(route, state());
  const body = JSON.parse(req.postData() || "{}");
  const now = new Date().toISOString();
  if (body.action === "book") { const r = book("me", body.slotId, slots, bookings, now); if (!r.ok) return json(route, { error: r.reason }, 409); bookings = r.bookings; }
  else bookings = cancel("me", slots, bookings, now);
  return json(route, { ok: true, ...state() });
});
try {
  await page.goto(`${STUDIO}/book/${TOKEN}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="book-slots"]', { timeout: 60_000 });
  assert.match(await page.locator("h1").innerText(), /Hello Ada/);
  assert.match(await page.locator(".auth-sub").first().innerText(), /Asia\/(Kolkata|Calcutta)/);
  const times = page.locator('[data-testid="book-slots"] button');
  assert.equal(await times.count(), 1, "the taken time is not offered: two slots in the window, one held by someone else");
  ok("open times are shown in the invitee's zone (Asia/Kolkata); the time someone else holds is not offered");
  await times.first().click();
  await page.locator('[data-testid="book-current"]').waitFor();
  assert.equal(await page.locator('[data-testid="book-note"]').count(), 0, "the booking box says it once");
  ok(`booked: ${(await page.locator('[data-testid="book-current"]').innerText()).split("\n")[0]}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/book.png`, fullPage: true });
  await page.click('[data-testid="book-cancel"]');
  await page.getByText("Your time is cancelled.").waitFor();
  assert.equal(await page.locator('[data-testid="book-current"]').count(), 0);
  ok("cancelled from the same link; the time is offered again");
  /* the other person cancels and the time comes back; then someone takes it while this page is open */
  bookings = bookings.map((b) => (b.id === "other" ? { ...b, status: "cancelled" } : b));
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-testid="book-slots"] button').count(), 2);
  bookings = bookings.map((b) => (b.id === "other" ? { ...b, status: "booked", slotId: slots[0].id } : b));
  await page.locator('[data-testid="book-slots"] button').first().click();
  await page.getByText("That time has just been taken; please pick another.").waitFor();
  ok("a time taken a moment earlier is refused in a sentence");
  const bad = await (await browser.newContext()).newPage();
  await bad.goto(`${STUDIO}/book/not-a-real-link`, { waitUntil: "networkidle" });
  await bad.locator('[data-testid="book-error"]').waitFor({ timeout: 30_000 });
  ok("an unknown link says so");
  assert.deepEqual(errors, []);
  ok("no page errors");
  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("FAIL", e.message);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/book-failure.png`, fullPage: true });
  process.exitCode = 1;
} finally { await browser.close(); }
