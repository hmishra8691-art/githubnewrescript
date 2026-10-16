// METHOD-01: MaxDiff best==worst passes Next?  METHOD-09: empty List Fill selection leaves destinations shown?
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "/home/claude/rescript/scripts/lib/preview.mjs";
import { maxdiffPlugin } from "/home/claude/rescript/packages/designs/dist/index.js";
const RUNTIME = "http://localhost:3001";
const browser = await chromium.launch();
const base = { logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } } };

// ---- MaxDiff
{
  const items = ["Battery", "Camera", "Screen", "Price"];
  const md = maxdiffPlugin.generate({ items, itemsPerTask: 3, tasks: 2, versions: 1 }, 7);
  const def = { ...base, meta: { id: "md", code: "MD", title: "MD", version: "1.0", schemaVersion: 1, status: "draft" },
    designs: [{ id: "d_md", kind: "maxdiff", name: "MD", config: { items, itemsPerTask: 3 }, file: { format: "json", columns: md.columns, rows: md.rows } }],
    questions: [{ id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Best/worst", required: true, settings: { designRef: "d_md" } }, { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "After" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }] };
  const pv = await browser.newPage();
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition: def }, { selector: '[data-qid="q_md"]' });
  const tasks = await pv.$$eval('[data-qid="q_md"] input[type=radio]', (ins) => [...new Set(ins.map((i) => i.name.replace(/_(best|worst)$/, "")))]);
  console.log("maxdiff tasks on page:", tasks.length);
  // same item as best and worst in every task
  for (const t of tasks) {
    const best = await pv.$(`input[name="${t}_best"]`); const worst = await pv.$(`input[name="${t}_worst"]`);
    await best.check(); await worst.check();
  }
  const sameAll = await pv.$$eval('[data-qid="q_md"] input[type=radio]:checked', (ins) => ins.map((i) => i.name + "=" + i.value));
  console.log("checked:", sameAll.join(" | "));
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForTimeout(600);
  const errs = await pv.$$eval(".rs-error-msg", (es) => es.map((e) => e.textContent.trim()));
  console.log("METHOD-01 best==worst → errors:", JSON.stringify(errs), "advanced to Q2:", !!(await pv.$('[data-qid="q2"]')));
  // partial: only one task answered
  await pv.close();
  const pv2 = await browser.newPage();
  await pv2.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv2, { definition: def }, { selector: '[data-qid="q_md"]' });
  const t0 = tasks[0];
  await (await pv2.$(`input[name="${t0}_best"]`)).check();
  const w = await pv2.$$(`input[name="${t0}_worst"]`); await w[w.length - 1].check();
  await pv2.click('[data-testid="rs-next"]');
  await pv2.waitForTimeout(600);
  console.log("METHOD-01 only 1 of", tasks.length, "tasks answered → errors:", JSON.stringify(await pv2.$$eval(".rs-error-msg", (es) => es.map((e) => e.textContent.trim()))), "advanced:", !!(await pv2.$('[data-qid="q2"]')));
  await pv2.close();
}

// ---- List Fill empty source
{
  const def = { ...base, meta: { id: "lf", code: "LF", title: "LF", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q_brands", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands have you used?", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
      { id: "q_rate", code: "Q2", variableName: "RATE", type: "single_select", text: "How do you rate {{LISTFILL_Q1_1}}?", options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }] },
      { id: "q_end", code: "Q3", variableName: "END", type: "open_text", text: "Anything else?" },
    ],
    listFills: [{ id: "lf1", name: "Q1", enabled: true, source: { kind: "question", questionId: "q_brands", take: "selected" }, selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority" }, tracking: { sampleLevel: true }, options: [{ code: "1" }, { code: "2" }, { code: "3" }], destinations: [{ questionId: "q_rate", write: "answer", whenUnused: "hide" }] }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_brands"] }, { type: "page", id: "p2", questionIds: ["q_rate"] }, { type: "page", id: "p3", questionIds: ["q_end"] }, { type: "end", id: "e1", status: "complete" }] };
  const pv = await browser.newPage();
  const errs = []; pv.on("pageerror", (e) => errs.push(String(e)));
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  try {
    await sendPreview(pv, { definition: def }, { selector: '[data-qid="q_brands"]', timeout: 20000 });
  } catch (e) { console.log("LISTFILL fixture rejected:", String(e).slice(0, 400)); await pv.close(); await browser.close(); process.exit(0); }
  await pv.click('[data-testid="rs-next"]'); // select nothing
  await pv.waitForTimeout(700);
  const qids = await pv.$$eval("[data-qid]", (es) => es.map((e) => e.getAttribute("data-qid")));
  const text = await pv.$eval("#rs-questions, body", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 300));
  console.log("METHOD-09 after empty selection: page shows", JSON.stringify(qids), "| text:", text);
  console.log("page errors:", errs);
  await pv.close();
}
await browser.close();
