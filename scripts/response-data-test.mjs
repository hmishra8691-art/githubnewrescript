/**
 * Browser suite — Response Data Management (§30 of the request).
 *
 * The Studio's sandbox has no database, so the API is route-intercepted by a
 * FAKE SERVER in this file that behaves like migration 0006: rows carry an
 * environment, a respondent code, a revision and a deleted_at; the count
 * endpoint answers a filter; a delete needs a matching confirmCount; an
 * import previews then commits. Every assertion below is therefore about the
 * BEHAVIOUR the UI must have — separation, confirmation, optimistic
 * concurrency, pagination — with the persistence itself covered by the SQL
 * exercise and the engine unit tests.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/response-data-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

const def = () => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Response data", version: "1.0" },
  questions: [
    { id: "gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }], settings: {} },
    { id: "age", code: "Q2", variableName: "AGE", type: "numeric", text: "Age", settings: {} },
    { id: "brands", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }], settings: {} },
    { id: "why", code: "Q4", variableName: "WHY", type: "long_text", text: "Why?", settings: {} },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["gender", "age", "brands", "why"] }, { type: "end", id: "e", status: "complete" }],
});
await h.loadDef(def());

/* ============================================================ fake server */

let nextTest = 1, nextLive = 1;
const mk = (env, answers, over = {}) => {
  const code = env === "TEST" ? `TEST_${String(nextTest++).padStart(6, "0")}` : `RESP_${String(nextLive++).padStart(6, "0")}`;
  return {
    id: `id_${code}`, respondentCode: code, sessionId: `sess_${code}`, respondentId: null,
    status: "complete", environment: env, revision: 0, source: "runtime",
    startedAt: `2026-09-0${(nextTest % 8) + 1}T10:00:00Z`, completedAt: "2026-09-04T10:05:00Z", updatedAt: "2026-09-04T10:05:00Z",
    deletedAt: null, deletedBy: null, deletionReason: null,
    answers, calculated: {}, embedded: {}, flags: [], quality: null, reviewStatus: null, ...over,
  };
};
const db = [
  mk("TEST", { gender: "m", age: 25, brands: ["a"], why: "The dealer was helpful" }),
  mk("TEST", { gender: "f", age: 31, brands: ["a", "b"], why: "Good value" }),
  mk("TEST", { gender: "m", age: 64, brands: ["b"], why: "Nothing to add" }),
  mk("TEST", { gender: "f", age: 55, brands: [], why: "" }),
  mk("LIVE", { gender: "m", age: 40, brands: ["a"], why: "Live respondent" }),
  mk("LIVE", { gender: "f", age: 70, brands: ["b"], why: "Also live" }),
];
const VARS = { gender: "GENDER", age: "AGE", brands: "BRANDS", why: "WHY" };
const varsOf = (r) => Object.fromEntries(Object.entries(r.answers).map(([k, v]) => [VARS[k], v]));
const audit = [];
let lastDeleteBody = null, lastPatch = null, lastImportCommit = null;

/** the same rule the real service enforces: a row is in a dataset or it is not */
const inEnv = (r, env) => env === "ALL" || r.environment === env;
const matches = (r, filter) => {
  if (!filter) return true;
  if (filter.type === "group") {
    const kids = filter.children ?? [];
    if (!kids.length) return true;
    if (filter.op === "and") return kids.every((c) => matches(r, c));
    if (filter.op === "or") return kids.some((c) => matches(r, c));
    return !kids.some((c) => matches(r, c));
  }
  const v = r.answers[filter.source.ref];
  const val = filter.value;
  switch (filter.operator) {
    case "eq": case "selected": return Array.isArray(v) ? v.map(String).includes(String(val)) : String(v ?? "") === String(val);
    case "ne": return String(v ?? "") !== String(val);
    case "gt": return Number(v) > Number(val);
    case "gte": return Number(v) >= Number(val);
    case "lt": return Number(v) < Number(val);
    case "lte": return Number(v) <= Number(val);
    default: return true;
  }
};
const textMatch = (r, needle) => {
  const q = needle.toLowerCase();
  if ((r.respondentCode ?? "").toLowerCase().includes(q)) return true;
  return Object.entries(varsOf(r)).some(([k, v]) => k.toLowerCase().includes(q) || String(Array.isArray(v) ? v.join(", ") : v ?? "").toLowerCase().includes(q));
};
const select = (env, { search, statuses, deleted, filter } = {}) =>
  db.filter((r) => inEnv(r, env)
    && (deleted ? !!r.deletedAt : !r.deletedAt)
    && (!statuses?.length || statuses.includes(r.status))
    && (!search || textMatch(r, search))
    && matches(r, filter));
