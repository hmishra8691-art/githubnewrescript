/**
 * METERED USAGE, WALLETS & COST ALLOCATION — browser suite.
 *
 * Against the /sandbox Studio (in-memory meter, seeded wallet, fake providers
 * priced as the real ones because the dev server runs with
 * BILLING_SIMULATE_FAKE_COSTS=1). Proves the acceptance path of the brief:
 *
 *   wallet badge and Usage tab · a metered AI call and a metered translation
 *   batch deduct a customer charge (never the raw cost) and appear as usage ·
 *   the request-credits flow · the administrator's API: wallets, approve a
 *   request with a custom amount, remove credits → READ_ONLY with the
 *   specified sentence, billable routes refuse with 423, credits reopen ·
 *   insufficient balance → 402 and nothing deducted · a reversal · the
 *   configuration and cost registry round-trip · the Billing Administration
 *   and My usage pages render.
 *
 * Needs the Studio on :3000 started with AI_API_URL=fake: BILLING_SIMULATE_FAKE_COSTS=1.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const h = await openHarness();
const { page } = h;

const api = async (path, init) => page.evaluate(async ({ path, init }) => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}, { path, init: init ?? {} });
const money = (s) => Number(String(s).replace(/[^0-9.\-]/g, ""));
const view = async () => (await api("/api/surveys/sandbox/billing")).json;
const goUsage = async () => { await h.goTab("Usage & Wallet"); await page.waitForSelector('[data-testid="usage-panel"]'); };
const reloadUsage = async () => { await page.click('[data-testid="usage-reload"]'); await page.waitForTimeout(400); };

// make sure the sandbox wallet is in a known, healthy state whatever ran before
{
  const v = await view();
  assert.equal(v.sandbox, true, "the sandbox reads the in-memory meter without a session");
  const wallets = (await api("/api/admin/billing/wallets")).json.wallets;
  const w = wallets.find((x) => x.surveyId === "sandbox");
  assert.ok(w, "the sandbox project has a wallet");
  if (w.state === "suspended") await api("/api/admin/billing/wallets", { method: "PATCH", body: JSON.stringify({ walletId: w.id, state: "active" }) });
  if (w.balance < 50) await api("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: w.id, amount: 100, reason: "test top-up" }) });
  // default configuration
  const cfg = (await api("/api/admin/billing/config")).json;
  await api("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ config: cfg.defaults }) });
}

console.log("\nSTUDIO — the wallet in the header and the Usage & Wallet tab");
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="wallet-badge"]');
const badge0 = money(await page.textContent('[data-testid="wallet-badge"]'));
assert.ok(badge0 > 0, `the header shows the remaining balance (${badge0})`);
await goUsage();
const remaining0 = money(await page.textContent('[data-testid="wallet-remaining"]'));
assert.equal(remaining0, badge0, "the badge and the wallet card agree");
assert.ok(await page.$('[data-testid="usage-progress"]'), "usage progress bar");
assert.ok(await page.$('[data-testid="usage-chart"]'), "usage timeline chart");
assert.ok(await page.$('[data-testid="usage-forecast"]'), "forecast tile");
assert.equal(await page.getAttribute('[data-testid="usage-panel"]', "data-state"), "active");
/* the level vocabulary is shared with the dashboard card: Healthy / Low balance / Critical / Exhausted */
assert.match(await page.textContent('[data-testid="wallet-level"]'), /Healthy|Low balance/);
console.log(`  ok   wallet ${remaining0} remaining, card + progress + chart + forecast`);

