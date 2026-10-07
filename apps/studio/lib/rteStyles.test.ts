import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceHtml, restoreSurfaceHtml } from "./rteStyles.ts";

/*
 * The visual editor shows an author's stylesheet scoped to itself, never to
 * the Studio, and reading it back gives the author's CSS exactly.
 */
const DOC = `<style>
body { display: flex; }
.chess-board { display: grid; grid-template-columns: repeat(8, 60px); }
</style><div class="chess-board"><div class="square">♜</div></div>`;

test("surfaceHtml — scoped to the editor surface; restoreSurfaceHtml — the original back, byte for byte", () => {
  const shown = surfaceHtml(DOC, "rte1");
  assert.match(shown, /\[data-rte-scope="rte1"\] \.chess-board \{ display: grid;/);
  assert.match(shown, /\[data-rte-scope="rte1"\] \{ display: flex; \}/, "body{} is the surface, not the Studio");
  assert.doesNotMatch(shown.replace(/data-rte-src="[^"]*"/, ""), /(^|[^\]] )\.chess-board \{/, "no unscoped rule reaches the Studio");
  assert.equal(restoreSurfaceHtml(shown), DOC);
  assert.equal(surfaceHtml(shown, "rte1"), shown, "showing twice does not scope twice");
  assert.equal(surfaceHtml("<b>plain</b>", "x"), "<b>plain</b>");
  assert.equal(restoreSurfaceHtml("<b>plain</b>"), "<b>plain</b>");
});
