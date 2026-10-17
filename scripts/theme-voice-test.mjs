/**
 * BRANDING → DESIGN WITH AI: voice and reference images (October 2026).
 *
 *   node scripts/theme-voice-test.mjs      (studio :3000 with AI_API_URL=fake: — the fake speech provider too)
 *
 * The theme assistant's microphone is Intelligent mode's (lib/useVoiceInput:
 * MediaRecorder → /api/ai/transcribe); Chromium's fake device records, and
 * `window.__rescriptVoiceHint` tells the FAKE speech provider what it heard —
 * the same seam intelligent-mode-test uses. The model is the copilot fake
 * (`window.__rescriptThemeFake`); every request the assistant sends is
 * captured, so what reached /api/copilot/turn is asserted, not assumed.
 *
 *   typed only · voice only · voice + edit (appended, never replacing) ·
 *   pause / resume · voice + one image · voice + two images (each with its own
 *   placeholder, the second becomes the background) · unsupported types (PDF,
 *   GIF) · an oversized file · remove a reference · the proposal reviewed
 *   (nothing saved) and applied (one edit, into Branding).
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, permissions: ["microphone"] });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());
/* every theme request the assistant sends */
const sent = [];
page.on("request", (r) => {
  if (r.url().includes("/api/copilot/turn") && r.method() === "POST") { try { const b = r.postDataJSON(); if (b?.scope === "theme") sent.push(b); } catch { /* not JSON */ } }
});

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(200); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(700);
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef({
  meta: { id: "sandbox", code: "THEME", title: "Theme by voice", version: "1.0" },
  questions: [{ id: "q1", code: "Q1", variableName: "WHY", type: "open_text", text: "Why?" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
await goTab("Branding");
await page.waitForSelector('[data-testid="theme-assistant"]');

const T = {
  input: '[data-testid="theme-assistant-input"]', mic: '[data-testid="theme-assistant-mic"]', pause: '[data-testid="theme-assistant-mic-pause"]',
  file: '[data-testid="theme-assistant-file"]', chip: '[data-testid="theme-assistant-image-chip"]', refErr: '[data-testid="theme-assistant-ref-errors"]',
  ask: '[data-testid="theme-assistant-ask"]', proposal: '[data-testid="theme-assistant-proposal"]', lines: '[data-testid="theme-assistant-lines"]',
  apply: '[data-testid="theme-assistant-apply"]', cancel: '[data-testid="theme-assistant-cancel"]', error: '[data-testid="theme-assistant-error"]',
};
const state = () => page.getAttribute(T.mic, "data-state");
const waitState = (s) => page.waitForFunction(([sel, want]) => document.querySelector(sel)?.dataset.state === want, [T.mic, s], { timeout: 30000 });
/** speak: the fake provider is told what it "heard"; record ~0.7 s of the fake microphone; stop; wait for the transcript */
const speak = async (heard, { pauseResume = false } = {}) => {
  await page.evaluate((h) => window.__rescriptVoiceHint(h, "en"), heard);
  await page.click(T.mic);
  await waitState("recording");
  assert.equal(await page.getAttribute(T.mic, "aria-pressed"), "true");
  assert.equal(await page.getAttribute(T.mic, "aria-label"), "Stop and transcribe");
  if (pauseResume) {
    await page.waitForSelector(T.pause);
    await page.click(T.pause);
    await waitState("paused");
    assert.equal(await page.getAttribute(T.pause, "aria-label"), "Resume recording");
    await page.waitForTimeout(300);
    await page.click(T.pause);
    await waitState("recording");
  }
  await page.waitForTimeout(700);
  await page.click(T.mic);
  await waitState("idle");
  assert.equal(await page.$(T.mic) && await page.getAttribute(T.mic, "aria-pressed"), "false");
};
const PROPOSAL = (image) => ({ kind: "proposal", reply: "A dark theme with gold accents.", actions: [{ op: "set_theme", colors: { primary: "#dc3214" }, ...(image ? { background: { image, overlay: "rgba(0,0,0,.4)" } } : {}) }] });
const askWith = async (reply) => {
  const before = sent.length;
  await page.evaluate((r) => window.__rescriptThemeFake(r), reply);
  await page.click(T.ask);
  await page.waitForSelector(`${T.proposal}, ${T.error}`, { timeout: 30000 });
  assert.equal(await page.$(T.error), null, await page.$(T.error) ? await page.textContent(T.error) : "");
  assert.equal(sent.length, before + 1, "one request to the copilot");
  return sent.at(-1);
};
const cancel = async () => { await page.click(T.cancel); await page.waitForSelector(T.proposal, { state: "detached" }); };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGklEQVR4nGOQlVfAg+4YiaAhhlENoxqGrwYAkxamQdFz5cAAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from((await page.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d"); g.fillStyle = "#1b2a4a"; g.fillRect(0, 0, 32, 32); g.fillStyle = "#d4af37"; g.fillRect(8, 8, 16, 16); return c.toDataURL("image/jpeg", 0.9); })).split(",")[1], "base64");
const attach = async (files) => { await page.setInputFiles(T.file, files); await page.waitForTimeout(200); };
const readyChips = async (n) => page.waitForFunction(([sel, k]) => { const cs = document.querySelectorAll(sel); return cs.length === k && [...cs].every((c) => c.dataset.state === "ready"); }, [T.chip, n], { timeout: 60000 }); // the first upload compiles the asset route on a cold dev server

/* --------------------------------------------------------------- typed only */
{
  assert.equal(await state(), "idle");
  assert.equal(await page.getAttribute(T.mic, "aria-label"), "Describe the look by voice");
  await page.fill(T.input, "A calm light theme in sage green");
  const req = await askWith(PROPOSAL());
  assert.equal(req.message, "A calm light theme in sage green");
  assert.equal(req.themeImages, undefined, "no references sent");
  assert.match(await page.textContent(T.lines), /primary colour: .* → #dc3214/);
  await cancel();
  ok("typed only: the prompt reaches the theme turn as typed; a proposal is reviewed");
}

/* ------------------------------------------------------- unsupported / oversized / remove */
{
  await attach([{ name: "brand.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") }, { name: "anim.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") }]);
  await page.waitForSelector(T.refErr);
  const errs = await page.$$eval(`${T.refErr} li`, (ls) => ls.map((l) => l.textContent));
  assert.equal(errs.length, 2, errs.join(" | "));
  assert.match(errs[0], /“brand\.pdf” is a PDF\. PDF references are not supported yet/);
  assert.match(errs[1], /“anim\.gif” is not a supported reference — attach a PNG, JPG\/JPEG or WebP image/);
  assert.equal((await page.$$(T.chip)).length, 0, "nothing attached");
  ok("unsupported file types (PDF, GIF) are refused with a readable reason each");
  await attach([{ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(11 * 1024 * 1024, 1) }]);
  await page.waitForFunction((sel) => /huge\.png/.test(document.querySelector(sel)?.textContent ?? ""), T.refErr);
  assert.match(await page.textContent(T.refErr), /“huge\.png” is 11 MB — a reference can be up to 10 MB/);
  assert.equal((await page.$$(T.chip)).length, 0);
  ok("an oversized file is refused with its size and the limit");
  await attach([{ name: "mood.png", mimeType: "image/png", buffer: png }]);
  await readyChips(1);
  assert.equal(await page.$(T.refErr), null, "errors cleared by the next good file");
  await page.click('[data-testid="theme-assistant-ref-remove"]');
  await page.waitForSelector(T.chip, { state: "detached" });
  ok("a reference can be removed");
}

/* --------------------------------------------------------------- voice only */
{
  await page.fill(T.input, "");
  await speak("a premium dark theme with gold accents");
  assert.equal(await page.inputValue(T.input), "a premium dark theme with gold accents");
  const req = await askWith(PROPOSAL());
  assert.equal(req.message, "a premium dark theme with gold accents", "the transcript is what was asked");
  await cancel();
  ok("voice only: recorded → transcribed by /api/ai/transcribe → in the prompt, editable → asked");
}

/* ----------------------------------------------------------- voice + edit, pause / resume */
{
  await page.fill(T.input, "Use navy and");
  await speak("gold accents on the buttons", { pauseResume: true });
  assert.equal(await page.inputValue(T.input), "Use navy and gold accents on the buttons", "APPENDED to what was typed, never replacing it");
  await page.fill(T.input, "Use navy and gold accents on the buttons, rounded corners");
  const req = await askWith(PROPOSAL());
  assert.equal(req.message, "Use navy and gold accents on the buttons, rounded corners", "the edited text is what was sent");
  await cancel();
  ok("voice + edit: typed text kept, transcript appended (recorded with a pause and resume), edited before sending");
}

/* ------------------------------------------------------------ voice + one image */
{
  await page.fill(T.input, "");
  await attach([{ name: "mood.png", mimeType: "image/png", buffer: png }]);
  await readyChips(1);
  assert.match(await page.textContent(T.chip), /mood\.png · \d+ KB/);
  assert.ok(await page.$(`${T.chip} img[alt="Reference: mood.png"]`), "a thumbnail");
  await speak("build the theme around this picture");
  const req = await askWith(PROPOSAL("{{THEME_IMAGE}}"));
  assert.equal(req.message, "build the theme around this picture");
  assert.equal(req.themeImages.length, 1);
  assert.equal(req.themeImages[0].name, "mood.png");
  assert.ok(req.themeImages[0].dominant.length > 0 && /^(data:image|https:|\/)/.test(req.themeImages[0].url));
  assert.match(await page.textContent(T.lines), /background image/);
  await cancel();
  ok("voice + one image: its colours and address go with the transcript");
}

/* ------------------------------------------------------ voice + two images → apply */
{
  await attach([{ name: "palette.jpg", mimeType: "image/jpeg", buffer: jpeg }]);
  await readyChips(2);
  assert.deepEqual(await page.$$eval(T.chip, (cs) => cs.map((c) => c.dataset.name)), ["mood.png", "palette.jpg"]);
  await page.fill(T.input, "");
  await speak("blend both references and use the second as the background");
  const req = await askWith(PROPOSAL("{{THEME_IMAGE_2}}"));
  assert.equal(req.themeImages.length, 2);
  assert.deepEqual(req.themeImages.map((t) => t.name), ["mood.png", "palette.jpg"]);
  assert.ok(await page.$('[data-testid="theme-preview-proposed"]'), "the preview shows the proposal");
  // (leaving Branding would close the proposal, so "nothing saved" is read from Branding's own colour fields)
  assert.ok(!(await page.$$eval("input.input.mono", (xs) => xs.map((x) => x.value))).includes("#dc3214"), "nothing is saved until Apply");
  await page.click(T.apply);
  await page.waitForSelector(T.proposal, { state: "detached" });
  assert.equal(await page.inputValue(T.input), "", "the prompt is cleared");
  assert.equal((await page.$$(T.chip)).length, 0, "the references are cleared");
  await page.waitForTimeout(300);
  const def = await readDef();
  assert.equal(def.branding.colors.primary, "#dc3214");
  assert.equal(def.branding.background.image, req.themeImages[1].url, "the SECOND reference's placeholder became the second image's address");
  ok("voice + two images: both described, each with its own placeholder; the proposal reviewed, then applied into Branding");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\nALL THEME VOICE CHECKS PASSED (${passed})`);