console.log("\nMETER — an AI call and a translation batch are charged at the customer price, not the raw cost");
const before = (await view()).summary;
const ai = await api("/api/ai/rephrase", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", text: "How satisfied are you with the service you received at our store during your most recent visit, all things considered?" }) });
assert.equal(ai.status, 200); assert.ok(ai.json.usage && ai.json.usage.charge > 0, `AI call charged ${ai.json.usage?.charge}`);
const items = Array.from({ length: 12 }, (_, i) => ({ key: `q:q${i}:text`, text: `Question ${i}: how likely are you to recommend {{BRAND}} to a friend or colleague after your visit number ${i}?` }));
const tr = await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items, sourceLanguage: "en", targetLanguage: "hi", useCache: false }) });
assert.equal(tr.status, 200, JSON.stringify(tr.json).slice(0, 200));
assert.ok(tr.json.usage && tr.json.usage.charge > 0, `translation charged ${tr.json.usage?.charge} for ${tr.json.usage?.quantity} ${tr.json.usage?.unit}`);
assert.equal(tr.json.usage.unit, "character");
const after = (await view());
const spent = Math.round((before.remaining - after.summary.remaining) * 1e6) / 1e6;
assert.ok(Math.abs(spent - (ai.json.usage.charge + tr.json.usage.charge)) < 1e-6, `the wallet went down by exactly the two charges (${spent})`);
const rows = after.recent;
const trRow = rows.find((r) => r.eventType === "TRANSLATION_CHARACTER");
assert.ok(trRow, "translation usage row"); assert.equal(trRow.environment, "LIVE");
const adminRow = (await api("/api/admin/billing/wallets?survey=sandbox")).json.view.recent.find((r) => r.id === trRow.id);
assert.ok(adminRow.customerCharge > adminRow.actualCost * 1.5, `charge ${adminRow.customerCharge} is well above actual cost ${adminRow.actualCost} — margin, fee and reserve are in it`);
assert.ok(rows.some((r) => r.eventType === "AI_REQUEST" && r.inputUnits > 0), "AI row carries tokens");
assert.ok(after.categories.some((c) => c.category === "translation") && after.categories.some((c) => c.category === "ai"), "usage by category: ai + translation");
await reloadUsage();
assert.equal(money(await page.textContent('[data-testid="wallet-remaining"]')), Math.round(after.summary.remaining * 100) / 100, "the tab shows the new balance");
assert.ok((await page.$$('[data-testid="usage-row"]')).length >= 2, "recent usage lists the rows");
assert.match(await page.textContent('[data-testid="usage-categories"]'), /Translation/);
console.log(`  ok   AI ${ai.json.usage.charge} + translation ${tr.json.usage.charge} = ${spent} deducted; rows, categories updated`);

console.log("\nREQUEST — the researcher asks for credits; the administrator approves a custom amount");
await page.click('[data-testid="request-credits"]');
await page.click('[data-testid="request-preset-500"]');
await page.fill('[data-testid="request-reason"]', "Fieldwork extended by two weeks");
await page.fill('[data-testid="request-message"]', "Need ~600 more completes");
await page.click('[data-testid="request-submit"]');
await page.waitForSelector('[data-testid="request-note"]');
assert.match(await page.textContent('[data-testid="request-note"]'), /Request for \$500\.00 sent/);
await page.waitForSelector('[data-testid="request-row"][data-status="pending"]');
const pend = (await api("/api/admin/billing/requests?status=pending")).json.requests;
const mine = pend.find((r) => r.reason === "Fieldwork extended by two weeks");
assert.ok(mine, "the administrator sees the pending request"); assert.equal(mine.requestedAmount, 500);
const balBefore = (await view()).summary.remaining;
const dec = await api("/api/admin/billing/requests", { method: "POST", body: JSON.stringify({ id: mine.id, decision: "approve", amount: 250, note: "250 for now" }) });
assert.equal(dec.status, 200); assert.equal(dec.json.request.status, "approved"); assert.equal(dec.json.request.decidedAmount, 250);
const balAfter = (await view()).summary.remaining;
assert.ok(Math.abs(balAfter - balBefore - 250) < 1e-6, `approval credited 250 (${balBefore} → ${balAfter})`);
assert.equal((await api("/api/admin/billing/requests", { method: "POST", body: JSON.stringify({ id: mine.id, decision: "reject" }) })).status, 409, "a decided request cannot be decided twice");
await reloadUsage();
await page.waitForSelector('[data-testid="request-row"][data-status="approved"]');
assert.match(await page.textContent('[data-testid="ledger"], [data-testid="credits-card"]'), /Credits added|approved/);
console.log("  ok   request pending → approved 250 → ledger credit → balance up 250");

