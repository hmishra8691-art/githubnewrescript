/**
 * IM MEDIA (S2b item 6, 2026-10-30) — Intelligent Mode sets a video stimulus with watch-to-continue on a question
 * (update_question → media.video_rating, then set_question_media), the proposal applies, the definition holds it,
 * and the runtime shows it:
 *
 *   1. the stored https address is the <video> the runtime draws under the question (no network here, so the clip
 *      itself does not load — the runtime then says so and, by design, does not lock the answer)
 *   2. the same question with the runtime's own local clip: the rating is LOCKED until the clip has been watched
 *      ("rating-locked", the fieldset disabled) — watch-to-continue is enforced
 *   3. an http address is refused by the gate with the reason (the Changes card shows it)
 *
 *   node scripts/im-media-test.mjs   (studio :3000 and runtime :3001 with AI_API_URL=fake:)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { switchMode } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const CLIP_HTTPS = "https://cdn.example.com/ads/spring-ad.mp4";
const CLIP_LOCAL = `${RUNTIME}/test-media/tiny.webm`;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const h = await openHarness();
const { page, browser } = h;
await h.loadDef({
  meta: { id: "sandbox", code: "IMM", title: "IM media", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AD_RATING", type: "single_select", text: "How much do you like the ad?", options: [{ code: 1, label: "Not at all" }, { code: 2, label: "A lot" }] },
    { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand?", options: [{ code: 1, label: "Acme" }, { code: 2, label: "Beta" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
});
await h.goTab("Questions");
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

const turns = () => page.$$('[data-testid="cp-turn"]').then((t) => t.length);
const modelTurn = async (text, fake) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), fake);
  const k = await turns();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 120000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json().catch(() => ({}));
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 60000 });
  await page.waitForTimeout(300);
  return body;
};
const apply = async () => {
  await page.click('[data-testid="cp-tab-changes"]').catch(() => {});
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(900);
};

console.log("\nIM sets a video stimulus with watch-to-continue");
{
  const body = await modelTurn("Turn Q1 into a video rating of the spring ad, and they must watch the video to the end before rating", {
    kind: "proposal", reply: "Q1 becomes a video rating with the spring ad; the rating opens once the clip has been watched to the end.",
    actions: [
      { op: "update_question", target: "Q1", type: "media.video_rating" },
      { op: "set_question_media", target: "Q1", items: [{ url: CLIP_HTTPS, alt: "The 30-second spring ad" }], requireComplete: true },
    ],
  });
  const refused = JSON.stringify(body).match(/"error":"[^"]*"/g) ?? [];
  assert.equal(refused.length, 0, `nothing refused: ${refused.join(" | ")}`);
  await apply();
  const def = await h.readDef();
  const q1 = def.questions.find((q) => q.id === "q1");
  assert.equal(q1.variant, "media.video_rating", "the variant changed");
  assert.equal(q1.settings.mediaUrl, CLIP_HTTPS);
  assert.equal(q1.settings.mediaItems?.[0]?.alt, "The 30-second spring ad");
  assert.equal(q1.settings.requireComplete, true);
  ok("the proposal (update_question + set_question_media) applies: media.video_rating, mediaUrl, alt text, requireComplete");

  const one = { ...def, flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }] };
  const pv = await openPreview(browser, RUNTIME, { definition: one });
  await pv.waitForSelector('[data-qid="q1"] video', { timeout: 20000 });
  const src = await pv.$eval('[data-qid="q1"] video', (v) => v.getAttribute("src") ?? v.querySelector("source")?.getAttribute("src") ?? "");
  assert.equal(src, CLIP_HTTPS, "the runtime's <video> plays the stored address");
  ok("the runtime draws the stored https clip as the question's <video>");
  await pv.close();

  const local = structuredClone(one);
  local.questions.find((q) => q.id === "q1").settings.mediaUrl = CLIP_LOCAL;
  local.questions.find((q) => q.id === "q1").settings.mediaItems[0].url = CLIP_LOCAL;
  const pv2 = await openPreview(browser, RUNTIME, { definition: local });
  await pv2.waitForSelector('[data-qid="q1"] video', { timeout: 20000 });
  await pv2.waitForSelector('[data-testid="rating-locked"]', { timeout: 20000 });
  assert.equal(await pv2.$eval('[data-testid="rating-fieldset"]', (f) => f.disabled), true, "the rating is disabled until the clip ends");
  ok("watch-to-continue is enforced by the runtime: the rating is locked until the clip has been watched (local clip)");
  await pv2.close();
}

console.log("\nan http address is refused by the gate");
{
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  const body = await modelTurn("Show the pack shot on Q2", {
    kind: "proposal", reply: "Adding the pack shot to Q2.",
    actions: [{ op: "set_question_media", target: "Q2", items: [{ url: "http://cdn.example.com/pack.jpg", alt: "Pack" }] }],
  });
  const text = JSON.stringify(body);
  assert.match(text, /https address or the survey's media library/, text.slice(0, 600));
  ok("set_question_media with an http address is refused with the reason");
}

console.log(`\n${passed} passed`);
await browser.close();