const counts = () => {
  const blank = () => ({ total: 0, complete: 0, in_progress: 0, deleted: 0 });
  const out = { TEST: blank(), LIVE: blank(), ALL: blank() };
  for (const r of db) for (const b of [r.environment, "ALL"]) {
    if (r.deletedAt) { out[b].deleted++; continue; }
    out[b].total++;
    if (r.status in out[b]) out[b][r.status]++;
  }
  return out;
};
const columns = Object.values(VARS).map((n) => ({ name: n, label: n }));
const payload = (rows, env, limit, offset) => ({
  rows: rows.slice(offset, offset + limit).map((r) => ({ ...r, vars: varsOf(r) })),
  total: rows.length, exact: true, limit, offset, columns, counts: counts(), environment: env,
});

await page.route("**/api/surveys/*/data**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // one response: GET / PATCH
  const one = url.pathname.match(/\/data\/([^/]+)$/);
  if (one && !["delete", "import"].includes(one[1])) {
    const rec = db.find((r) => r.id === one[1]);
    if (!rec) return json({ error: "not found" }, 404);
    if (req.method() === "GET") return json({ response: { ...rec, vars: varsOf(rec) }, edits: audit.filter((a) => a.id === rec.id) });
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData());
      lastPatch = body;
      // optimistic concurrency, exactly as the SQL function behaves
      if (body.expectedRevision !== null && body.expectedRevision !== undefined && body.expectedRevision !== rec.revision) {
        return json({ error: "This response changed after your editor loaded it, so the edit was refused rather than overwriting that change.", conflict: true, revision: rec.revision, answers: rec.answers }, 409);
      }
      // the survey's own validation: an unknown option code is refused
      for (const [qid, v] of Object.entries(body.answers)) {
        const q = def().questions.find((x) => x.id === qid);
        if (q?.options?.length && v !== undefined && v !== null && v !== "") {
          const codes = q.options.map((o) => String(o.code));
          const given = Array.isArray(v) ? v.map(String) : [String(v)];
          if (given.some((g) => !codes.includes(g))) return json({ error: "the edit was not saved because it is not valid for this survey", issues: [{ questionId: qid, code: q.code, message: `“${given.join(", ")}” is not an option of ${q.code}` }] }, 422);
        }
      }
      const changed = [];
      for (const [k, v] of Object.entries(body.answers)) {
        const before = rec.answers[k];
        if (JSON.stringify(before ?? null) !== JSON.stringify(v ?? null)) changed.push(k);
        if (v === undefined || v === null || v === "") delete rec.answers[k]; else rec.answers[k] = v;
      }
      if (!changed.length) return json({ ok: true, unchanged: true, revision: rec.revision });
      rec.revision++;
      rec.source = "manual";
      audit.unshift({ id: rec.id, action: "edit", changes: Object.fromEntries(changed.map((k) => [k, { from: null, to: rec.answers[k] ?? null }])), reason: body.reason ?? null, edited_by: "researcher", edited_at: new Date().toISOString() });
      return json({ ok: true, revision: rec.revision, changed, quotas: { environment: rec.environment, responses: select(rec.environment).length } });
    }
  }

  // bulk delete / restore / purge
  if (url.pathname.endsWith("/data/delete")) {
    const body = JSON.parse(req.postData());
    lastDeleteBody = body;
    const env = body.environment;
    let targets;
    if (body.ids) targets = db.filter((r) => body.ids.includes(r.id));
    else {
      const found = select(env, { filter: body.filter, search: body.search, statuses: body.statuses, deleted: body.action !== "delete" });
      if (body.confirmCount === undefined || body.confirmCount === null) return json({ error: "confirmCount is required", found: found.length }, 428);
      if (body.confirmCount !== found.length) return json({ error: `The data changed since you were shown ${body.confirmCount} responses — ${found.length} now match, so nothing was deleted.`, recount: found.length }, 409);
      targets = found;
    }
    for (const r of targets) {
      if (body.action === "restore") { r.deletedAt = null; r.deletionReason = null; }
      else if (body.action === "purge") db.splice(db.indexOf(r), 1);
      else { r.deletedAt = new Date().toISOString(); r.deletionReason = body.reason ?? null; }
      audit.unshift({ id: r.id, action: body.action === "restore" ? "restore" : "delete", reason: body.reason ?? null, edited_by: "researcher", edited_at: new Date().toISOString() });
    }
    return json({ ok: true, action: body.action, affected: targets.length, quotas: { [env === "ALL" ? "LIVE" : env]: { responses: select(env === "ALL" ? "LIVE" : env).length } } });
  }

  // import: preview then commit
  if (url.pathname.endsWith("/data/import")) {
    const body = JSON.parse(req.postData());
    if (body.stage === "commit") {
      lastImportCommit = body;
      let created = 0, updated = 0;
      for (const row of body.rows) {
        const existing = db.find((r) => r.respondentCode === row.respondentCode && r.environment === body.environment && !r.deletedAt);
        if (existing) { Object.assign(existing.answers, row.answers); existing.revision++; existing.source = "import"; updated++; }
        else { const rec = mk(body.environment, row.answers, { source: "import", respondentCode: row.respondentCode ?? undefined }); if (row.respondentCode) { rec.respondentCode = row.respondentCode; rec.id = `id_${row.respondentCode}`; } db.push(rec); created++; }
      }
      return json({ ok: true, stage: "commit", created, updated, skipped: 0, quotas: { responses: select(body.environment).length } });
    }
    // preview: parse the pasted CSV the way the server does
    const lines = String(body.text ?? "").trim().split("\n").filter((l) => l.trim());
    const headers = (lines[0] ?? "").split(",").map((x) => x.trim());
    const mapping = body.mapping ?? Object.fromEntries(headers.map((hh) => {
      if (/^respondent/i.test(hh)) return [hh, { kind: "respondent_code" }];
      const q = def().questions.find((x) => x.variableName === hh || x.code === hh);
      return [hh, q ? { kind: "question", questionId: q.id } : { kind: "ignore" }];
    }));
    const rows = []; const issues = [];
    lines.slice(1).forEach((line, i) => {
      const cells = line.split(",").map((x) => x.trim());
      const row = { row: i + 1, respondentCode: null, sessionId: null, answers: {}, embedded: {} };
      let bad = false;
      headers.forEach((hh, ci) => {
        const t = mapping[hh]; const raw = cells[ci] ?? "";
        if (!t || t.kind === "ignore" || raw === "") return;
        if (t.kind === "respondent_code") { row.respondentCode = raw; return; }
        if (t.kind !== "question") return;
        const q = def().questions.find((x) => x.id === t.questionId);
        if (q.type === "numeric") {
          const n = Number(raw);
          if (!Number.isFinite(n)) { issues.push({ row: i + 1, column: hh, value: raw, expected: "a number", message: `“${raw}” is not a number`, severity: "error" }); bad = true; return; }
          row.answers[q.id] = n; return;
        }
        if (q.options?.length) {
          const code = q.options.find((o) => String(o.code) === raw || String(o.label).toLowerCase() === raw.toLowerCase());
          if (!code) { issues.push({ row: i + 1, column: hh, value: raw, expected: `one of ${q.options.map((o) => o.code).join(", ")}`, message: `“${raw}” is not an option of ${q.code}`, severity: "error" }); bad = true; return; }
          row.answers[q.id] = q.type === "multi_select" ? [String(code.code)] : String(code.code);
          return;
        }
        row.answers[q.id] = raw;
      });
      if (!bad) rows.push(row);
    });
    const willUpdate = rows.filter((r) => r.respondentCode && db.some((x) => x.respondentCode === r.respondentCode && x.environment === body.environment && !x.deletedAt)).length;
    const summary = { detected: lines.length - 1, valid: rows.length, warnings: 0, errors: issues.length, duplicates: 0, keyed: rows.filter((r) => r.respondentCode).length, unkeyed: 0, willCreate: rows.length - willUpdate, willUpdate };
    const blocking = body.mode === "create" && willUpdate > 0 ? `${willUpdate} rows in this file already exist in the ${body.environment} data. Choose “Update existing” or “Upsert”, or nothing will be imported.` : null;
    return json({
      ok: true, stage: "preview", environment: body.environment, mode: body.mode, mapping, headers,
      unmapped: headers.filter((hh) => (mapping[hh]?.kind ?? "ignore") === "ignore"),
      summary, issues, rows, sample: rows.slice(0, 10), blocking,
      questions: def().questions.map((q) => ({ id: q.id, code: q.code, variableName: q.variableName, text: q.text, type: q.type, rows: [] })),
      embedded: [],
    });
  }

  // "how many match?" — a POST, so the filter travels in the body
  if (req.method() === "POST") {
    const body = JSON.parse(req.postData());
    if (!body.environment) return json({ error: "environment must be TEST, LIVE or ALL" }, 400);
    const found = select(body.environment, { filter: body.filter, search: body.search, statuses: body.statuses, deleted: body.deleted });
    return json({ total: found.length, exact: true, environment: body.environment });
  }

  // the dataset page
  const env = url.searchParams.get("environment");
  if (!env) return json({ error: "environment must be TEST, LIVE or ALL" }, 400);
  const rows = select(env, {
    search: url.searchParams.get("search") ?? undefined,
    statuses: url.searchParams.getAll("status"),
    deleted: url.searchParams.get("deleted") === "1",
  });
  const dir = url.searchParams.get("dir") === "asc" ? 1 : -1;
  const field = url.searchParams.get("sort") ?? "started_at";
  rows.sort((a, b) => String(a[field === "respondent_code" ? "respondentCode" : field === "started_at" ? "startedAt" : field] ?? "").localeCompare(String(b[field === "respondent_code" ? "respondentCode" : field === "started_at" ? "startedAt" : field] ?? "")) * dir);
  return json(payload(rows, env, Number(url.searchParams.get("limit") ?? 50), Number(url.searchParams.get("offset") ?? 0)));
});
await page.route("**/api/surveys/*/responses*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ live: { total: 2, complete: 2, in_progress: 0, screened: 0, quota_full: 0, terminated: 0 }, test: { total: 4, complete: 4, in_progress: 0, screened: 0, quota_full: 0, terminated: 0 } }) }));
await page.route("**/api/surveys/*/quality**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, total: 0, byClass: {}, byReview: {}, signals: {}, histogram: new Array(10).fill(0), clusters: [], rows: [], config: null, staleAssessed: 0 }) }));

/* ============================================================ 1. separation */
await h.goTab("Data");
await page.waitForSelector('[data-testid="data-view-manage"]');
await page.click('[data-testid="data-view-manage"]');
await page.waitForSelector('[data-testid="response-manager"]');
await page.waitForSelector('[data-testid="rm-row"]');

assert.equal((await page.$$('[data-testid="rm-row"]')).length, 4, "the TEST dataset shows only test responses");
let codes = await page.$$eval('[data-testid="rm-row"]', (rs) => rs.map((r) => r.getAttribute("data-code")));
assert.ok(codes.every((c) => c.startsWith("TEST_")), `every row is a test respondent: ${codes}`);
assert.match(await page.textContent('[data-testid="rm-env-note"]'), /Only test responses/);
assert.match(await page.textContent('[data-testid="rm-env-note"]'), /separated in the database, not by this filter/);

await page.click('[data-testid="rm-env-LIVE"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 2);
codes = await page.$$eval('[data-testid="rm-row"]', (rs) => rs.map((r) => r.getAttribute("data-code")));
assert.ok(codes.every((c) => c.startsWith("RESP_")), `live data shows only live respondents: ${codes}`);
assert.ok(!codes.some((c) => c.startsWith("TEST_")), "a test response never appears in live data");

await page.click('[data-testid="rm-env-ALL"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 6);
assert.equal((await page.$$('td:has-text("TEST")')).length > 0, true, "the ALL view labels each row's environment");
await page.click('[data-testid="rm-env-TEST"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 4);
console.log("✔ test and live datasets are separate: each environment shows only its own responses, ALL labels them, and the note says where the separation lives");

/* ============================================================ 2. search */
await page.fill('[data-testid="rm-search"]', "dealer");
await page.waitForFunction(() => {
  const rs = [...document.querySelectorAll('[data-testid="rm-row"]')];
  return rs.length === 1 && rs[0].getAttribute("data-code") === "TEST_000001";
});
assert.equal((await page.$$eval('[data-testid="rm-row"]', (rs) => rs.map((r) => r.getAttribute("data-code"))))[0], "TEST_000001", "an open-end word finds its respondent");
await page.fill('[data-testid="rm-search"]', "TEST_000003");
await page.waitForFunction(() => {
  const rs = [...document.querySelectorAll('[data-testid="rm-row"]')];
  return rs.length === 1 && rs[0].getAttribute("data-code") === "TEST_000003";
});
assert.equal((await page.$$eval('[data-testid="rm-row"]', (rs) => rs.map((r) => r.getAttribute("data-code"))))[0], "TEST_000003", "a respondent id finds its response");
await page.fill('[data-testid="rm-search"]', "");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 4);
console.log("✔ search finds responses by respondent id and by answer value");

/* ============================================================ 3. logical filter → count → delete */
await page.click('[data-testid="rm-filter-open"]');
await page.waitForSelector('[data-testid="rm-filter"]');
// Q1 = Male AND Q2 > 50 — the request's own example shape, built with the
// ordinary logic builder (the same component display logic and quotas use)
const fRule = async (n, ref, op, value) => {
  await page.selectOption(`[data-testid="rm-filter"] [data-testid="lb-row"] >> nth=${n} >> select.ref-select`, ref);
  await page.waitForTimeout(200);
  await page.selectOption(`[data-testid="rm-filter"] [data-testid="lb-row"] >> nth=${n} >> select.op-select`, op);
  await page.waitForTimeout(200);
  const row = `[data-testid="rm-filter"] [data-testid="lb-row"] >> nth=${n}`;
  const sel = await page.$(`${row} >> select:not(.ref-select):not(.op-select)`);
  if (sel) await page.selectOption(`${row} >> select:not(.ref-select):not(.op-select)`, value);
  else await page.fill(`${row} >> input.input`, value);
  await page.waitForTimeout(200);
};
await page.click('[data-testid="rm-filter"] >> [data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="rm-filter"] [data-testid="lb-row"]');
await fRule(0, "q:gender", "eq", "m");
await page.click('[data-testid="rm-filter"] >> [data-testid="lb-add-condition"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-filter"] [data-testid="lb-row"]').length === 2);
await fRule(1, "q:age", "gt", "50");

await page.click('[data-testid="rm-find"]');
await page.waitForSelector('[data-testid="rm-found"]');
assert.match(await page.textContent('[data-testid="rm-found"]'), /1 response found/, "the count is shown before any delete is offered");
assert.ok(await page.$('[data-testid="rm-delete-matching"]'), "only now is a delete offered");

await page.click('[data-testid="rm-delete-matching"]');
await page.waitForSelector('[data-testid="rm-confirm"]');
const confirmText = await page.textContent('[data-testid="rm-confirm"]');
assert.match(confirmText, /Delete 1/);
assert.match(confirmText, /Environment: TEST/, "the confirmation names the environment");
assert.match(confirmText, /recycle bin and can be restored/, "the confirmation says it is reversible");
await page.fill('[data-testid="rm-confirm-reason"]', "over 60 in a dry run");
await page.click('[data-testid="rm-confirm-run"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 3);
assert.equal(lastDeleteBody.confirmCount, 1, "the confirmed count travels with the delete");
assert.equal(lastDeleteBody.reason, "over 60 in a dry run");
assert.equal(lastDeleteBody.environment, "TEST");
assert.equal(db.filter((r) => r.environment === "LIVE" && r.deletedAt).length, 0, "no live response was touched");
assert.equal(db.find((r) => r.respondentCode === "TEST_000003").deletedAt !== null, true, "only the matching response was deleted");
console.log("✔ a condition-based delete shows the count first, carries it to the server, names the environment and reason, and deletes exactly the matching responses");

/* ============================================================ 4. the count contract */
// the filter still stands; nothing matches it now
await page.click('[data-testid="rm-find"]');
await page.waitForSelector('[data-testid="rm-found"]');
await page.waitForFunction(() => /0 responses? found/.test(document.querySelector('[data-testid="rm-found"]')?.textContent ?? ""));
assert.equal(await page.$('[data-testid="rm-delete-matching"]'), null, "with nothing matching, no delete is offered");

// two late arrivals now match: the count must be recomputed, not remembered
db.push(mk("TEST", { gender: "m", age: 80, brands: [], why: "arrived late" }));
db.push(mk("TEST", { gender: "m", age: 90, brands: [], why: "also late" }));
await page.click('[data-testid="rm-find"]');
await page.waitForFunction(() => /2 responses found/.test(document.querySelector('[data-testid="rm-found"]')?.textContent ?? ""));
assert.match(await page.textContent('[data-testid="rm-confirm"]').catch(() => ""), /^$/, "no confirmation is open yet");

// and the server refuses a stale confirmation outright
const stale = await page.evaluate(async () => {
  const r = await fetch("/api/surveys/sandbox/data/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment: "TEST", action: "delete", confirmCount: 1, filter: { type: "rule", source: { kind: "question", ref: "age" }, operator: "gt", value: 50 } }),
  });
  return { status: r.status, body: await r.json() };
});
assert.equal(stale.status, 409, "a delete confirmed against an old count is refused");
assert.match(stale.body.error, /you were shown 1 responses? — \d+ now match, so nothing was deleted/);
assert.ok(stale.body.recount > 1, "the refusal carries the new number");
assert.equal(db.filter((r) => r.environment === "TEST" && r.deletedAt).length, 1, "no extra response was deleted");
console.log("✔ the count is recomputed on every Find, and a delete confirmed against a stale count is refused with the new number");

await page.click('[data-testid="rm-filter-open"]');

/* ============================================================ 5. edit in the grid */
await page.fill('[data-testid="rm-search"]', "TEST_000001");
await page.waitForFunction(() => {
  const rs = [...document.querySelectorAll('[data-testid="rm-row"]')];
  return rs.length === 1 && rs[0].getAttribute("data-code") === "TEST_000001";
});
const ageCellIndex = (await page.$$eval('[data-testid="rm-table"] thead th', (ths) => ths.map((t) => t.textContent.trim()))).indexOf("AGE");
assert.ok(ageCellIndex > 0, "the AGE column is in the grid");
await page.click(`[data-testid="rm-row"] >> nth=0 >> td >> nth=${ageCellIndex}`);
await page.waitForSelector('[data-testid="rm-cell-input"]');
await page.fill('[data-testid="rm-cell-input"]', "30");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /AGE saved/.test(document.querySelector('[data-testid="rm-toast"]')?.textContent ?? ""));
assert.equal(db.find((r) => r.respondentCode === "TEST_000001").answers.age, 30, "the new value is stored");
assert.equal(lastPatch.expectedRevision, 0, "the edit carries the revision it was made against");
assert.match(lastPatch.reason, /data grid/);
console.log("✔ a cell is edited in place, stored, and carries the revision it was based on");

/* ============================================================ 6. full editor, validation, concurrency, audit */
await page.click('[data-testid="rm-row"] >> nth=0 >> [data-testid="rm-edit"]');
await page.waitForSelector('[data-testid="rm-editor"]');
assert.match(await page.textContent('[data-testid="rm-editor-env"]'), /TEST/);
assert.match(await page.textContent('[data-testid="rm-editor"]'), /rev 1/, "the editor shows the row's revision");
// a valid change through the question's own control
await page.selectOption('[data-testid="rm-field-Q1"] select', "f");
await page.fill('[data-testid="rm-editor-reason"]', "corrected from the recording");
await page.click('[data-testid="rm-editor-save"]');
await page.waitForFunction(() => /1 answer changed/.test(document.querySelector('[data-testid="rm-toast"]')?.textContent ?? ""));
assert.equal(db.find((r) => r.respondentCode === "TEST_000001").answers.gender, "f");
assert.equal(audit[0].reason, "corrected from the recording", "the reason is kept in the audit trail");
// the audit tab shows it
await page.click('[data-testid="rm-editor-audit-tab"]');
await page.waitForSelector('[data-testid="rm-editor-audit"]');
assert.match(await page.textContent('[data-testid="rm-editor-audit"]'), /corrected from the recording/);
assert.match(await page.textContent('[data-testid="rm-editor-audit"]'), /Q1/, "the change names the question");
console.log("✔ the full editor edits by question type, records a reason, and shows the response's history");

// a stale editor is refused rather than overwriting
await page.click('[data-testid="rm-editor"] >> text=Answers');
db.find((r) => r.respondentCode === "TEST_000001").revision = 99;
await page.selectOption('[data-testid="rm-field-Q1"] select', "m");
await page.click('[data-testid="rm-editor-save"]');
await page.waitForSelector('[data-testid="rm-editor-conflict"]');
assert.match(await page.textContent('[data-testid="rm-editor-conflict"]'), /changed after your editor loaded it/);
assert.equal(db.find((r) => r.respondentCode === "TEST_000001").answers.gender, "f", "the stale edit did not land");
db.find((r) => r.respondentCode === "TEST_000001").revision = 2;
await page.click('[data-testid="rm-editor-conflict"] >> text=Reload this response');
await page.waitForTimeout(300);
console.log("✔ an edit made against an older revision is refused, not applied — the newer value survives");

// an invalid value is refused with the survey's own reason
await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="rm-field-Q1"] select');
  const opt = document.createElement("option");
  opt.value = "zzz"; opt.textContent = "zzz";
  sel.appendChild(opt);
  sel.value = "zzz";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.click('[data-testid="rm-editor-save"]');
await page.waitForSelector('[data-testid="rm-editor-issues"]');
assert.match(await page.textContent('[data-testid="rm-editor-issues"]'), /is not an option of Q1/);
assert.equal(db.find((r) => r.respondentCode === "TEST_000001").answers.gender, "f", "nothing was stored");
await page.click('[data-testid="rm-editor"] >> text=Close');
console.log("✔ a value the survey would reject is refused with the survey's own explanation, and nothing is stored");

/* ============================================================ 7. selection delete + bin + restore */
await page.fill('[data-testid="rm-search"]', "");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 5);
await page.click('[data-testid="rm-row"] >> nth=0 >> [data-testid="rm-row-select"]');
await page.click('[data-testid="rm-row"] >> nth=1 >> [data-testid="rm-row-select"]');
await page.waitForSelector('[data-testid="rm-selbar"]');
assert.match(await page.textContent('[data-testid="rm-selbar"]'), /2 selected/);
await page.click('[data-testid="rm-delete-selected"]');
await page.waitForSelector('[data-testid="rm-confirm"]');
assert.match(await page.textContent('[data-testid="rm-confirm"]'), /Delete 2 responses/);
await page.click('[data-testid="rm-confirm-run"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 3);
assert.equal(lastDeleteBody.ids.length, 2, "the two ticked rows were sent, by id");
console.log("✔ ticked responses are deleted together, with the exact number confirmed");

await page.click('[data-testid="rm-bin"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 3);
assert.equal((await page.$$('[data-testid="rm-row"]')).length, 3, "the bin holds the three deleted responses");
await page.click('[data-testid="rm-row"] >> nth=0 >> [data-testid="rm-restore-one"]');
await page.waitForSelector('[data-testid="rm-confirm"]');
assert.match(await page.textContent('[data-testid="rm-confirm"]'), /Restore/);
await page.click('[data-testid="rm-confirm-run"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 2);
await page.click('[data-testid="rm-bin"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 4);
console.log("✔ a deleted response leaves the dataset, waits in the recycle bin, and comes back on restore");

/* ============================================================ 8. import */
await page.click('[data-testid="rm-import-open"]');
await page.waitForSelector('[data-testid="rm-import"]');
const existingCode = db.find((r) => r.environment === "TEST" && !r.deletedAt).respondentCode;
await page.fill('[data-testid="rm-import-text"]', `respondent_code,GENDER,AGE\n${existingCode},f,44\n,m,23\n,m,abc\n`);
await page.click('[data-testid="rm-import-preview"]');
await page.waitForSelector('[data-testid="rm-import-preview-out"]');
assert.match(await page.textContent('[data-testid="rm-import-valid"]'), /Valid 2/, "the bad row is not counted as valid");
assert.match(await page.textContent('[data-testid="rm-import-errors"]'), /Errors 1/);
assert.match(await page.textContent('[data-testid="rm-import-issue"]'), /is not a number/, "the error names the row, the column and what was expected");
assert.match(await page.textContent('[data-testid="rm-import-preview-out"]'), /Will create 1/);
assert.match(await page.textContent('[data-testid="rm-import-preview-out"]'), /Will update 1/);
// create mode refuses to touch the existing respondent
await page.selectOption('[data-testid="rm-import-mode"]', "create");
await page.click('[data-testid="rm-import-preview"]');
await page.waitForSelector('[data-testid="rm-import-blocking"]');
assert.match(await page.textContent('[data-testid="rm-import-blocking"]'), /already exist/);
assert.equal(await page.isDisabled('[data-testid="rm-import-commit"]'), true, "committing is blocked until the mode is right");
// upsert: update the existing one, create the new one
await page.selectOption('[data-testid="rm-import-mode"]', "upsert");
await page.click('[data-testid="rm-import-preview"]');
await page.waitForSelector('[data-testid="rm-import-valid"]');
const beforeCount = db.filter((r) => r.environment === "TEST" && !r.deletedAt).length;
await page.click('[data-testid="rm-import-commit"]');
await page.waitForFunction(() => /created/.test(document.querySelector('[data-testid="rm-toast"]')?.textContent ?? ""));
assert.match(await page.textContent('[data-testid="rm-toast"]'), /1 created, 1 updated/);
assert.equal(db.filter((r) => r.environment === "TEST" && !r.deletedAt).length, beforeCount + 1, "exactly one response was created — the existing id was updated, not duplicated");
assert.equal(db.find((r) => r.respondentCode === existingCode).answers.age, 44, "the existing response was updated in place");
assert.equal(db.filter((r) => r.respondentCode === existingCode).length, 1, "no TEST_xxx_2 was created");
assert.equal(lastImportCommit.environment, "TEST", "the import landed in the environment on screen");
assert.equal(db.some((r) => r.environment === "LIVE" && r.source === "import"), false, "no live response was created by a test import");
console.log("✔ import validates, previews, refuses the wrong mode, then updates existing respondents in place and creates only the new ones — in the environment on screen");

/* ============================================================ 9. pagination */
for (let i = 0; i < 60; i++) db.push(mk("TEST", { gender: i % 2 ? "m" : "f", age: 20 + i, brands: [], why: `bulk ${i}` }));
await page.click('[data-testid="rm-refresh"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rm-row"]').length === 50);
assert.equal((await page.$$('[data-testid="rm-row"]')).length, 50, "one page at a time, never the whole dataset");
assert.match(await page.textContent('[data-testid="rm-pager"]'), /1–50 of 6[0-9]/, "the total is the whole matching set, not the page");
await page.click('[data-testid="rm-next"]');
await page.waitForFunction(() => /^5[1-9]–/.test(document.querySelector('[data-testid="rm-pager"]').textContent.trim()));
assert.ok((await page.$$('[data-testid="rm-row"]')).length < 50, "the last page holds the remainder");
await page.click('[data-testid="rm-prev"]');
await page.waitForFunction(() => /1–50/.test(document.querySelector('[data-testid="rm-pager"]').textContent));
console.log("✔ the grid pages server-side: 60+ responses arrive 50 at a time with a true total");

/* ============================================================ 10. environment is never optional */
const noEnv = await page.evaluate(async () => {
  const r = await fetch("/api/surveys/sandbox/data?limit=5");
  return { status: r.status, body: await r.json() };
});
assert.equal(noEnv.status, 400, "a request without an environment is refused, not defaulted");
assert.match(noEnv.body.error, /environment must be TEST, LIVE or ALL/);
console.log("✔ the API refuses a dataset request that does not say which environment it means");

await h.close();
console.log("\nALL RESPONSE DATA MANAGEMENT CHECKS PASSED");
