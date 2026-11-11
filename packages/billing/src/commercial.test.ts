import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CATALOG, commercialCatalog, subscriptionCharge, responseCharge, classifyResponses, rechargeWallet, consumeWallet, aiWalletView,
  taxFor, buildInvoice, toCents, slabProblem, rate, aiCharge, estimateCost, profitability, type AiWalletState, type CommercialCatalog, type ResponseRecord,
} from "./commercial.js";

/*
 * THE COMMERCIAL MODEL (2026-11-11). Pinned: the approved prices, progressive slabs (never the top rate on everything),
 * the wallet's rules, tax from configuration only, and an invoice whose three categories and tax add up to the cent.
 * The tax rates below are TEST FIXTURES — the product ships with no rates.
 */
const C = DEFAULT_CATALOG;
const WITH_TAX: CommercialCatalog = commercialCatalog({ taxRules: [
  { country: "IN", name: "GST", ratePct: 18 },
  { country: "GB", name: "VAT", ratePct: 20, reverseChargeForBusiness: true },
  { country: "DE", name: "VAT", ratePct: 19, reverseChargeForBusiness: true },
  { country: "AU", name: "GST", ratePct: 10, appliesTo: ["subscription", "responses"] },
] });
const usd = (cents: number) => (cents / 100).toFixed(2);

test("the approved subscription prices: $39, $99 per user, $399 with five users, Enterprise by agreement only", () => {
  const sub = (planId: "academic" | "professional" | "team" | "enterprise", users?: number, negotiatedMonthly?: number) => subscriptionCharge(C, { planId, ...(users ? { users } : {}), ...(negotiatedMonthly != null ? { negotiatedMonthly } : {}) });
  assert.equal((sub("academic") as { totalCents: number }).totalCents, 3900);
  assert.equal((sub("professional") as { totalCents: number }).totalCents, 9900);
  assert.equal((sub("professional", 3) as { totalCents: number }).totalCents, 29700, "Professional is per user");
  const team = sub("team", 5) as { totalCents: number; includedUsers: number; description: string };
  assert.deepEqual([team.totalCents, team.includedUsers], [39900, 5]);
  assert.match(team.description, /5 users included/);
  assert.equal((sub("team", 2) as { totalCents: number }).totalCents, 39900, "fewer than five users is still the Team price");
  assert.match((sub("team", 7) as { error: string }).error, /additional users are by agreement/, "no additional-user price is invented");
  assert.match((sub("enterprise") as { error: string }).error, /priced by agreement/, "Enterprise is never billed at a standard price");
  assert.equal((sub("enterprise", 40, 4200) as { totalCents: number }).totalCents, 420000);
  /* the additional-user policy, once set by an administrator, is applied */
  const priced = commercialCatalog({ plans: C.plans.map((p) => (p.id === "team" ? { ...p, additionalUserMonthly: 60 } : p)) });
  assert.equal((subscriptionCharge(priced, { planId: "team", users: 7 }) as { totalCents: number }).totalCents, 39900 + 2 * 6000);
});

test("progressive response pricing: each rate applies only inside its own slab — 60,000 responses are $1,500", () => {
  const r = responseCharge(C, 60_000);
  assert.deepEqual(r.lines.map((l) => [l.label, l.responses, l.each, usd(l.cents)]), [["First 10,000", 10_000, 0.03, "300.00"], ["10,001–50,000", 40_000, 0.025, "1000.00"], ["50,001–250,000", 10_000, 0.02, "200.00"]]);
  assert.equal(r.totalCents, 150_000);
  assert.notEqual(r.totalCents, 60_000 * 2, "NOT the highest slab's rate on every response");
  assert.deepEqual([r.currentSlab, r.currentRate, r.nextThreshold, r.toNextThreshold], [2, 0.02, 250_000, 190_000]);
  /* the boundaries, and the calculator's volumes */
  for (const [n, cents] of [[0, 0], [1, 3], [1_000, 3_000], [5_000, 15_000], [10_000, 30_000], [10_001, 30_003], [25_000, 67_500], [50_000, 130_000], [50_001, 130_002], [100_000, 230_000], [250_000, 530_000], [250_001, 530_001], [500_000, 842_500], [1_000_000, 1_467_500]] as const) assert.equal(responseCharge(C, n).totalCents, cents, `${n} responses`);
  assert.equal(responseCharge(C, 10_000).currentSlab, 1, "the 10,001st response is the second slab's");
  assert.deepEqual([rate(0.03), rate(0.025), rate(0.02), rate(0.0125), rate(0.1)], ["0.03", "0.025", "0.02", "0.0125", "0.10"]);
});