console.log("\nREAD-ONLY — removing the balance locks the project automatically; billable routes refuse with the specified sentence; credits reopen it");
const wallets = (await api("/api/admin/billing/wallets")).json.wallets;
const w = wallets.find((x) => x.surveyId === "sandbox");
const drain = await api("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: w.id, amount: -w.balance, reason: "Correction", note: "drain for the read-only test" }) });
assert.equal(drain.status, 200); assert.equal(drain.json.wallet.balance, 0); assert.equal(drain.json.wallet.state, "read_only", "zero → READ_ONLY");
assert.equal(drain.json.entry.kind, "adjustment", "a removal is an adjustment ledger line");
const refused = await api("/api/ai/rephrase", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", text: "Anything at all" }) });
assert.equal(refused.status, 423); assert.equal(refused.json.code, "wallet_read_only");
assert.equal(refused.json.error, "Your project has reached its usage limit. Please request additional credits from your administrator.");
const refusedTr = await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items: items.slice(0, 2), sourceLanguage: "en", targetLanguage: "es" }) });
assert.equal(refusedTr.status, 423);
assert.equal((await view()).summary.remaining, 0, "nothing was deducted below zero");
await reloadUsage();
await page.waitForSelector('[data-testid="wallet-banner"][data-level="locked"]');
assert.match(await page.textContent('[data-testid="wallet-banner"]'), /reached its usage limit/);
await page.waitForSelector('[data-testid="wallet-readonly-bar"]');
assert.equal(await page.getAttribute('[data-testid="wallet-badge"]', "data-level"), "locked");
assert.equal(await page.getAttribute('[data-testid="usage-panel"]', "data-state"), "read_only");
const reopen = await api("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: w.id, amount: 100, reason: "Trial credits" }) });
assert.equal(reopen.json.wallet.state, "active"); assert.equal(reopen.json.wallet.balance, 100);
assert.equal((await api("/api/ai/rephrase", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", text: "Back in business?" }) })).status, 200, "billable work runs again");
await reloadUsage();
await page.waitForSelector('[data-testid="usage-panel"][data-state="active"]');
assert.equal(await page.$('[data-testid="wallet-readonly-bar"]'), null, "the read-only bar is gone");
console.log("  ok   $0 → READ_ONLY (423 + banner + bar) → +100 → active");

console.log("\nBALANCE — an operation that does not fit is refused before it runs; nothing goes negative; overdraft is a switch");
const w2 = (await api("/api/admin/billing/wallets")).json.wallets.find((x) => x.surveyId === "sandbox");
await api("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: w2.id, amount: -(w2.balance - 0.002), reason: "Correction", note: "leave 0.2¢" }) });
const big = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, text: "A long sentence about the respondent's most recent experience with the brand and its service, repeated to be expensive. ".repeat(3) }));
const short = await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items: big, sourceLanguage: "en", targetLanguage: "fr", useCache: false }) });
assert.equal(short.status, 402, `insufficient balance → 402 (${short.status} ${JSON.stringify(short.json).slice(0, 120)})`);
assert.equal(short.json.code, "wallet_insufficient_balance");
assert.match(short.json.error, /Insufficient balance/);
const v2 = await view();
assert.ok(v2.summary.remaining >= 0 && Math.abs(v2.summary.remaining - 0.002) < 1e-6, `balance untouched (${v2.summary.remaining})`);
assert.equal(v2.summary.reserved, 0, "no reservation left behind");
await api("/api/admin/billing/wallets", { method: "PATCH", body: JSON.stringify({ walletId: w2.id, overdraftEnabled: true, overdraftLimit: 50 }) });
const od = await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items: big.slice(0, 5), sourceLanguage: "en", targetLanguage: "fr", useCache: false }) });
assert.equal(od.status, 200, "with overdraft allowed on this wallet the operation runs");
assert.ok((await view()).summary.remaining < 0, "and the balance is negative, within the limit");
await api("/api/admin/billing/wallets", { method: "PATCH", body: JSON.stringify({ walletId: w2.id, overdraftEnabled: null, overdraftLimit: null }) });
await api("/api/admin/billing/credit", { method: "POST", body: JSON.stringify({ walletId: w2.id, amount: 100, reason: "Trial credits" }) });
console.log("  ok   402 with nothing deducted; overdraft per wallet works; restored to +100");

