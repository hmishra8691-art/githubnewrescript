import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENTS, describeEvent } from "@rescript/access";

/**
 * THE PHASE F SWEEP, kept as tests: the places the earlier phases could have
 * missed, each pinned so a later edit cannot quietly reopen them.
 */
const root = new URL("../../../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");
const walk = (dir: string, out: string[] = []): string[] => { for (const f of readdirSync(join(root, dir))) { const p = `${dir}/${f}`; if (/node_modules|\.next|dist/.test(p)) continue; statSync(join(root, p)).isDirectory() ? walk(p, out) : out.push(p); } return out; };

test("the story design assistant is offered by the person's own choice as well as the platform's, and never calls a provider outside the metering door", () => {
  const s = read("apps/studio/lib/storyService.ts");
  const design = s.slice(s.indexOf("designModel:"), s.indexOf("usage: (e)"));
  assert.match(design, /aiReadyFor\(/, "readiness comes from the acting person's resolved connection");
  assert.doesNotMatch(s.slice(s.indexOf("narration:"), s.indexOf("designModel:")), /aiReadyFor|userId: opts/, "background narration stays on the platform's speech service");
  assert.match(design, /meteredAi\(/); assert.match(design, /completeJson\(/);
  assert.doesNotMatch(s, /\.\.\.\(aiConfigured\(\) && opts\.surveyId/, "the old platform-only gate is gone");
  assert.match(s, /opts\.surveyId && opts\.userId/, "offered only to a signed-in person on a project");
});

test("workspace policy: the route is administrator-only, audited, and its event has a sentence", () => {
  const r = read("apps/studio/app/api/admin/ai-policy/route.ts");
  assert.equal((r.match(/requireAdmin\(req\)/g) ?? []).length, 2, "GET and PATCH both gate on a platform administrator first");
  assert.match(r, /audit\(\{ action: "workspace\.ai_byok_policy_changed"/);
  assert.ok((AUDIT_EVENTS as readonly string[]).includes("workspace.ai_byok_policy_changed"));
  const line = describeEvent({ id: 1, action: "workspace.ai_byok_policy_changed", entity: null, entityId: null, userId: "u", actorName: "Ada", detail: { allowed: false, workspace: "Acme" }, createdAt: "2026-10-15T00:00:00Z" });
  assert.match(String(line), /turned off user-managed AI providers for Acme/);
});

test("the operator-facing environment is documented where operators look, with the warning that matters", () => {
  const env = read(".env.example").replace(/\n#\s*/g, " ");
  for (const k of ["AI_CREDENTIAL_KEY=", "AI_CREDENTIAL_KEY_PREVIOUS=", "AI_BYOK_ALLOW_PRIVATE_ENDPOINTS="]) assert.ok(env.includes(k), k);
  assert.match(env, /Back it up/); assert.match(env, /no unencrypted fallback/i); assert.match(env, /Leave off on a shared installation/);
});

test("the tables that hold keys are deny-by-default and nothing in the browser bundle can reach them", () => {
  const m = read("supabase/migrations/0054_user_ai_providers.sql");
  assert.match(m, /enable row level security/); assert.match(m, /force row level security/); assert.match(m, /revoke all on public\.user_ai_credentials from anon, authenticated/);
  assert.doesNotMatch(m, /create policy/i, "no policy: only the service role reads these tables");
  assert.match(m, /on delete cascade/i, "a deleted account takes its keys with it");
  for (const f of walk("apps/studio/components").concat(walk("apps/studio/app").filter((p) => /\.tsx$/.test(p)))) {
    const s = read(f);
    if (!/^"use client"/.test(s)) continue;
    assert.doesNotMatch(s, /user_ai_credentials|user_ai_settings|AI_CREDENTIAL_KEY|byok\/(vault|store|service|resolve)/, `${f} is a client file and must not know the vault`);
  }
});

test("only the account-AI routes and the resolver open a stored key", () => {
  const openers = walk("apps").concat(walk("packages")).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)).filter((f) => /\bopenSecret\(/.test(read(f)));
  assert.deepEqual(openers.sort(), ["apps/studio/lib/byok/resolve.ts", "apps/studio/lib/byok/service.ts", "apps/studio/lib/byok/vault.ts"].sort());
});

test("every route that touches the account AI service authenticates the person first", () => {
  const routes = walk("apps/studio/app/api/account/ai").filter((f) => f.endsWith("route.ts"));
  assert.ok(routes.length >= 6, routes.join(","));
  for (const f of routes) { const s = read(f); assert.match(s, /requireUser\(req\)/, f); assert.ok(s.indexOf("requireUser(req)") < s.indexOf("byokDeps(") || !s.includes("byokDeps("), `${f}: authenticate before reaching the store`); }
});

test("a key can only be rotated by the operator's tool, which never decrypts", () => {
  const r = read("apps/studio/lib/byok/rotate.ts");
  assert.doesNotMatch(r, /openSecret\(/); assert.match(r, /rewrap\(/);
  const routesUsing = walk("apps/studio/app").filter((f) => f.endsWith("route.ts") && /listCredentialsPage|rotateCredentials/.test(read(f)));
  assert.deepEqual(routesUsing, [], "no HTTP route can enumerate every user's credentials");
});
