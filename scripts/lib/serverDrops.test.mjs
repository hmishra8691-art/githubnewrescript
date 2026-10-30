import { test } from "node:test";
import assert from "node:assert/strict";
import { dropNote, isServerDrop } from "./serverDrops.mjs";

const O = "http://localhost:3000";

test("a refused or reset request to the Studio is a server drop", () => {
  assert.equal(isServerDrop(`${O}/api/copilot/operations`, "net::ERR_CONNECTION_RESET", O), true);
  assert.equal(isServerDrop(`${O}/api/copilot/turn`, "net::ERR_CONNECTION_REFUSED", O), true);
  assert.equal(isServerDrop(`${O}/api/copilot/task?surveyId=sandbox`, "net::ERR_EMPTY_RESPONSE", O), true);
});

test("other origins, aborts and tunnel failures are not", () => {
  assert.equal(isServerDrop("https://fonts.googleapis.com/css2", "net::ERR_TUNNEL_CONNECTION_FAILED", O), false);
  assert.equal(isServerDrop("http://localhost:3001/preview", "net::ERR_CONNECTION_REFUSED", O), false, "the runtime is another server");
  assert.equal(isServerDrop(`${O}/api/copilot/turn`, "net::ERR_ABORTED", O), false, "the page cancelled it");
  assert.equal(isServerDrop(`${O}/api/copilot/turn`, "", O), false);
  assert.equal(isServerDrop("not a url", "net::ERR_CONNECTION_RESET", O), false);
});

test("the note names the first drop, and is empty when there was none", () => {
  assert.equal(dropNote([]), "");
  const n = dropNote([{ at: "2026-10-30T22:22:06.546Z", method: "PATCH", path: "/api/copilot/operations", error: "net::ERR_CONNECTION_RESET" }, { at: "x", method: "GET", path: "/y", error: "net::ERR_CONNECTION_REFUSED" }]);
  assert.match(n, /dropped 2 requests/);
  assert.match(n, /PATCH \/api\/copilot\/operations \(net::ERR_CONNECTION_RESET\)/);
  assert.match(n, /environmental/);
});

test("a browser that died is named too, with or without dropped requests", () => {
  const n = dropNote([], { what: "disconnected", at: "2026-10-30T22:40:00.000Z" });
  assert.match(n, /the browser disconnected at 2026-10-30T22:40:00\.000Z/);
  assert.doesNotMatch(n, /dropped/);
});
