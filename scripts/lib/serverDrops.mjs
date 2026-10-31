/**
 * WHEN THE DEV SERVER, NOT THE PRODUCT, FAILED A BROWSER SUITE.
 *
 * The sandbox keeps its operations, tasks and change numbers in the dev
 * server's memory. `next dev` restarts itself when its heap passes 80% of
 * `--max-old-space-size` ("Server is approaching the used memory threshold,
 * restarting..."), and the kernel OOM-kills it when the machine's memory
 * cgroup is full. Either one, mid-suite, aborts the requests in flight and
 * wipes those stores, and the next assertion fails with a message that reads
 * like a product bug — copilot-test.mjs's "AI Change (not numbered)" on
 * 2026-10-30 was exactly this (the status PATCH that numbers a change died
 * with the server; 7ab9bdd, the last commit recorded green, failed the same
 * way on the same machine and passed 11/11 once the server had the memory).
 *
 * `watchServerDrops(page)` records every request to the Studio's own origin
 * that failed at the connection level, and when the suite exits non-zero it
 * says so beside the assertion: the failure after that point is
 * environmental until the suite fails again on a server that stayed up.
 */

const DROPS = /^net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED)$/;

/** a request to `origin` that failed because the server went away (not a 4xx/5xx, not an abort by the page) */
export function isServerDrop(url, errorText, origin) {
  if (!errorText || !DROPS.test(errorText)) return false;
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

/** the note printed when a suite fails after the server dropped connections or the browser died */
export function dropNote(drops, browserLost = null) {
  if (!drops.length && !browserLost) return "";
  const lines = [];
  if (drops.length) {
    const first = drops[0];
    lines.push(`  NOTE  the Studio dev server dropped ${drops.length} request${drops.length === 1 ? "" : "s"} during this run — first at ${first.at}: ${first.method} ${first.path} (${first.error}).`);
    lines.push("        A dev-server restart (heap past 80% of --max-old-space-size) or an OOM kill (dmesg) wipes the sandbox's in-memory stores;");
  }
  if (browserLost) lines.push(`  NOTE  the browser ${browserLost.what} at ${browserLost.at} — usually an OOM kill (check dmesg), not the page.`);
  lines.push("        a failure after that point is environmental until it repeats on a server that stayed up.");
  return lines.join("\n");
}

export function watchServerDrops(page, origin = process.env.STUDIO_URL ?? "http://localhost:3000") {
  const drops = [];
  page.on("requestfailed", (r) => {
    const error = r.failure()?.errorText ?? "";
    if (!isServerDrop(r.url(), error, origin)) return;
    const u = new URL(r.url());
    drops.push({ at: new Date().toISOString(), method: r.method(), path: u.pathname, error });
  });
  let lost = null;
  const lose = (what) => { lost ??= { what, at: new Date().toISOString() }; };
  page.on("crash", () => lose("tab crashed"));
  page.context().browser()?.on("disconnected", () => lose("disconnected"));
  process.on("exit", (code) => { if (code !== 0 && (drops.length || lost)) console.error(dropNote(drops, lost)); });
  return drops;
}