test("incremental billing equals billing at once, whatever the split — even at rates finer than a cent", () => {
  const all = responseCharge(C, 263_417).totalCents;
  for (const split of [[1, 263_416], [9_999, 2, 253_416], [10_000, 40_000, 200_000, 13_417], [130_001, 133_416], Array(263_417 / 263_417 * 7).fill(37_631)]) {
    let billed = 0, sum = 0;
    for (const part of split) { sum += responseCharge(C, part, billed).totalCents; billed += part; }
    assert.equal(billed, 263_417); assert.equal(sum, all, split.join("+"));
  }
  /* one response at a time across the last threshold: 2.0 cents, then 1.25 — never lost to rounding */
  let billed = 249_995, sum = 0;
  for (let i = 0; i < 12; i++) { sum += responseCharge(C, 1, billed).totalCents; billed++; }
  assert.equal(sum, responseCharge(C, 12, 249_995).totalCents);
  const month = responseCharge(C, 5_000, 48_000);
  assert.deepEqual(month.lines.map((l) => [l.responses, l.each, l.cents]), [[2_000, 0.025, 5_000], [3_000, 0.02, 6_000]]);
});

test("customers are told when the next threshold is near; Enterprise can have its own rate card", () => {
  assert.equal(responseCharge(C, 9_500).approachingNext, true, "500 from 10,000 (within 10% of the slab)");
  assert.equal(responseCharge(C, 5_000).approachingNext, false);
  assert.equal(responseCharge(C, 300_000).nextThreshold, null);
  const agreed = [{ upTo: 100_000, each: 0.012 }, { upTo: null, each: 0.008 }];
  assert.equal(responseCharge(C, 150_000, 0, agreed).totalCents, 120_000 + 40_000);
  assert.equal(slabProblem([{ upTo: 100, each: 0.1 }]), "the last slab has no upper bound");
  assert.equal(slabProblem([{ upTo: 100, each: 0.1 }, { upTo: 50, each: 0.1 }, { upTo: null, each: 0.1 }]), "slab bounds must increase");
  assert.deepEqual(commercialCatalog({ responseSlabs: [{ upTo: 5, each: 1 }] }).responseSlabs, C.responseSlabs, "an invalid ladder is not used");
  /* the rates are configuration: an administrator's change is what is charged */
  assert.equal(responseCharge(commercialCatalog({ responseSlabs: [{ upTo: 1_000, each: 0.05 }, { upTo: null, each: 0.01 }] }), 3_000).totalCents, 5_000 + 2_000);
});

test("what is billable: a completed LIVE interview, once — not tests, partials, screen-outs, quota-fulls or duplicates", () => {
  const rec = (id: string, status: string, environment: "LIVE" | "TEST" = "LIVE", respondentKey?: string, projectId = "p1"): ResponseRecord => ({ id, projectId, environment, status, respondentKey });
  const u = classifyResponses([
    rec("a", "complete"), rec("b", "complete", "TEST"), rec("c", "in_progress"), rec("d", "screened"), rec("e", "quota_full"), rec("f", "terminated"),
    rec("a", "complete"), rec("g", "complete", "LIVE", "R7"), rec("h", "complete", "LIVE", "R7"), rec("i", "complete", "LIVE", "R7", "p2"), rec("j", "completed", "LIVE", undefined, "p2"),
  ]);
  assert.deepEqual(u.billable.map((r) => r.id), ["a", "g", "i", "j"]);
  assert.deepEqual(u.notBilled.map((x) => `${x.record.id}:${x.reason}`), ["b:test", "c:partial", "d:screened_out", "e:quota_full", "f:terminated", "a:duplicate", "h:duplicate"]);
  assert.deepEqual(u.byProject, { p1: 2, p2: 2 });
  /* a retry of something already billed in an earlier run is not billed again */
  assert.deepEqual(classifyResponses([rec("a", "complete"), rec("z", "complete")], new Set(["a"])).billable.map((r) => r.id), ["z"]);
});

