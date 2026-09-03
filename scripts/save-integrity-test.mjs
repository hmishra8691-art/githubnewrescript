/**
 * Save integrity — the P0 promise, tested.
 *
 * "If the user successfully saves something, it must never disappear unless
 * the user explicitly changes or restores it."
 *
 * Every check below inspects what the editor actually SENT to the server, or
 * how it behaved when the server refused, rather than what the screen showed.
 * A save indicator is not evidence that anything was stored.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const SURVEY = "11111111-2222-3333-4444-555555555555";
const browser = await chromium.launch();

/** Wire a page up to a fake survey row that behaves like the real route. */
async function studioWithServer(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());

  const server = { revision: 0, draft: null, savedVersions: [], writes: [], rejected: 0 };

  await page.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
    const body = JSON.parse(req.postData());
    server.writes.push(body);
    // the real guard: refuse anything not based on the current revision
    if (opts.guard !== false && body.baseRevision !== server.revision) {
      server.rejected++;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "changed elsewhere", conflict: true, revision: server.revision,
        }),
      });
    }
    server.revision += 1;
    server.draft = body.definition;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: server.revision }),
    });
  });

  await page.route(`**/api/surveys/${SURVEY}/versions`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData());
    server.savedVersions.push(body.definition);
    server.revision += 1;
    server.draft = null; // cutting a version clears the draft, as the route does
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: `ver_${server.savedVersions.length}`, version: `1.${server.savedVersions.length}`, variables: 3, revision: server.revision }),
    });
  });

  await page.route(`**/api/surveys/${SURVEY}/publish`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
  await page.route(`**/api/surveys/${SURVEY}/responses*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.goto(`http://localhost:3000/sandbox?dbid=${SURVEY}&rev=0`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  return { page, server };
}

const addQuestion = async (page, text) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(280);
};
const settle = (page) => page.waitForTimeout(1400); // past the autosave debounce
const saveState = (page) => page.$eval('[data-testid="save-state"]', (e) => e.textContent.trim());

/* ==================================================== 1. edits are persisted */
{
  const { page, server } = await studioWithServer();
  for (const t of ["Q1 age", "Q2 gender"]) await addQuestion(page, t);
  await settle(page);

  assert.ok(server.writes.length > 0, "the editor wrote something at all");
  assert.equal(server.rejected, 0, "and nothing was refused");
  assert.equal(server.draft.questions.length, 2, "both questions reached the server");
  assert.match(await saveState(page), /saved/i, "and the header says so");
  console.log(`✔ edits autosave: ${server.writes.length} writes, revision ${server.revision}`);

  /* --------------------------------------- display logic survives to the wire */
  await page.click(".qcard >> nth=1");
  await page.waitForSelector('[data-testid="display-logic"], .rightpanel');
  const addBtn = await page.$('.rightpanel >> text=+ add');
  if (addBtn) {
    await addBtn.click();
    await page.waitForSelector(".cond-rule");
    await settle(page);
    const q2 = server.draft.questions[1];
    assert.ok(q2.displayLogic, "display logic reached the server, not just the screen");
    console.log("✔ display logic is in the saved draft:", JSON.stringify(q2.displayLogic).slice(0, 70));
  }

  /* ------------------------------------------ flow, blocks, groups, breaks */
  await page.click(".leftnav >> text=Questions");
  const qbars = await page.$$(".insert-bar");
  // the bar AFTER the first question — a break at the end of a page splits
  // nothing, so it is not offered there
  const pb = await qbars[0].$('[data-testid="add-page-break"]');
  assert.ok(pb, "a page break is offered between two questions");
  await pb.click();
  await settle(page);

  await page.click(".leftnav >> text=Survey Flow");
  await page.waitForSelector('[data-testid="flow-block"]');
  await page.click('[data-testid="add-group"]');
  await page.waitForSelector('[data-testid="flow-group"]');
  await page.fill('[data-testid="group-title"]', "Demographics");
  await settle(page);

  const flow = server.draft.flow;
  assert.ok(flow.some((n) => n.type === "section" && n.title === "Demographics"),
    `the group reached the server: ${JSON.stringify(flow.map((n) => n.type))}`);
  assert.ok(flow.some((n) => n.type === "block" && n.children?.length === 2),
    "and so did the page break, as a block with two pages");
  console.log("✔ blocks, page breaks and groups all reach the saved draft");

  /* -------------------------------------- a version carries the same content */
  await page.click("text=Save version");
  await page.waitForTimeout(1200);
  const versioned = server.savedVersions.at(-1);
  assert.ok(versioned, "a version was written");
  assert.ok(versioned.flow.some((n) => n.type === "section"), "the version contains the group");
  assert.equal(versioned.questions.length, 2, "and every question");
  assert.match(await saveState(page), /saved/i, "and the editor is clean afterwards");
  console.log("✔ Save version stores the same structure the draft had");

  await page.close();
}

