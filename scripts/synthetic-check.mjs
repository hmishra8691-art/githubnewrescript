#!/usr/bin/env node
/**
 * THE SYNTHETIC CHECK (audit 2026-11-17, P1-13) — what a user would notice, checked before a user does.
 *
 *   STUDIO_URL / RUNTIME_URL / INTERVIEWS_URL   each app's /api/health must answer 200 with status ok or degraded
 *   SYNTHETIC_LIVE_LINK                         optional: a live survey link (e.g. a monitoring study) whose page must
 *                                               load with HTTP 200 and contain the runner, within the time budget
 *   ALERT_WEBHOOK_URL                           where a failure is posted (Slack-compatible `text` plus details);
 *                                               without it, failures are printed and the exit code is 1
 *   SYNTHETIC_BUDGET_MS                         slowest acceptable answer (default 8000)
 *
 * Exit 0 when everything passed, 1 otherwise. Run on a schedule by .github/workflows/synthetic.yml; it is inert
 * until the URLs are set as repository secrets.
 */
const env = process.env;
const BUDGET = Number(env.SYNTHETIC_BUDGET_MS ?? 8000);
const targets = [
  ["studio", env.STUDIO_URL], ["runtime", env.RUNTIME_URL], ["interviews", env.INTERVIEWS_URL],
].filter(([, u]) => u && u.trim());

async function timed(url) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BUDGET);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "rescript-synthetic-check" } });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: "", error: e.name === "AbortError" ? `no answer within ${BUDGET} ms` : String(e.message ?? e) };
  } finally { clearTimeout(timer); }
}

const failures = [];
const results = [];
for (const [app, base] of targets) {
  const url = `${base.replace(/\/+$/, "")}/api/health`;
  const r = await timed(url);
  let body = null; try { body = JSON.parse(r.text); } catch { /* not JSON */ }
  const failed = (body?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}${c.critical ? "" : " (non-critical)"}: ${c.detail ?? "failed"}`);
  const good = r.status === 200 && (body?.status === "ok" || body?.status === "degraded");
  results.push(`${good ? "ok  " : "FAIL"} ${app} health ${r.status || "-"} ${body?.status ?? r.error ?? "unreadable"} in ${r.ms} ms${failed.length ? ` — ${failed.join("; ")}` : ""}`);
  if (!good) failures.push(`${app}: /api/health answered ${r.status || r.error}${body?.status ? ` (${body.status})` : ""}${failed.length ? ` — ${failed.join("; ")}` : ""}`);
}
if (env.SYNTHETIC_LIVE_LINK) {
  const r = await timed(env.SYNTHETIC_LIVE_LINK);
  const good = r.status === 200 && /rs-shell|data-testid="rs-|__NEXT_DATA__|next\/static/.test(r.text);
  results.push(`${good ? "ok  " : "FAIL"} live link ${r.status || "-"} in ${r.ms} ms`);
  if (!good) failures.push(`the live survey link answered ${r.status || r.error} and ${good ? "" : "did not render the survey runner"}`);
}
if (!targets.length && !env.SYNTHETIC_LIVE_LINK) { console.log("synthetic check: no URLs configured (STUDIO_URL, RUNTIME_URL, INTERVIEWS_URL, SYNTHETIC_LIVE_LINK) — nothing to check"); process.exit(0); }

for (const l of results) console.log(l);
if (failures.length) {
  const text = `:rotating_light: Synthetic check failed (${failures.length}): ${failures.join(" · ")}`;
  if (env.ALERT_WEBHOOK_URL) {
    try {
      const r = await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, failures, results, at: new Date().toISOString() }) });
      console.log(`alert posted (${r.status})`);
    } catch (e) { console.log(`alert could not be posted: ${e.message}`); }
  } else console.log("ALERT_WEBHOOK_URL not set — the failure is only in this log");
  process.exit(1);
}
console.log(`synthetic check: ${results.length} passed`);
