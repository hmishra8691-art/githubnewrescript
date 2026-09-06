/**
 * UI SCREENSHOTS — every major area of the Studio, for design review.
 *
 * Signed-in screens are captured with the same in-process fakes the analytics
 * browser test uses (no database in the dev container); the Studio itself is
 * the real sandbox with the Master Demo loaded, so the Questions / Logic /
 * Flow / List Fill / Quotas / Data panels show real programming content.
 *
 *   node scripts/ui-shots.mjs [outDir]        (dev servers on 3000 / 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import fs from "node:fs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";
import { buildDataset, runAnalysis, recommendCharts, variableMetadata } from "../packages/analytics/dist/index.js";
import { def as synDef, synthRows } from "../packages/analytics/dist/analyses/fixture.js";

const OUT = process.argv[2] ?? "/tmp/ui-shots";
fs.mkdirSync(OUT, { recursive: true });
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const now = () => new Date().toISOString();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const user = { userId: "u1", userCode: "USR-10482", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: true, sessionId: "s1", unread: 2, policies: { heartbeatSeconds: 600 } };
const surveys = [
  { id: SURVEY, code: "FIN26", title: "Finance Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), created_at: now(), version: "2.4", collaborators: 3, owner: { userId: "u1", name: "Ana Lyst", userCode: "USR-10482", isMe: true } },
  { id: "22222222-2222-4222-8222-222222222222", code: "CONS", title: "Consumer Research Q3", status: "testing", myRole: "editor", roleSource: "member", updated_at: now(), created_at: now(), version: "1.1", collaborators: 2, owner: { userId: "u2", name: "Sam Ortiz", userCode: "USR-10201", isMe: false } },
  { id: "33333333-3333-4333-8333-333333333333", code: "BRAND", title: "Brand Tracking Wave 4", status: "draft", myRole: "viewer", roleSource: "workspace", updated_at: now(), created_at: now(), version: null, collaborators: 5, owner: { userId: "u3", name: "Priya N", userCode: "USR-10007", isMe: false } },
];
const stats = { [SURVEY]: { responses: 2431, live: 2431, test: 118, completes: 2287, inProgress: 84, questions: 62, quotas: 4, lastResponseAt: now() }, "22222222-2222-4222-8222-222222222222": { responses: 312, live: 0, test: 312, completes: 290, inProgress: 22, questions: 41, quotas: 0, lastResponseAt: now() }, "33333333-3333-4333-8333-333333333333": { responses: 0, live: 0, test: 0, completes: 0, inProgress: 0, questions: 18, quotas: 0, lastResponseAt: null } };
await page.route("**/api/auth/me", (r) => json(r, user));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/surveys", (r) => json(r, { surveys }));
await page.route("**/api/surveys/stats**", (r) => json(r, { stats, contributors: {} }));
await page.route(/\/api\/surveys\/[^/]+\/stats/, (r) => json(r, { stats, contributors: {} }));
// analytics fakes (real engine)
const rows = synthRows(400);
const compute = (d) => { const res = runAnalysis(d, buildDataset(synDef, rows, { spec: d.dataset ?? { environment: "LIVE", dataset: "all" } })); return { ...res, recommendations: recommendCharts(res) }; };
const saved = [{ id: "a1", name: "Satisfaction by gender", kind: "crosstab", version: 2, updated_at: now(), definition: { name: "Satisfaction by gender", kind: "crosstab", dataset: { environment: "LIVE", dataset: "all" }, variables: [], rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" } }, { id: "a2", name: "NPS", kind: "nps", version: 1, updated_at: now(), definition: { name: "NPS", kind: "nps", dataset: { environment: "LIVE", dataset: "all" }, variables: ["NPS"], options: { by: "GENDER" } } }];
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname.split("/analytics/")[1] ?? "";
  if (path === "variables") return json(route, { variables: variableMetadata(synDef).filter((v) => !v.hidden), counts: { LIVE: 2431, TEST: 118 }, surveyVersion: "2.4", revision: 9 });
  if (path === "home") return json(route, { analyses: saved, charts: [], reports: [{ id: "r1", name: "Executive Customer Report", kind: "report", mode: "snapshot", published_version: 2, updated_at: now() }], shares: [] });
  if (path === "run") return json(route, { result: compute(JSON.parse(route.request().postData()).definition) });
  if (path === "analyses") return json(route, { items: saved });
  if (path === "reports") return json(route, { items: [{ id: "r1", name: "Executive Customer Report", kind: "report", mode: "snapshot", published_version: 2, updated_at: now(), definition: { title: "Executive Customer Report", blocks: [] } }] });
  return json(route, { items: [] });
});

const shot = async (name, opts = {}) => { await page.waitForTimeout(opts.wait ?? 400); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false }); console.log("  shot", name); };