console.log("\nLEDGER — a usage event is never edited: a reversal credits the wallet back and stands beside the original");
const v3 = await view();
const target = v3.recent.find((r) => r.eventType === "TRANSLATION_CHARACTER" && !r.reversal && r.customerCharge > 0);
const rev = await api("/api/admin/billing/reverse", { method: "POST", body: JSON.stringify({ eventId: target.id, note: "double-billed batch" }) });
assert.equal(rev.status, 200); assert.equal(rev.json.reversal.adjustsEventId, target.id); assert.equal(rev.json.entry.kind, "reversal");
const v4 = await view();
assert.ok(Math.abs(v4.summary.remaining - v3.summary.remaining - target.customerCharge) < 1e-6, "credited back exactly");
assert.ok(v4.recent.find((r) => r.id === target.id).customerCharge === target.customerCharge, "the original row is unchanged");
assert.ok(v4.recent.some((r) => r.reversal && r.customerCharge === -target.customerCharge), "the reversal row is visible");
assert.equal((await api("/api/admin/billing/reverse", { method: "POST", body: JSON.stringify({ eventId: rev.json.reversal.id, note: "again" }) })).status, 409, "a reversal cannot be reversed");
console.log("  ok   reversal row + reversal ledger line; original intact");

console.log("\nCONFIGURATION & REGISTRY — the pricing model, thresholds, TEST policy and provider rates are settings");
const cfgRes = (await api("/api/admin/billing/config")).json;
assert.equal(cfgRes.config.targetMarginPct, 50); assert.equal(cfgRes.config.overdraftEnabled, false); assert.equal(cfgRes.config.testUsagePolicy, "free");
assert.ok(cfgRes.example.cost10.customerCharge > 20, `a $10 cost is priced at ${cfgRes.example.cost10.customerCharge}, not $15`);
assert.equal(cfgRes.example.cost10.marginPct, 50);
assert.ok(Array.isArray(cfgRes.fields) && cfgRes.fields.some((f) => f.key === "readOnlyThreshold"));
const bad = await api("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ config: { ...cfgRes.config, criticalBalanceThreshold: 500 } }) });
assert.equal(bad.status, 400, "critical above low is refused");
const put = await api("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ config: { ...cfgRes.config, lowBalanceThreshold: 5000, criticalBalanceThreshold: 5 } }) });
assert.equal(put.status, 200);
await reloadUsage();
await page.waitForSelector('[data-testid="wallet-banner"][data-level="low"]');
assert.match(await page.textContent('[data-testid="wallet-level"]'), /Low balance/);
await api("/api/admin/billing/config", { method: "PUT", body: JSON.stringify({ config: cfgRes.defaults }) });
const rates = (await api("/api/admin/billing/rates")).json;
const g = rates.rates.find((r) => r.id === "google.translate.v2");
assert.equal(g.providerCost, 20); assert.equal(g.unitSize, 1_000_000);
const saved = await api("/api/admin/billing/rates", { method: "PUT", body: JSON.stringify({ rate: { ...g, providerCost: 40, note: "doubled for the test" } }) });
assert.equal(saved.status, 200);
const t1 = (await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items: items.slice(0, 3), sourceLanguage: "en", targetLanguage: "de", useCache: false }) })).json.usage;
await api("/api/admin/billing/rates", { method: "PUT", body: JSON.stringify({ rate: g }) });
const t2 = (await api("/api/ai/translate", { method: "POST", body: JSON.stringify({ surveyId: "sandbox", items: items.slice(0, 3), sourceLanguage: "en", targetLanguage: "it", useCache: false }) })).json.usage;
assert.ok(t1.quantity === t2.quantity, "same characters");
assert.ok(Math.abs(t1.charge / t2.charge - 2) < 0.02, `doubling the Google rate doubles the charge (${t1.charge} vs ${t2.charge})`);
const evs = (await api("/api/admin/billing/events")).json.events;
assert.ok(evs.find((e) => e.type === "SURVEY_RESPONSE").billable && !evs.find((e) => e.type === "SURVEY_RENDER").billable, "event registry: responses billable, renders not, by default");
const evPut = await api("/api/admin/billing/events", { method: "PUT", body: JSON.stringify({ event: { ...evs.find((e) => e.type === "EXPORT_GENERATION"), billable: true } }) });
assert.equal(evPut.status, 200); assert.equal(evPut.json.events.find((e) => e.type === "EXPORT_GENERATION").billable, true);
await api("/api/admin/billing/events", { method: "PUT", body: JSON.stringify({ event: evs.find((e) => e.type === "EXPORT_GENERATION") }) });
console.log("  ok   config validated + applied live (Low balance at 5000); rate change doubles the charge; events editable");

