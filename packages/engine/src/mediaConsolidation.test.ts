import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Option } from "@rescript/schema";
import {
  createResponseState, effectiveQuestion, resolveQuestionMedia, sanitizeHtml,
  mediaDisplayCss, mediaDisplayFromCss, mediaHtml, expandMediaEmbeds, unescapeHtml, legacyQuestionMediaHtml,
  type EvalContext,
} from "./index.js";

/*
 * MEDIA, CONSOLIDATED (1-10-26 review): one Insert-media dialog for the
 * question text, an image pop-up for an option's picture, players in text,
 * and piped image URLs that survive an "&".
 */

const ctxOf = (def: SurveyDefinition): EvalContext => ({ def, state: createResponseState(def, { seed: 1 }), loop: null });
function survey(questions: unknown[]) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "media", version: "1.0" },
    embeddedData: [{ name: "ImageURL", source: "url" }],
    questions,
    flow: [{ type: "page", id: "p1", questionIds: (questions as { id: string }[]).map((q) => q.id) }, { type: "end", id: "e", status: "complete" }],
  });
}

test("padding and spacing are part of a picture's display, and read back from its style", () => {
  const css = mediaDisplayCss({ width: 100, padding: 8, spacing: "12px", align: "right" });
  assert.match(css, /width: 100px/);
  assert.match(css, /padding: 8px/);
  assert.match(css, /margin-top: 12px; margin-bottom: 12px/);
  assert.match(css, /margin-left: auto; margin-right: 0/);
  assert.deepEqual(mediaDisplayFromCss(css), { width: "100px", padding: "8px", spacing: "12px", align: "right" });
  /* one-sided margin is somebody's custom CSS, not "spacing" — it survives as written */
  const one = mediaDisplayFromCss("max-width: 100%; margin-top: 4px");
  assert.equal(one.spacing, undefined);
  assert.equal(one.css, "margin-top: 4px");
  assert.equal(mediaDisplayFromCss("margin-top: 3px; margin-bottom: 9px").css, "margin-top: 3px; margin-bottom: 9px");
});

test("an option carries its own picture settings; an option without them is unchanged", () => {
  const o = Option.parse({ code: 1, label: "A", imageUrl: "/a.png", imageDisplay: { width: "100", align: "center", padding: "4" } });
  assert.deepEqual(o.imageDisplay, { width: "100", align: "center", padding: "4" });
  assert.equal(Option.parse({ code: 1, label: "A" }).imageDisplay, undefined);
});