// 1. auth
await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle" }); await shot("01-login");
// 2. dashboard
await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" }); await page.waitForSelector(".survey-card, .dash"); await shot("02-dashboard", { full: true });
// 3. studio with the master demo
await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" }); await page.waitForSelector(".leftnav");
const def = buildMasterDemoSurvey("sandbox");
await page.click(".leftnav >> text=JSON"); await page.waitForSelector("textarea.code"); await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
await page.click('button:has-text("validate & apply")'); await page.waitForTimeout(800);
for (const [tab, name] of [["Questions", "03-studio-questions"], ["Logic", "04-studio-logic"], ["Survey Flow", "05-studio-flow"], ["List Fill", "06-studio-listfill"], ["Quotas", "07-studio-quotas"], ["Variables", "08-studio-variables"], ["Data", "09-studio-data"], ["Design Generators", "10-studio-designs"]]) {
  await page.click(`.leftnav >> text=${tab}`); await page.waitForTimeout(500); await shot(name);
}
// a question selected → properties panel
await page.click(".leftnav >> text=Questions"); await page.waitForTimeout(300);
const card = await page.$(".qcard, .card.selectable"); if (card) { await card.click(); await shot("11-studio-question-properties"); }
// a condition block in the logic builder, and the Data → Quality (cleaning) workspace
const addCond = await page.$('.rightpanel button:has-text("add")'); if (addCond) { await addCond.click(); await page.waitForTimeout(300); await shot("11b-studio-condition-builder"); }
await page.click(".leftnav >> text=Data"); await page.waitForTimeout(300);
const quality = await page.$('.center button:has-text("Quality")'); if (quality) { await quality.click(); await page.waitForTimeout(500); await shot("11c-studio-data-quality"); }
const manage = await page.$('.center button:has-text("Manage")'); if (manage) { await manage.click(); await page.waitForTimeout(500); await shot("11d-studio-data-manage"); }
// 4. analytics
await page.goto(`${STUDIO}/analytics?survey=${SURVEY}`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ax-workspace"]'); await shot("12-analytics-home", { full: true });
await page.click('[data-testid="ax-home-analysis"]'); await page.waitForSelector('[data-testid="ax-result"]', { timeout: 20000 }); await shot("13-analytics-result", { full: true });
await page.click('[data-testid="ax-tab-reports"]'); await shot("14-analytics-reports");
// 5. profile
await page.route("**/api/auth/sessions**", (r) => json(r, { sessions: [] }));
await page.route("**/api/notifications**", (r) => json(r, { notifications: [] }));
await page.goto(`${STUDIO}/profile`, { waitUntil: "networkidle" }); await shot("15-profile", { full: true });

// 6. the testing toolbar, scrolled deep into the survey — it must still be there
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
try {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await page.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), buildMasterDemoSurvey("sandbox"));
  await page.waitForSelector('[data-testid="runtime-toolbar"]', { timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 900)); await shot("16-testing-toolbar-scrolled");
  await page.click('[aria-label="mobile viewport"]'); await page.waitForTimeout(400); await shot("17-testing-toolbar-mobile");
} catch { console.log("  (runtime on 3001 not reachable — skipped the toolbar shots)"); }
await browser.close();
console.log(`done → ${OUT}`);