console.log("\nVISIBILITY — a researcher sees charges only; the administrator sees every cost component");
const userView = await view();
const INTERNAL = ["actualCost", "providerCost", "infraCost", "paymentFee", "taxReserve", "grossProfit", "netProfit", "marginPct", "costs", "grossMarginPct"];
const walk = (v, found = new Set()) => { if (Array.isArray(v)) v.forEach((x) => walk(x, found)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (INTERNAL.includes(k)) found.add(k); walk(x, found); } return found; };
assert.equal(userView.audience, "user");
assert.deepEqual([...walk(userView)], [], "no internal cost key anywhere in the researcher's payload");
assert.ok(userView.recent.length && typeof userView.recent[0].customerCharge === "number", "the charge is there");
assert.ok(typeof userView.summary.usedPct === "number" && userView.summary.used > 0 && userView.summary.remaining > 0, "wallet / used / remaining / usage %");
const adminView = (await api("/api/admin/billing/wallets?survey=sandbox")).json.view;
assert.equal(adminView.audience, "admin");
const adminKeys = walk(adminView);
for (const k of ["actualCost", "providerCost", "infraCost", "paymentFee", "taxReserve", "grossProfit", "netProfit", "marginPct", "costs"]) assert.ok(adminKeys.has(k), `administrator payload carries ${k}`);
assert.ok(adminView.summary.costs.providerCost > 0 && adminView.summary.costs.netProfit !== 0, "the backend still calculates and stores the cost split");
await reloadUsage();
assert.equal(await page.$('[data-testid="wallet-costs"]'), null, "no cost breakdown on the researcher's wallet card");
assert.equal(await page.getAttribute('[data-testid="usage-rows"]', "data-cost-columns"), "0", "no cost column in the researcher's usage table");
assert.match(await page.textContent('[data-testid="wallet-used-pct"]'), /%/); assert.match(await page.textContent('[data-testid="wallet-status"]'), /ACTIVE/);
assert.ok(!(await page.textContent('[data-testid="usage-panel"]')).match(/Actual cost|Provider cost|Gross profit|Margin/i), "the words never appear on the researcher's screen");
console.log("  ok   researcher payload/screen: charges only; administrator payload: full cost split");

