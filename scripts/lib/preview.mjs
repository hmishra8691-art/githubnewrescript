/**
 * HANDING A DEFINITION TO THE RUNTIME PREVIEW, RELIABLY.
 *
 * ## The flake this exists to kill
 *
 * `/preview` is postMessage-driven, and it registers its `message` listener
 * inside a `useEffect` — so the listener does not exist until React has
 * hydrated. Every suite that drives the preview was doing
 *
 *     await page.goto(`${runtime}/preview`, { waitUntil: "networkidle" });
 *     await page.evaluate((d) => window.postMessage({ … }, "*"), def);
 *     await page.waitForSelector("[data-qid]");
 *
 * which bets that hydration finishes before `networkidle` resolves. Usually it
 * does. Under a long corpus run — a warm dev server, a fresh Chromium per
 * suite — sometimes it does not, the message lands with nobody listening, and
 * it is gone for good: nothing ever re-sends it, so the page sits on "Waiting
 * for survey definition…" until the selector timeout fires. Across two full
 * corpus runs this took out `listfill`, `masking` and `loop` — a different
 * suite each time, which is the signature of a race rather than a bug in any
 * one of them.
 *
 * ## Why the fix belongs here and not in the product
 *
 * The Studio does not have this bug. `previewWindow.ts` waits for the page's
 * `rescript:preview-ready` message AND nudges the definition across seven
 * times over ~2.8 seconds. Only the tests posted exactly once, so the missing
 * retry is the harness's.
 *
 * ## Re-posting is conditional, and that matters
 *
 * The obvious implementation — post again every second until the selector
 * appears — trades a rare hang for a common one. Each `rescript:preview`
 * message calls `setDef` with a fresh object, so a re-post while the page is
 * mid-render restarts the render; on a heavy definition that renders in more
 * than the retry interval, the page would never finish and a slow-but-working
 * case would become a permanent failure.
 *
 * So a re-post happens ONLY while the page is demonstrably still showing its
 * placeholder — proof that no definition has arrived. Once the page has
 * accepted one, we stop posting and simply wait. And a definition the page
 * REJECTED fails immediately with the validation error, rather than burning
 * the whole budget re-sending something that will never be accepted.
 */

const PLACEHOLDER = /Waiting for survey definition/;
const REJECTED = /Definition failed validation/;

/**
 * @param {import("playwright").Page} page   a page already on /preview
 * @param {object} payload                   the `rescript:preview` message body,
 *                                           minus `type` — `{ definition, startAt?, answers?, … }`
 * @param {object} [opts]
 * @param {string} [opts.selector="[data-qid]"]  what proves the definition arrived
 * @param {Function} [opts.ready]                a page function to poll instead of a selector
 * @param {number} [opts.timeout=45000]          total budget
 */
export async function sendPreview(page, payload, opts = {}) {
  const selector = opts.selector ?? "[data-qid]";
  const ready = opts.ready ?? null;
  const budget = opts.timeout ?? 45_000;
  const deadline = Date.now() + budget;

  const post = () => page.evaluate(
    (p) => window.postMessage({ type: "rescript:preview", ...p }, "*"),
    payload,
  );
  const rendered = async () => {
    try {
      if (ready) return !!(await page.evaluate(ready));
      await page.waitForSelector(selector, { timeout: 250, state: "visible" });
      return true;
    } catch { return false; }
  };
  const text = () => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");

  let posts = 1;
  let lastPost = Date.now();
  await post();

  for (;;) {
    if (await rendered()) return page;

    const shown = await text();
    if (REJECTED.test(shown)) {
      throw new Error(`the preview REJECTED the definition:\n${shown.slice(0, 800)}`);
    }
    if (Date.now() >= deadline) {
      /*
       * Say what actually went wrong. A bare selector timeout sends the reader
       * looking for a rendering bug; if the placeholder is still up, the
       * definition never landed and the bug is in the handoff.
       */
      throw new Error(
        `the preview never rendered ${ready ? "its ready condition" : selector} `
        + `after ${posts} handoff(s) in ${budget}ms.\n`
        + (PLACEHOLDER.test(shown)
          ? "The page is STILL on its placeholder, so no definition was ever accepted."
          : `The page reads:\n${shown.slice(0, 400)}`),
      );
    }
    /*
     * Only while the placeholder is up — see the header. A page that has taken
     * the definition is rendering, and interrupting it is how you turn slow
     * into never.
     */
    if (PLACEHOLDER.test(shown) && Date.now() - lastPost > 2000) {
      await post();
      posts += 1;
      lastPost = Date.now();
    }
    await page.waitForTimeout(150);
  }
}

/** goto + hand over, the whole sequence every suite was writing by hand. */
export async function openPreview(browser, runtime, payload, opts = {}) {
  const pv = await browser.newPage({ viewport: opts.viewport ?? { width: 1000, height: 1000 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${runtime}/preview${opts.search ?? ""}`, { waitUntil: "networkidle" });
  await sendPreview(pv, payload, opts);
  return pv;
}