test("the AI wallet: $50 minimum, each recharge valid 12 months from its own date, soonest-expiring spent first, never overdrawn", () => {
  let s: AiWalletState = { recharges: [] };
  assert.match((rechargeWallet(C, s, { id: "r0", amount: 49.99, at: "2026-01-10T00:00:00.000Z" }) as { error: string }).error, /minimum wallet recharge is USD 50\.00/);
  const top = (id: string, amount: number, at: string) => { const r = rechargeWallet(C, s, { id, amount, at }); assert.ok("state" in r); s = (r as { state: AiWalletState }).state; return (r as { recharge: { expiresAt: string } }).recharge; };
  assert.equal(top("r1", 50, "2026-01-10T00:00:00.000Z").expiresAt, "2027-01-10T00:00:00.000Z");
  assert.equal(top("r2", 120, "2026-06-30T00:00:00.000Z").expiresAt, "2027-06-30T00:00:00.000Z", "its own twelve months");
  assert.equal(top("r3", 75, "2028-02-29T00:00:00.000Z").expiresAt, "2029-02-28T00:00:00.000Z", "a leap day lands on the month's last day");
  s = { recharges: s.recharges.filter((r) => r.id !== "r3") };
  top("r1", 50, "2026-01-10T00:00:00.000Z");
  assert.equal(s.recharges.length, 2, "the same payment is one recharge");
  const use = (cents: number, at: string) => { const r = consumeWallet(s, cents, at); if ("state" in r) s = r.state; return r; };
  assert.deepEqual((use(6000, "2026-07-01T00:00:00.000Z") as { taken: unknown }).taken, [{ rechargeId: "r1", cents: 5000 }, { rechargeId: "r2", cents: 1000 }]);
  const short = use(11_001, "2026-07-02T00:00:00.000Z") as { error: string; availableCents: number };
  assert.match(short.error, /does not cover this operation/); assert.equal(short.availableCents, 11_000);
  assert.equal(s.recharges.find((r) => r.id === "r2")!.remainingCents, 11_000, "a refused charge takes nothing");
  /* a retried operation is one charge: the caller de-duplicates on its operation id, and a zero charge takes nothing */
  assert.deepEqual((use(0, "2026-07-02T00:00:00.000Z") as { taken: unknown[] }).taken, []);
  let v = aiWalletView(C, s, "2026-07-03T00:00:00.000Z");
  assert.deepEqual([v.availableCents, v.totalRechargedCents, v.consumedCents], [11_000, 17_000, 6_000]);
  assert.deepEqual(v.alerts, []);
  use(3_000, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(aiWalletView(C, s, "2026-08-02T00:00:00.000Z").alerts, ["Your AI wallet balance is at or below 50%."]);
  use(7_600, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(aiWalletView(C, s, "2026-09-02T00:00:00.000Z").alerts, ["Your AI wallet is nearly exhausted."]);
  /* expiry: what is left of a recharge after its twelve months cannot be spent, and is shown as expired */
  v = aiWalletView(C, s, "2027-06-10T00:00:00.000Z");
  assert.match(v.alerts.join(" "), /USD 4\.00 from the recharge of 2026-06-30 expires in 20 days/);
  v = aiWalletView(C, s, "2027-07-01T00:00:00.000Z");
  assert.deepEqual([v.availableCents, v.expiredCents], [0, 400]);
  assert.match((use(100, "2027-07-01T00:00:00.000Z") as { error: string }).error, /recharge to continue/);
  assert.equal(C.wallet.autoRecharge, false, "never recharged without the customer's authorisation");
});

test("tax comes from configuration only: no rule, no tax — and it is said; exemptions and reverse charge are honoured", () => {
  assert.deepEqual(C.taxRules, [], "the product ships with no tax rates");
  assert.equal(taxFor(C, { country: "IN" }, "subscription").reason, "not_configured");
  assert.equal(taxFor(WITH_TAX, { country: null }, "subscription").reason, "no_country");
  assert.deepEqual(taxFor(WITH_TAX, { country: "in" }, "subscription"), { country: "IN", name: "GST", ratePct: 18, applies: true, reason: "taxed" });
  assert.equal(taxFor(WITH_TAX, { country: "GB", business: true, taxId: "GB123456789" }, "responses").reason, "reverse_charge");
  assert.equal(taxFor(WITH_TAX, { country: "GB", business: true }, "responses").reason, "taxed", "a business without a registration is taxed");
  assert.equal(taxFor(WITH_TAX, { country: "DE", exempt: true }, "ai").reason, "exempt");
  assert.equal(taxFor(WITH_TAX, { country: "AU" }, "ai").reason, "category_not_taxed");
  assert.equal(taxFor(WITH_TAX, { country: "US" }, "subscription").reason, "not_configured");
});

test("the checkout example: Professional $99.00 + 18% = $17.82 → $116.82", () => {
  const inv = buildInvoice(WITH_TAX, { subscription: { planId: "professional" }, tax: { country: "IN" } });
  assert.ok(!("error" in inv));
  const i = inv as Exclude<typeof inv, { error: string }>;
  assert.deepEqual([usd(i.netCents), usd(i.taxCents), usd(i.totalCents)], ["99.00", "17.82", "116.82"]);
  assert.equal(i.lines[0].taxName, "GST");
});

test("one invoice, three separate categories, tax per line; totals are sums of rounded lines — across countries, plans and volumes", () => {
  const cases: [string, Parameters<typeof buildInvoice>[1], string, string, string][] = [
    ["Team in India, 60,000 responses, a $50 recharge", { subscription: { planId: "team", users: 5 }, responses: { count: 60_000 }, aiRecharge: { amount: 50 }, tax: { country: "IN" } }, "1949.00", "350.82", "2299.82"],
    ["Academic in the UK, 137 responses", { subscription: { planId: "academic" }, responses: { count: 137 }, tax: { country: "GB" } }, "43.11", "8.62", "51.73"],
    ["Professional ×2 in Germany, registered business (reverse charge)", { subscription: { planId: "professional", users: 2 }, responses: { count: 12_345 }, tax: { country: "DE", business: true, taxId: "DE811907980" } }, "556.63", "0.00", "556.63"],
    ["Team in Australia, AI recharge not taxed there", { subscription: { planId: "team" }, aiRecharge: { amount: 200 }, tax: { country: "AU" } }, "599.00", "39.90", "638.90"],
    ["a country with no rule configured", { subscription: { planId: "professional" }, responses: { count: 3 }, tax: { country: "US" } }, "99.09", "0.00", "99.09"],
    ["Enterprise on agreed terms and an agreed rate card", { subscription: { planId: "enterprise", users: 60, negotiatedMonthly: 5000 }, responses: { count: 400_000, negotiatedSlabs: [{ upTo: 100_000, each: 0.012 }, { upTo: null, each: 0.008 }] }, tax: { country: "IN" } }, "8600.00", "1548.00", "10148.00"],
    ["responses only, continuing from 249,990 already billed", { responses: { count: 20, alreadyBilled: 249_990 }, tax: { country: "GB" } }, "0.33", "0.07", "0.40"],
  ];
  for (const [name, input, net, tax, total] of cases) {
    const inv = buildInvoice(WITH_TAX, input);
    assert.ok(!("error" in inv), `${name}: ${(inv as { error?: string }).error}`);
    const i = inv as Exclude<typeof inv, { error: string }>;
    assert.deepEqual([usd(i.netCents), usd(i.taxCents), usd(i.totalCents)], [net, tax, total], name);
    assert.equal(i.lines.reduce((t, l) => t + l.grossCents, 0), i.totalCents, `${name}: lines add up`);
    assert.equal(Object.values(i.byCategory).reduce((t, c) => t + c.grossCents, 0), i.totalCents, `${name}: categories add up`);
    assert.ok(i.lines.every((l) => Number.isInteger(l.netCents) && Number.isInteger(l.taxCents)), `${name}: whole cents`);
  }
  const mixed = buildInvoice(WITH_TAX, { subscription: { planId: "team" }, responses: { count: 60_000 }, aiRecharge: { amount: 50 }, tax: { country: "IN" } }) as Exclude<ReturnType<typeof buildInvoice>, { error: string }>;
  assert.deepEqual(mixed.lines.map((l) => l.category), ["subscription", "responses", "responses", "responses", "ai"]);
  assert.deepEqual([usd(mixed.byCategory.subscription.netCents), usd(mixed.byCategory.responses.netCents), usd(mixed.byCategory.ai.netCents)], ["399.00", "1500.00", "50.00"]);
  assert.match(mixed.lines[2].description, /10,001–50,000 at USD 0\.025 each/);
  assert.match((buildInvoice(WITH_TAX, { subscription: { planId: "professional" }, tax: { country: "US" } }) as { notes: string[] }).notes.join(" "), /No tax rule is configured for this billing country/);
  assert.match((buildInvoice(C, { aiRecharge: { amount: 20 }, tax: { country: "IN" } }) as { error: string }).error, /minimum wallet recharge/);
  assert.match((buildInvoice(C, { subscription: { planId: "enterprise" }, tax: { country: "IN" } }) as { error: string }).error, /priced by agreement/);
  assert.equal(toCents(17.815), 1782); assert.equal(toCents(0.005), 1); assert.equal(toCents(-0.005), -1);
});

test("AI is sold at a gross MARGIN, not a markup: $1.00 of provider cost at 55% sells for $2.23; a service price is the whole charge", () => {
  const a = aiCharge(C, { providerCost: 1 });
  assert.deepEqual([a.chargeCents, a.basis, a.providerCostCents], [223, "model", 100]);
  assert.ok(a.marginPct >= 55 && a.marginPct < 56, `margin ${a.marginPct}`);
  assert.notEqual(a.chargeCents, 155, "not cost + 55%");
  const cat = commercialCatalog({ aiTargetMarginPct: 50, aiModelMarginPct: { "premium-x": 60 }, aiServices: [{ id: "transcription", name: "Transcription", unit: "minute", price: 0.12 }] });
  assert.equal(aiCharge(cat, { providerCost: 1 }).chargeCents, 200);
  assert.equal(aiCharge(cat, { providerCost: 1, model: "premium-x" }).chargeCents, 250, "a model's own margin target");
  const svc = aiCharge(cat, { providerCost: 0.9, service: { id: "transcription", units: 30 } });
  assert.deepEqual([svc.chargeCents, svc.basis], [360, "service"], "30 minutes × $0.12 — the model usage behind it is not charged again");
  assert.equal(aiCharge(cat, { providerCost: 0.9, service: { id: "unknown", units: 30 } }).basis, "model", "a service with no configured price is charged on its model usage");
  assert.equal(aiCharge(C, { providerCost: 0 }).chargeCents, 0, "a failed operation that cost nothing charges nothing");
  assert.deepEqual(C.aiServices, [], "no service price is built in");
});

test("the calculator's estimate: plan + progressive responses + the AI budget, tax only when a rule exists, Enterprise → contact sales", () => {
  const e = estimateCost(C, { planId: "team", responses: 60_000, aiBudget: 100 });
  assert.deepEqual([e.subscriptionCents, e.responsesCents, e.aiCents, e.subtotalCents, e.taxCents, e.totalCents], [39_900, 150_000, 10_000, 199_900, null, 199_900]);
  assert.match(String(e.taxNote), /calculated at checkout/);
  for (const [plan, n, ai, total] of [["academic", 1_000, 0, 6_900], ["professional", 5_000, 50, 29_900], ["professional", 25_000, 100, 87_400], ["team", 500_000, 500, 932_400], ["professional", 0, 0, 9_900]] as const) assert.equal(estimateCost(C, { planId: plan, responses: n, aiBudget: ai }).totalCents, total, `${plan} ${n} ${ai}`);
  const t = estimateCost(WITH_TAX, { planId: "professional", responses: 10_000, aiBudget: 50, tax: { country: "IN" } });
  assert.deepEqual([t.subtotalCents, t.taxCents, t.totalCents], [44_900, 8_082, 52_982]);
  assert.equal(estimateCost(WITH_TAX, { planId: "professional", responses: 10, tax: { country: "BR" } }).taxNote, "No tax rule is configured for this billing country.");
  const ent = estimateCost(C, { planId: "enterprise", responses: 1_000_000 });
  assert.deepEqual([ent.contactSales, ent.subscriptionCents, ent.totalCents], [true, null, null]);
});

test("profitability: revenue by category, provider and infrastructure cost, gross margin — per customer and in total", () => {
  const p = profitability([
    { customerId: "acme", category: "subscription", revenueCents: 39_900 },
    { customerId: "acme", category: "responses", revenueCents: 150_000, infrastructureCostCents: 12_000 },
    { customerId: "acme", category: "ai", revenueCents: 22_300, providerCostCents: 10_000 },
    { customerId: "solo", category: "subscription", revenueCents: 9_900 },
    { customerId: "solo", category: "ai", revenueCents: 1_000, providerCostCents: 1_400 },
  ]);
  assert.deepEqual(p.customers.map((c) => [c.customerId, c.revenueCents, c.grossMarginCents, c.grossMarginPct]), [["acme", 212_200, 190_200, 89.6], ["solo", 10_900, 9_500, 87.2]]);
  assert.deepEqual([p.total.subscriptionCents, p.total.responsesCents, p.total.aiCents, p.total.aiProviderCostCents, p.total.infrastructureCostCents], [49_800, 150_000, 23_300, 11_400, 12_000]);
  assert.equal(p.total.grossMarginCents, 223_100 - 23_400);
});