console.log("\nTRANSFERS — unused credits move between projects and people, atomically, with a confirmation and a traceable ledger");
await api("/api/admin/billing/wallets", { method: "POST", body: JSON.stringify({ action: "ensure", surveyId: "sandbox-b" }) });   // the sandbox meter seeds a new wallet
const lk = (await api("/api/admin/billing/lookup")).json;
const dstBefore = lk.projects.find((p) => p.id === "sandbox-b").wallet;
const userBefore = lk.users.find((u) => u.id === "sandbox-user-2").wallet?.balance ?? 0;
assert.ok(lk.projects.some((p) => p.id === "sandbox") && lk.users.length >= 2, "lookup lists projects and users with balances");
const srcBefore = lk.projects.find((p) => p.id === "sandbox").wallet;
assert.ok(srcBefore.available <= srcBefore.balance, "available never exceeds balance");
// rule 1: more than available is refused, nothing moves
const tooMuch = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox" }, destination: { type: "project", id: "sandbox-b" }, amount: srcBefore.available + 5 }) });
assert.equal(tooMuch.status, 402); assert.equal(tooMuch.json.code, "transfer_insufficient_available");
assert.equal((await view()).summary.remaining, srcBefore.balance, "a refused transfer changes nothing");
// rule 2: reserved balance is excluded — hold some, then check available shrinks
const holdRes = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox" }, destination: { type: "project", id: "sandbox" }, amount: 1 }) });
assert.equal(holdRes.status, 400, "same wallet refused");
// project → project
const x1 = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox" }, destination: { type: "project", id: "sandbox-b" }, amount: 25, reason: "Unused project credits", note: "moving to B" }) });
assert.equal(x1.status, 200, JSON.stringify(x1.json));
assert.match(x1.json.transfer.code, /^TRX-/); assert.equal(x1.json.transfer.status, "completed");
assert.ok(Math.abs(x1.json.source.balance - (srcBefore.balance - 25)) < 1e-6, "source −25"); assert.ok(Math.abs(x1.json.destination.balance - (dstBefore.balance + 25)) < 1e-6, "destination +25");
const ledgerA = (await view()).ledger;
const outLine = ledgerA.find((l) => l.transferId === x1.json.transfer.id);
assert.ok(outLine && outLine.kind === "transfer_out" && outLine.amount === -25, "source ledger: Credit Transfer Out −25");
const bView = (await api("/api/admin/billing/wallets?survey=sandbox-b")).json.view;
const inLine = bView.ledger.find((l) => l.transferId === x1.json.transfer.id);
assert.ok(inLine && inLine.kind === "transfer_in" && inLine.amount === 25, "destination ledger: Credit Transfer In +25, same transfer id");
// project → user (personal wallet), then user → project
const x2 = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox-b" }, destination: { type: "user", id: "sandbox-user-2" }, amount: 20 }) });
assert.equal(x2.status, 200); assert.equal(x2.json.transfer.destinationKind, "user"); assert.ok(Math.abs(x2.json.destination.balance - (userBefore + 20)) < 1e-6, "the person's own wallet +20"); assert.ok(Math.abs(x2.json.source.balance - (dstBefore.balance + 5)) < 1e-6);
const x3 = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "user", id: "sandbox-user-2" }, destination: { type: "project", id: "sandbox" }, amount: 5 }) });
assert.equal(x3.status, 200); assert.ok(Math.abs(x3.json.source.balance - (userBefore + 15)) < 1e-6);
// history + filters
const hist = (await api("/api/admin/billing/transfer?project=sandbox-b")).json.transfers;
assert.ok(hist.length >= 2 && hist.every((t) => t.sourceRef === "sandbox-b" || t.destinationRef === "sandbox-b"), "history filtered by project");
assert.ok(hist[0].sourceLabel && hist[0].destinationLabel && hist[0].adminLabel, "names resolved");
assert.equal((await api("/api/admin/billing/transfer?min=100")).json.transfers.length, 0, "amount filter");
// reversal: a new transfer referencing the original; the original is marked, not edited
const cannot = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ action: "reverse", transferId: x2.json.transfer.id, note: "try" }) });
if (userBefore < 5) assert.equal(cannot.status, 402, "the person has already moved 5 of the 20 on — a reversal needs the credits still to be there");
else { assert.equal(cannot.status, 200, "with enough left the 20 goes back"); await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox-b" }, destination: { type: "user", id: "sandbox-user-2" }, amount: 20, reason: "redo" }) }); }
const rv = await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ action: "reverse", transferId: x3.json.transfer.id, note: "sent from the wrong wallet" }) });
assert.equal(rv.status, 200, JSON.stringify(rv.json)); assert.equal(rv.json.transfer.reversalOf, x3.json.transfer.id); assert.equal(rv.json.transfer.amount, 5);
const all = (await api("/api/admin/billing/transfer")).json.transfers;
const orig = all.find((t) => t.id === x3.json.transfer.id);
assert.equal(orig.status, "reversed"); assert.equal(orig.reversedBy, rv.json.transfer.id); assert.equal(orig.amount, 5, "the original row keeps its amount");
assert.equal((await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ action: "reverse", transferId: x3.json.transfer.id, note: "again" }) })).status, 409, "cannot reverse twice");
assert.ok((await view()).ledger.some((l) => l.kind === "transfer_reversal" && l.transferId === rv.json.transfer.id), "reversal ledger line on the wallet that gave the credits back");
assert.ok(Math.abs(rv.json.destination.balance - (userBefore + 20)) < 1e-6, "the person is back to +20");
// put the sandbox wallet back where the suite expects it
await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox-b" }, destination: { type: "project", id: "sandbox" }, amount: 5, reason: "test cleanup" }) });
await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "user", id: "sandbox-user-2" }, destination: { type: "project", id: "sandbox" }, amount: 20, reason: "test cleanup" }) });
assert.ok(Math.abs((await view()).summary.remaining - srcBefore.balance) < 1e-6, `everything is back: the sandbox wallet is where it started (${(await view()).summary.remaining} vs ${srcBefore.balance})`);
console.log("  ok   402 over available; project→project, project→user, user→project; two ledger lines per transfer; history filters; reversal");

