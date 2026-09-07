/**
 * HANDING A DEFINITION TO THE RUNTIME PREVIEW, RELIABLY.
 *
 * ## The flake this exists to kill
 *
 * `/preview` is postMessage-driven, and it registers its `message` listener
 * inside a `useEffect` — so the listener does not exist until React has
 * hydrated. A test that does
 *
 *     await page.goto(`${runtime}/preview`, { waitUntil: "networkidle" });
 *     await page.evaluate((d) => window.postMessage({ … }, "*"), def);
 *     await page.waitForSelector("[data-qid]");
 *
 * is betting that hydration finishes before `networkidle` resolves. Usually it
 * does. Under a long corpus run — a warm dev server, 54 suites of compiled
 * chunks, a fresh Chromium per suite — sometimes it does not, the message lands
 * with nobody listening, and it is gone for good: nothing ever re-sends it, so
 * the page sits on "Waiting for survey definition…" until the 30s selector
 * timeout fires. That is exactly how `listfill-test.mjs` and `masking-test.mjs`
 * failed in the corpus while passing on their own.
 *
 * ## Why the fix belongs here and not in the product
 *
 * The Studio does not have this bug. `previewWindow.ts` waits for the page's
 * `rescript:preview-ready` message AND nudges the definition across seven
 * times over ~2.8 seconds. Only the tests post exactly once. So the missing
 * retry is the harness's, and putting it in the product would be fixing the
 * wrong thing.
 *
 * ## What it does
 *
 * Posts, waits a short while for the page to render, and posts again if it has
 * not — up to a generous total. Re-posting is harmless: the page's handler
 * just parses the definition again, and the loop stops the moment the selector
 * appears, so a preview that is already up is never re-sent.
 */

/**
 * @param {import("playwright").Page} page   a page already on /preview
 * @param {object} payload                   the `rescript:preview` message body,
 *                                           minus `type` — `{ definition, startAt?, answers?, … }`
 * @param {object} [opts]
 * @param {string} [opts.selector="[data-qid]"]  what proves the definition arrived
 * @param {number} [opts.timeout=45000]          total budget
 */
export async function sendPreview(page, payload, opts = {}) {
  const selector = opts.selector ?? "[data-qid]";
  const budget = opts.timeout ?? 45_000;
  const deadline = Date.now() + budget;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    await page.evaluate(
      (p) => window.postMessage({ type: "rescript:preview", ...p }, "*"),
      payload,
    );
    try {
      await page.waitForSelector(selector, { timeout: 1500 });
      return page;
    } catch {
      if (Date.now() >= deadline) {
        /*
         * Say what actually went wrong. A bare selector timeout sends the
         * reader looking for a rendering bug; nine tenths of the time the page
         * is still showing its placeholder, which means the definition never
         * landed or was rejected by the schema.
         */
        const shown = await page
          .evaluate(() => document.body.innerText.slice(0, 400))
          .catch(() => "(page unreadable)");
        throw new Error(
          `the preview never rendered ${selector} after ${attempts} handoffs in ${budget}ms.\n`
          + `The page currently reads:\n${shown}`,
        );
      }
    }
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