test("a player in text is stored as a placeholder and becomes the player only for a YouTube / Vimeo / Drive URL", () => {
  const slot = mediaHtml("embed", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", { width: 480, align: "center" }, { alt: "Brand film" });
  assert.ok(!/<iframe/i.test(slot), "no frame in the stored HTML");
  assert.match(slot, /data-rs-media="embed"/);
  const stored = sanitizeHtml(slot);
  assert.equal(stored, slot, "the sanitiser keeps the placeholder as it is");
  const shown = expandMediaEmbeds(stored);
  assert.match(shown, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ[^"]*" title="Brand film"/);
  assert.match(shown, /class="rs-embed-frame rs-embed-inline"[^>]*style="width: 480px;[^"]*margin-left: auto; margin-right: auto"/);
  assert.match(shown, /sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"/);
  /* Drive and Vimeo too */
  assert.match(expandMediaEmbeds(mediaHtml("embed", "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", {})), /<iframe src="https:\/\/drive\.google\.com\/file\/d\/1AbCdEfGhIjKlMnOp\/preview"/);
  assert.match(expandMediaEmbeds(mediaHtml("embed", "https://vimeo.com/76979871", {})), /<iframe src="https:\/\/player\.vimeo\.com\/video\/76979871/);
  /* anything else is removed, not framed */
  assert.equal(expandMediaEmbeds(mediaHtml("embed", "https://evil.example/page", {})), "");
  assert.equal(expandMediaEmbeds('<div data-rs-media="embed" data-rs-src="javascript:alert(1)">x</div>'), "");
  /* a hand-written iframe never survives the sanitiser in the first place */
  assert.ok(!/<iframe/i.test(expandMediaEmbeds(sanitizeHtml('<iframe src="https://evil.example"></iframe>'))));
  /* text around it is untouched */
  assert.equal(expandMediaEmbeds("<p>Hello <b>there</b></p>"), "<p>Hello <b>there</b></p>");
});

test("a picture whose piped source came out empty is dropped, not drawn broken", () => {
  assert.equal(expandMediaEmbeds('<p>A</p><img src="" alt="x" style="width: 10px"><p>B</p>'), "<p>A</p><p>B</p>");
  assert.equal(expandMediaEmbeds('<video src="" controls></video>'), "");
  assert.equal(expandMediaEmbeds('<img src="/a.png" alt="">'), '<img src="/a.png" alt="">', "a real one stays");
});

test("Prince 9: a URL parameter piped into an image URL keeps its & — in an option picture and the question's media", () => {
  const def = survey([
    { id: "q1", code: "Q1", variableName: "Q1", type: "image_select", text: "Pick",
      options: [{ code: 1, label: "A", imageUrl: "{{ImageURL}}" }, { code: 2, label: "B", imageUrl: "/b.png" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "html", text: "Look", settings: { mediaUrl: "{{ImageURL}}" } },
  ]);
  const ctx = ctxOf(def);
  ctx.state.embedded.ImageURL = "https://cdn.example/p.jpg?w=400&sig=a\"b";
  const opts = effectiveQuestion(def.questions[0], ctx).options;
  assert.equal(opts[0].imageUrl, 'https://cdn.example/p.jpg?w=400&sig=a"b', "a URL, not HTML: no &amp;");
  assert.equal(opts[1].imageUrl, "/b.png");
  assert.equal(resolveQuestionMedia(def.questions[1], ctx).mediaUrl, 'https://cdn.example/p.jpg?w=400&sig=a"b');
  assert.equal(unescapeHtml("a&amp;b&lt;c&gt;&quot;&#39;"), "a&b<c>\"'");
});

test("a piped picture in the question text: the value lands in the src, escaped for HTML", async () => {
  const { resolvePiping } = await import("./index.js");
  const def = survey([{ id: "q1", code: "Q1", variableName: "Q1", type: "html", text: '<img src="{{ImageURL}}" alt="">' }]);
  const ctx = ctxOf(def);
  ctx.state.embedded.ImageURL = "/p.png?a=1&b=2";
  const html = expandMediaEmbeds(sanitizeHtml(resolvePiping(def.questions[0].text, ctx)));
  assert.equal(html, '<img src="/p.png?a=1&amp;b=2" alt="">', "an attribute: & escaped once, read back by the browser as &");
  ctx.state.embedded.ImageURL = "javascript:alert(1)";
  assert.ok(!/javascript:/i.test(sanitizeHtml(resolvePiping(def.questions[0].text, ctx))), "a script URL never reaches the src");
  ctx.state.embedded.ImageURL = "";
  assert.equal(expandMediaEmbeds(sanitizeHtml(resolvePiping(def.questions[0].text, ctx))), "", "no value → no picture");
});

test("the old under-the-text media moves into the text: every item, its size and alignment, side by side kept", () => {
  const one = legacyQuestionMediaHtml({ settings: { mediaUrl: "/a.png", mediaDisplay: { width: 90, align: "right" } } } as never);
  assert.match(one, /^<div><img src="\/a\.png" alt="" style="width: 90px;[^"]*margin-left: auto; margin-right: 0" data-rs-media="image"><\/div>$/);
  const many = legacyQuestionMediaHtml({ settings: {
    mediaLayout: "horizontal",
    mediaItems: [{ id: "1", url: "/a.png", alt: "Pack A" }, { id: "2", url: "" }, { id: "3", url: "https://youtu.be/dQw4w9WgXcQ" }, { id: "4", url: "{{ImageURL}}" }, { id: "5", url: "/clip.mp4" }],
  } } as never);
  assert.match(many, /^<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start">/);
  assert.match(many, /<img src="\/a\.png" alt="Pack A"/);
  assert.match(many, /data-rs-src="https:\/\/youtu\.be\/dQw4w9WgXcQ" data-rs-media="embed"/, "a YouTube link becomes a player");
  assert.match(many, /<img src="\{\{ImageURL\}\}"/, "a piped URL stays piped");
  assert.match(many, /<video src="\/clip\.mp4"/);
  assert.equal((many.match(/data-rs-media=/g) ?? []).length, 4, "the empty slot is not carried");
  assert.equal(legacyQuestionMediaHtml({ settings: {} } as never), "");
});