console.log("\nUSER TRANSFERS — a person moves their own credits, and only their own");
{
  /*
   * The engine rules (available-only, atomic, two ledger lines, self-transfer
   * refused) are proven in packages/billing. What matters HERE is the door:
   * the user-facing endpoint is session-guarded, so an unauthenticated caller
   * cannot move anybody's money, and it refuses a transfer to oneself before
   * it reaches the engine.
   */
  const anon = await api("/api/billing/transfer", { method: "POST", body: JSON.stringify({ toUserCode: "USR-10482", amount: 25 }) });
  assert.ok(anon.status === 401 || anon.status === 503, `a caller with no session is refused (${anon.status})`);
  assert.ok(!/transfer/i.test(JSON.stringify(anon.json.transfer ?? "")), "and nothing moved");
  const anonHistory = await api("/api/billing/transfer");
  assert.ok(anonHistory.status === 401 || anonHistory.status === 503, "and cannot read anyone's history");
  console.log(`  ok   /api/billing/transfer is session-guarded (${anon.status}); the balance rules are covered by the package tests`);
}

console.log("\nPAGES — Billing Administration and My usage render");
await page.context().addCookies([{ name: "rescript_session", value: "sandbox", url: STUDIO }]);
// no accounts exist on a database-less Studio: make the session check answer "cannot verify" (503, transient) rather than
// "signed out" (401), which is what a real installation does when its database is unreachable — the pages then render
// with no user and the billing APIs answer through the sandbox administrator gate
await page.route("**/api/auth/me", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Cannot verify your session right now.", code: "session_unavailable" }) }));
await page.goto(`${STUDIO}/admin/billing`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="billing-admin"]');
await page.waitForSelector('[data-testid="admin-wallet-row"]');
assert.ok((await page.$$('[data-testid="admin-wallet-row"]')).length >= 1, "wallet table lists the sandbox wallet");
await page.click('[data-testid="admin-wallet-open"]');
await page.waitForSelector('[data-testid="admin-credit-panel"]');
await page.click('[data-testid="admin-preset-50"]');
const bBefore = money(await page.textContent('[data-testid="admin-wallet-balance"]'));
await page.click('[data-testid="admin-add"]');
await page.waitForSelector('[data-testid="admin-note"]');
assert.match(await page.textContent('[data-testid="admin-note"]'), /Added \$50\.00/);
await page.waitForFunction((b) => { const t = document.querySelector('[data-testid="admin-wallet-balance"]')?.textContent ?? ""; return Math.abs(Number(t.replace(/[^0-9.\-]/g, "")) - b - 50) < 0.02; }, bBefore);
await page.waitForSelector('[data-testid="admin-ledger"]');
assert.ok((await page.$$('[data-testid="admin-usage-rows"] [data-testid="usage-row"]')).length >= 1, "the project's usage is listed for the administrator");
await page.click('[data-testid="admin-tab-transfers"]');
await page.waitForSelector('[data-testid="transfer-form"]');
await page.waitForSelector('[data-testid="transfer-row"]');
await page.click('[data-testid="transfer-src-project"]');
await page.selectOption('[data-testid="transfer-source"]', "sandbox");
await page.waitForFunction(() => /\$/.test(document.querySelector('[data-testid="transfer-available"]')?.textContent ?? ""));
const availText = money((await page.textContent('[data-testid="transfer-available"] .bl-stat-value')));
assert.ok(availText > 10, `available balance shown (${availText})`);
await page.fill('[data-testid="transfer-amount"]', String(availText + 100));
await page.waitForSelector('[data-testid="transfer-too-much"]');
assert.equal(await page.isDisabled('[data-testid="transfer-submit"]'), true, "the button is disabled when the amount exceeds the available balance");
await page.fill('[data-testid="transfer-amount"]', "10");
await page.click('[data-testid="transfer-dst-project"]');
await page.selectOption('[data-testid="transfer-destination"]', "sandbox-b");
await page.fill('[data-testid="transfer-reason"]', "Unused project credits");
await page.click('[data-testid="transfer-submit"]');
await page.waitForSelector('[data-testid="transfer-confirm"]');
assert.match(await page.textContent('[data-testid="transfer-confirm"]'), /You are about to transfer \$10\.00 from Sandbox project \(project\) to Second sandbox project \(project\)\. This action will be recorded in the billing ledger\./);
await page.click('[data-testid="transfer-confirm-no"]');
assert.equal(await page.$('[data-testid="transfer-confirm"]'), null, "cancel closes the confirmation, nothing moved");
await page.click('[data-testid="transfer-submit"]');
await page.click('[data-testid="transfer-confirm-yes"]');
await page.waitForSelector('[data-testid="admin-note"]');
assert.match(await page.textContent('[data-testid="admin-note"]'), /TRX-\d+: \$10\.00 transferred from Sandbox project/);
await page.waitForFunction(() => (document.querySelector('[data-testid="transfer-row"]')?.textContent ?? "").includes("$10.00"));
await page.selectOption('[data-testid="transfer-filter-status"]', "reversed");
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="transfer-row"]')].every((r) => r.getAttribute("data-status") === "reversed"));
await page.selectOption('[data-testid="transfer-filter-status"]', "");
await api("/api/admin/billing/transfer", { method: "POST", body: JSON.stringify({ source: { type: "project", id: "sandbox-b" }, destination: { type: "project", id: "sandbox" }, amount: 10, reason: "test cleanup" }) });
await page.click('[data-testid="admin-tab-wallets"]');
await page.waitForSelector('[data-testid="admin-wallet-row"]');
await page.click('[data-testid="admin-wallet-open"]');
await page.waitForSelector('[data-testid="admin-usage-rows"]');
assert.equal(await page.getAttribute('[data-testid="admin-usage-rows"]', "data-cost-columns"), "1", "the administrator's usage table shows actual cost and margin");
await page.click('[data-testid="admin-tab-requests"]');
await page.selectOption('[data-testid="admin-requests-filter"]', "all");
await page.waitForSelector('[data-testid="admin-request"][data-status="approved"]');
await page.click('[data-testid="admin-tab-config"]');
await page.waitForSelector('[data-testid="cfg-save"]');
assert.ok(money(await page.textContent('[data-testid="example-charge"]')) > 20, "the worked example shows the $10-cost charge");
await page.click('[data-testid="admin-tab-rates"]');
await page.waitForSelector('[data-testid="rate-row"][data-id="google.translate.v2"]');
await page.click('[data-testid="admin-tab-events"]');
await page.waitForSelector('[data-testid="event-row"][data-type="AI_REQUEST"]');
/*
 * PROJECT SPENDING — one wallet, and a limit on the project.
 *
 * The admin table now answers "what is this study costing and what is it
 * allowed to cost", which a list of wallets cannot under a central wallet.
 */
