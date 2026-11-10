/**
 * CAPTURE THE DEVELOPER DOCS' BUILDER SCREENSHOTS (2026-11-09).
 *
 * Every live example in apps/studio/lib/docs/examples.ts is loaded into the real Studio (sandbox, JSON → validate &
 * apply) and photographed where its `builder` says: a question's editor card (and the Properties section it names), or
 * a Studio tool (Survey Flow, Quotas…). The PNGs land in apps/studio/public/docs-media/builder/<id>.png (and
 * <id>-panel.png), which the docs show as the example's Builder view. Re-run it whenever the editor changes:
 *
 *   node scripts/capture-docs-builder.mjs            (studio on :3000 with AI_API_URL=fake:)
 *   node scripts/capture-docs-builder.mjs piping     (only the examples named)
 *
 * An Intelligent Mode example (`builder.intelligent`) loads the survey as it was BEFORE its sentences and types the
 * sentence, so the picture is the proposal the reader would get.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const ROOT = new URL("..", import.meta.url).pathname;
const STUDIO_DIR = join(ROOT, "apps", "studio");
const OUT = join(STUDIO_DIR, "public", "docs-media", "builder");
mkdirSync(OUT, { recursive: true });

/* the examples, built by the same code the docs pages use */
const dump = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e",
  `import("./lib/docs/examples.ts").then(async ({ DOC_EXAMPLES }) => { const { buildExampleDef } = await import("./lib/docs/build.ts");
   process.stdout.write(JSON.stringify(DOC_EXAMPLES.map((e) => { const b = buildExampleDef(e); return { id: e.id, builder: e.builder, def: e.builder.intelligent ? buildExampleDef({ ...e, say: [] }).def : b.def, errors: b.errors }; }))); })`], { cwd: STUDIO_DIR, maxBuffer: 64 * 1024 * 1024 }).toString();
const only = process.argv.slice(2);
const examples = JSON.parse(dump).filter((e) => !only.length || only.includes(e.id));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await page.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(page, "studio").catch(() => {});
/* confirmations ("Definition applied from JSON") are not part of the builder being shown */
await page.addStyleTag({ content: ".toast { display: none !important; }" });
/* the sandbox restores its last draft shortly after it opens: let that happen before the first example is loaded */
await page.waitForTimeout(3000);

const load = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  if (await page.$('button:has-text("edit")')) await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify({ ...def, meta: { ...def.meta, id: "sandbox", title: "Docs example" } }));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(700);
  const err = await page.$eval("body", (b) => (b.innerText.match(/questions\.\d+[^\n]*|flow\.\d+[^\n]*/) ?? [""])[0]);
  if (err) throw new Error(`the Studio refused the definition: ${err}`);
};
/** a screenshot of an element, at most `max` CSS pixels tall from its top */
const shot = async (el, file, max = 900) => {
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const box = await el.boundingBox();
  if (!box) throw new Error(`nothing to photograph for ${file}`);
  await page.evaluate((y) => window.scrollBy(0, y), Math.max(0, box.y - 110));
  await page.waitForTimeout(200);
  const b2 = await el.boundingBox();
  await page.screenshot({ path: join(OUT, file), clip: { x: Math.max(0, b2.x - 6), y: Math.max(0, b2.y - 6), width: Math.min(b2.width + 12, 1440 - Math.max(0, b2.x - 6)), height: Math.min(b2.height + 12, max) } });
};

