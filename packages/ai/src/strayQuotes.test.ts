import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonReply, repairStrayQuotes } from "./index.js";

/* live eval 2026-11-22: five replies were valid JSON except for quotes left unescaped inside strings */
test("a reply with unescaped quotes inside its strings is read, and the quotes are kept as text", () => {
  const reply = 'I\'ll add it.\n\n```json\n{\n  "kind": "proposal",\n  "reply": "I\'ll add **CITY** ("Which city do you live in?") after Q6, in the "Where we stand" block.",\n  "actions": [{ "op": "create_question", "ref": "CITY", "text": "Which city do you live in?", "required": true }],\n  "assumptions": ["Restored to: "How satisfied are you?"", "Optional, say so."]\n}\n```';
  const v = parseJsonReply(reply) as { kind: string; reply: string; actions: { ref: string; required: boolean }[]; assumptions: string[] };
  assert.equal(v.kind, "proposal");
  assert.equal(v.reply, 'I\'ll add **CITY** ("Which city do you live in?") after Q6, in the "Where we stand" block.');
  assert.equal(v.actions[0].ref, "CITY");
  assert.equal(v.actions[0].required, true);
  assert.deepEqual(v.assumptions, ['Restored to: "How satisfied are you?"', "Optional, say so."]);
});

test("valid JSON is unchanged by the repair; raw line breaks in strings are escaped; prose is still not an object", () => {
  const ok = '{"a":"x \\"y\\" z","b":[1,2,{"c":null}],"d":true}';
  assert.equal(repairStrayQuotes(ok), ok);
  assert.deepEqual(JSON.parse(repairStrayQuotes('{"a":"line one\nline two"}')), { a: "line one\nline two" });
  assert.equal(parseJsonReply("I cannot do that, sorry."), null);
});
