/**
 * S0b D8 (b) — THE SANDBOX FRAME HEARTBEAT, IN A REAL BROWSER (runtime only: a sandbox test link, no Studio).
 *
 * A behaviour script marks its question (rs.addClass) and, on a click, spins in a catastrophic regex — CPU with no
 * loop statement, no promise and no allocation, so neither the loop guard nor the microtask guard can see it.
 * (An `await` recursion was tried first: it allocates, and in this Chromium it crashed the whole tab — "Target
 * crashed" — which is itself evidence that the frame shares the page's renderer.) The host pings the frame every 2 s; after 3 missed pongs it disposes the frame, undoes
 * the mark and logs "stopped: not responding". This only works when the browser runs the sandboxed (opaque-origin)
 * frame out of process; when it shares the page's thread the page freezes and the check says so instead.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yesNo = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];

const def = {
  meta: { id: "hb_probe", code: "HB_PROBE", title: "Heartbeat probe", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Spinner here", options: yesNo, settings: {} },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Well behaved", options: yesNo, settings: {} },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  ux: {
    styles: [], animations: [],
    behaviors: [
      { id: "b_spin", label: "spinner", target: { kind: "question", questionId: "q1" }, effects: [],
        script: `rs.addClass("self", "hb-mark");\nrs.listen("click", "self", function () {\n  /^(a+)+$/.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!");\n});` },
      { id: "b_ok", label: "steady", target: { kind: "question", questionId: "q2" }, effects: [], script: `rs.addClass("self", "hb-steady");` },
    ],
  },
};

const launch = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
const { url } = await launch.json();
assert.ok(url, "the sandbox test link was launched");

/* HB_ISOLATE=1: ask Chromium to put sandboxed (opaque-origin) frames in their own process, as desktop Chrome does
   with IsolateSandboxedIframes — the case the heartbeat is for */
const isolate = process.env.HB_ISOLATE === "1";
const browser = await chromium.launch(isolate ? { args: ["--site-per-process", "--enable-features=IsolateSandboxedIframes"] } : {});
console.log(`  (chromium ${isolate ? "with IsolateSandboxedIframes" : "default flags"})`);
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
const lines = [];
page.on("console", (m) => lines.push(`${m.type()}: ${m.text()}`));
try {
  await page.goto(`${RUNTIME}${url}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-rs-ux-on~="hb-mark"]', { state: "attached", timeout: 60000 }).catch((e) => { console.log(lines.filter((l) => /rescript|ux script/.test(l)).join("\n")); throw e; });
  await page.waitForSelector('[data-rs-ux-on~="hb-steady"]', { state: "attached", timeout: 30000 });
  ok("both scripts started (the spinner marked its question, the steady one too)");
  // the spinner starts spinning on this click (if the frame shares the page's thread, the click itself never returns)
  await page.click('[data-qid="q1"] label:has-text("Yes")', { noWaitAfter: true, timeout: 5000 }).catch(() => {});
  const t0 = Date.now();
  await sleep(500);
  const alive = await Promise.race([page.evaluate(() => 1).then(() => true), sleep(5000).then(() => false)]);
  if (!alive) {
    console.log("  NOTE the page stopped responding: this Chromium runs the sandboxed frame on the page's thread, where no host timer can interrupt it (the documented limit). Check (b) cannot be shown here.");
    process.exitCode = 2;
  } else {
    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i++) { await sleep(500); stopped = lines.some((l) => /\[rescript:script\] spinner.*stopped: not responding/.test(l)); }
    assert.ok(stopped, lines.filter((l) => /rescript/.test(l)).join("\n"));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    assert.equal(await page.$('[data-rs-ux-on~="hb-mark"]'), null, "the spinner's mark was undone");
    /* the browser puts every sandboxed frame of one page in ONE process, so the steady frame starves too and is
       stopped by the same rule — or, if it got its own process, kept. Either is right; say which. */
    const steadyStopped = lines.some((l) => /\[rescript:script\] steady.*stopped: not responding/.test(l));
    const steadyKept = !!(await page.$('[data-rs-ux-on~="hb-steady"]'));
    assert.ok(steadyStopped !== steadyKept, `the steady script is either kept or stopped and undone (stopped=${steadyStopped}, kept=${steadyKept})`);
    console.log(`  note the steady script was ${steadyStopped ? "stopped too (its frame shares the spinner's process) and undone" : "kept (its own process)"}`);
    assert.equal(await page.$('[data-rs-ux-sandbox="b_spin"]'), null, "the spinner's frame is gone");
    ok(`the spinning frame was stopped after ~${secs} s: "stopped: not responding", its mark undone, its frame removed`);
    await page.click('[data-qid="q2"] label:has-text("No")');
    ok("the page still answers clicks");
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} UX HEARTBEAT CHECKS PASSED`);