const done = [];
for (const ex of examples) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.move(700, 600); await page.mouse.click(5, 990).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  try {
    if (ex.builder.intelligent) {
      /* the Intelligent conversation lives as long as the page: each example starts a fresh one, or the previous
         example's proposals would be on screen (and revised by this sentence) */
      await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
      await page.waitForSelector(".block-badge", { timeout: 60000 });
      await switchMode(page, "studio").catch(() => {});
      await page.addStyleTag({ content: ".toast { display: none !important; }" });
      await page.waitForTimeout(3000);
    }
    await load(ex.def);
    if (ex.builder.intelligent) {
      await openTab(page, "Questions");
      await switchMode(page, "intelligent");
      await page.waitForSelector('[data-testid="intelligent-view"]', { timeout: 20000 });
      const n = await page.$$eval('[data-testid="cp-turn"]', (t) => t.length);
      await page.fill('[data-testid="iq-input"]', ex.builder.intelligent);
      await page.keyboard.press("Enter");
      await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
      await page.waitForTimeout(900);
      const view = await page.$('[data-testid="intelligent-view"]');
      await shot(view, `${ex.id}-say.png`, 1000);
      await switchMode(page, "studio").catch(() => {});
      done.push(ex.id);
      console.log(`  ok   ${ex.id}`);
      continue;
    }
    const tab = ex.builder.tab ?? "Questions";
    await openTab(page, tab);
    await page.waitForTimeout(700);
    if (tab === "Questions" && ex.builder.question) {
      const q = ex.def.questions.find((x) => x.code === ex.builder.question);
      const card = `[data-testid="qcard"][data-qid="${q.id}"]`;
      await page.waitForSelector(card);
      await page.waitForTimeout(1500);
      for (let k = 0; k < 3 && !(await page.$(`${card}.selected`)); k++) { await page.click(`${card} [data-testid="qcard-toggle"]`); await page.waitForTimeout(900); }
      if (!(await page.$(`${card}.selected`))) throw new Error(`${q.code} would not open`);
      await page.evaluate(() => document.querySelector(".toast, [data-testid='toast']")?.remove());
      const cardEl = await page.$(card);
      if (!cardEl) throw new Error(`no card for ${q.code} (${q.id}); cards: ${(await page.$$eval('[data-testid="qcard"]', (c) => c.map((x) => x.getAttribute("data-qid")))).join(",")}`);
      await shot(cardEl, `${ex.id}.png`, 1000);
      if (ex.builder.section) {
        const id = ex.builder.section;
        const opened = await page.evaluate((id) => {
          const head = document.querySelector(`[data-testid="psec-head-${id}"]`);
          if (!head) return "missing";
          if (!document.querySelector(`[data-testid="psec-body-${id}"]`)) head.click();
          return "ok";
        }, id);
        if (opened !== "ok") throw new Error(`no Properties section ${id}`);
        await page.waitForTimeout(500);
        await page.evaluate((id) => document.querySelector(`[data-testid="psec-head-${id}"]`).scrollIntoView({ block: "start" }), id);
        await page.waitForTimeout(300);
        const r = await page.evaluate((id) => {
          const h = document.querySelector(`[data-testid="psec-head-${id}"]`).getBoundingClientRect();
          const b = document.querySelector(`[data-testid="psec-body-${id}"]`)?.getBoundingClientRect() ?? h;
          return { x: Math.min(h.left, b.left), y: h.top, w: Math.max(h.right, b.right) - Math.min(h.left, b.left), h: b.bottom - h.top };
        }, id);
        if (process.env.DEBUG_SHOT) console.log(JSON.stringify(r));
        await page.screenshot({ path: join(OUT, `${ex.id}-panel.png`), clip: { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.w + 12, height: Math.min(r.h + 12, 900) } });
      }
    } else {
      /* a tool: open every collapsed flow card so the structure shows, then photograph the tool */
      if (tab === "Survey Flow") {
        for (let k = 0; k < 4; k++) {
          const n = await page.evaluate(() => {
            const els = [...document.querySelectorAll('[data-testid="ide-body"] [aria-expanded="false"]')].filter((e) => !e.closest(".menubar") && !e.hasAttribute("aria-haspopup") && e.getBoundingClientRect().width > 0);
            els.forEach((e) => e.click());
            return els.length;
          });
          if (!n) break;
          await page.waitForTimeout(400);
        }
      }
      const body = await page.$('[data-testid="ide-body"]');
      await shot(body, `${ex.id}.png`, 1100);
    }
    done.push(ex.id);
    console.log(`  ok   ${ex.id}`);
  } catch (e) {
    console.log(`  FAIL ${ex.id}: ${e.message.split("\n").slice(0, 4).join(" | ")}`);
  }
}
/* PNG → WebP (about a fifth of the size, sharp enough for screenshots); the docs read the .webp */
try {
  execFileSync("python3", ["-c", `import sys, os
from PIL import Image
d = sys.argv[1]
for f in os.listdir(d):
    if f.endswith(".png"):
        Image.open(os.path.join(d, f)).save(os.path.join(d, f[:-4] + ".webp"), "WEBP", quality=86, method=6)
        os.remove(os.path.join(d, f))`, OUT]);
} catch (e) { console.log(`  (WebP conversion skipped: ${e.message.split("\n")[0]}) — the PNGs are kept`); }
let prev = [];
try { prev = JSON.parse(readFileSync(join(OUT, "captured.json"), "utf8")).examples ?? []; } catch { /* first run */ }
writeFileSync(join(OUT, "captured.json"), JSON.stringify({ capturedAt: new Date().toISOString(), examples: [...new Set([...prev, ...done])].sort() }, null, 2));
console.log(`\n${done.length} of ${examples.length} examples captured into ${OUT}`);
await browser.close();
process.exit(done.length === examples.length ? 0 : 1);