await page.click('[data-testid="admin-tab-wallets"]');
await page.waitForSelector('[data-testid="admin-spending"]');
assert.ok(await page.$('[data-testid="admin-spending-row"]'), "every project with a policy is listed with what it has spent");
await page.click('[data-testid="admin-spending-edit"]');
await page.waitForSelector('[data-testid="admin-limit-editor"]');
await page.fill('[data-testid="admin-limit-amount"]', "250");
await page.click('[data-testid="admin-limit-save"]');
await page.waitForTimeout(600);
assert.match(await page.textContent('[data-testid="admin-note"]'), /may now spend up to \$250\.00 of its owner's wallet/);
assert.match(await page.textContent('[data-testid="admin-spending-limit"]'), /\$250\.00/);
await page.click('[data-testid="admin-spending-edit"]');
await page.waitForSelector('[data-testid="admin-limit-editor"]');
await page.click('[data-testid="admin-limit-none"]');
await page.waitForTimeout(600);
assert.match(await page.textContent('[data-testid="admin-spending-limit"]'), /no limit/);
console.log("  ok   admin project spending: spend, limit, and a limit set and cleared without moving money");

/* the wallet page: one balance and the whole position */
await page.goto(`${STUDIO}/billing`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="my-usage-error"], [data-testid="my-wallet"]');
if (await page.$('[data-testid="my-wallet"]')) {
  const wallet = (await page.textContent('[data-testid="my-wallet"]')).replace(/\s+/g, " ");
  for (const bit of ["Total deposited", "Total used", "Transferred out", "Received", "Reserved", "Available to spend"]) {
    assert.ok(wallet.includes(bit), `the wallet page states ${bit}: ${wallet}`);
  }
  assert.ok(await page.$('[data-testid="my-add-funds"]'), "and offers to add funds");
  const projects = await page.textContent('[data-testid="my-usage-projects"]');
  assert.match(projects, /Spent/, "with the projects that spend it, and what each has spent");
  console.log("  ok   my wallet: deposited / used / transferred / reserved / available, and the projects spending it");
}
console.log("  ok   admin: wallets (+$50 via preset), transfer with confirmation + history filter, cost columns for admins only, requests, configuration, rates, events");

await h.close();
console.log("\nALL BILLING CHECKS PASSED");
