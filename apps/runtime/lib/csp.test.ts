import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeCsp, connectSources, cspMode } from "./csp.ts";

test("RUNTIME_CSP: enforce by default; report and off on request; anything else is enforce", () => {
  assert.equal(cspMode({}), "enforce");
  assert.equal(cspMode({ RUNTIME_CSP: "report" }), "report");
  assert.equal(cspMode({ RUNTIME_CSP: " OFF " }), "off");
  assert.equal(cspMode({ RUNTIME_CSP: "nonsense" }), "enforce");
  assert.deepEqual(buildRuntimeCsp({ RUNTIME_CSP: "off" }), { mode: "off", enforce: null, reportOnly: null });
});

test("connect-src: self plus exactly the origins the runtime's client code talks to, from the environment", () => {
  assert.deepEqual(connectSources({}), ["'self'"]);
  const env = {
    SUPABASE_URL: "https://abc.supabase.co/",
    R2_ACCOUNT_ID: "acct",
    AI_REALTIME_API_URL: "https://api.openai.com/v1",
    LIVEKIT_URL: "wss://demo.livekit.cloud",
    GEOCODE_API_URL: "https://nominatim.example/search",
    RUNTIME_CSP_CONNECT: "https://cdn.example.com/x, not a url",
  };
  const c = connectSources(env);
  assert.deepEqual(c, [
    "'self'", "https://abc.supabase.co", "wss://abc.supabase.co", "https://acct.r2.cloudflarestorage.com",
    "https://api.openai.com", "https://demo.livekit.cloud", "wss://demo.livekit.cloud", "https://*.livekit.cloud", "wss://*.livekit.cloud",
    "https://cdn.example.com",
  ]);
  assert.ok(!c.some((x) => x.includes("nominatim")), "the geocoder is called by the server, not the browser");
  assert.deepEqual(connectSources({ R2_ENDPOINT: "https://r2.example", R2_FORCE_PATH_STYLE: "0", R2_BUCKET: "media" }), ["'self'", "https://r2.example", "https://media.r2.example"]);
  assert.deepEqual(connectSources({ MEDIA_STORAGE: "memory" }), ["'self'", "http://127.0.0.1:4598"]);
});

test("the enforced policy limits connect/form/base/object only; the stricter img/media/script policy is report-only", () => {
  const p = buildRuntimeCsp({ SUPABASE_URL: "https://abc.supabase.co" });
  assert.equal(p.mode, "enforce");
  assert.equal(p.enforce, "connect-src 'self' https://abc.supabase.co wss://abc.supabase.co; form-action 'self'; base-uri 'self'; object-src 'none'");
  assert.doesNotMatch(p.enforce!, /img-src|media-src|script-src|default-src|frame-ancestors|report-uri/);
  assert.match(p.reportOnly!, /script-src 'self'/);
  assert.match(p.reportOnly!, /img-src 'self' data: blob: https:\/\/abc\.supabase\.co/);
  assert.doesNotMatch(p.reportOnly!, /report-uri/, "no report endpoint exists");
  const r = buildRuntimeCsp({ RUNTIME_CSP: "report" });
  assert.equal(r.enforce, null);
  assert.equal(r.reportOnly, "connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'");
});
