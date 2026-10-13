import { test } from "node:test";
import assert from "node:assert/strict";
import { shareView } from "./shareView.ts";

const row = { id: "s1", token: "tok-abcdefghijklmnopqrstuvwxyz", password_hash: "$2b$secret", allowed_emails: ["a@x.com", "b@x.com"], allowed_user_ids: ["u1", "u2"], access: "users" };

test("a manager sees the link and the people; the password hash is never shown", () => {
  const v = shareView(row, true);
  assert.equal(v.token, row.token);
  assert.deepEqual(v.allowed_emails, row.allowed_emails);
  assert.equal(v.password_hash, undefined);
  assert.equal(v.has_password, true);
  assert.equal(v.can_manage, true);
});

test("a read-only member sees that the share exists and for how many, but cannot lift the link or any email address (R-10)", () => {
  const v = shareView(row, false);
  assert.equal(v.token, undefined);
  assert.equal(v.allowed_emails, undefined);
  assert.equal(v.allowed_user_ids, undefined);
  assert.equal(v.password_hash, undefined);
  assert.equal(v.allowed_count, 2);
  assert.equal(v.can_manage, false);
  assert.ok(!JSON.stringify(v).includes("@x.com") && !JSON.stringify(v).includes("secret") && !JSON.stringify(v).includes("tok-"));
});