/* ============================================ 2. a stale write cannot land */
{
  const { page, server } = await studioWithServer();
  await addQuestion(page, "First");
  await settle(page);
  const goodRevision = server.revision;
  const goodDraft = JSON.stringify(server.draft);

  // somebody else advances the survey — this editor is now behind
  server.revision += 5;

  await addQuestion(page, "Second (must not overwrite)");
  await settle(page);

  assert.ok(server.rejected > 0, "the server refused the stale write");
  assert.equal(JSON.stringify(server.draft), goodDraft,
    "and the stored draft is untouched — the newer work was NOT overwritten");
  assert.match(await saveState(page), /Changed elsewhere/,
    `the editor says so plainly: ${await saveState(page)}`);
  console.log(`✔ a stale write is refused and the draft is preserved (rev ${goodRevision} → server ${server.revision})`);

  // and it must STOP, not keep hammering the row
  const attemptsAfterConflict = server.writes.length;
  await addQuestion(page, "Third");
  await settle(page);
  assert.equal(server.writes.length, attemptsAfterConflict,
    "no further writes are attempted after a conflict — retrying is how work gets buried");
  console.log("✔ autosave stops after a conflict instead of retrying over newer work");

  await page.close();
}

/* ================================== 3. nested AND/OR operators are independent */
{
  const { page, server } = await studioWithServer();
  await addQuestion(page, "Q1");
  await addQuestion(page, "Q2");
  await addQuestion(page, "Q3");
  await settle(page);

  // put display logic on the last question
  await page.click(".qcard >> nth=2");
  await page.waitForTimeout(300);
  const add = await page.$('.rightpanel >> text=+ add');
  assert.ok(add, "display logic can be added");
  await add.click();
  await page.waitForSelector(".cond-rule");

  // add a second condition, so the parent group has an operator of its own
  await page.click('.rightpanel >> text=+ condition');
  await page.waitForTimeout(250);
  // then a nested group
  await page.click('.rightpanel >> text=+ condition group');
  await page.waitForTimeout(350);

  const ops = await page.$$('[data-testid="group-op"]');
  assert.ok(ops.length >= 2, `every group shows its own operator control: ${ops.length}`);
  const parentBefore = await ops[0].inputValue();

  // change the NESTED group's operator
  const nested = ops[ops.length - 1];
  const nestedBefore = await nested.inputValue();
  await nested.selectOption(nestedBefore === "and" ? "or" : "and");
  await settle(page);

  const parentAfter = await (await page.$$('[data-testid="group-op"]'))[0].inputValue();
  assert.equal(parentAfter, parentBefore,
    `the parent operator is untouched (${parentBefore} → ${parentAfter})`);
  console.log(`✔ changing the nested operator left the parent as ${parentAfter}`);

  // and the STORED tree agrees
  const logic = server.draft.questions[2].displayLogic;
  assert.equal(logic.type, "group");
  assert.equal(logic.op, parentBefore, "the saved parent operator matches the editor");
  const child = logic.children.find((c) => c.type === "group");
  assert.ok(child, "the nested group is stored as a nested group, not flattened");
  assert.notEqual(child.op, nestedBefore, "and its operator is the one that changed");
  console.log(`✔ stored tree: ${logic.op.toUpperCase()} [ rule, ${child.op.toUpperCase()} [...] ] — nesting preserved`);

  await page.close();
}

await browser.close();
console.log("\nALL SAVE INTEGRITY CHECKS PASSED");
