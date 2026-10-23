import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  PANEL_PRESETS, panelFromPreset, panelEntryLink, capturePanelEntry, panelRedirect, signPanelUrl, verifyPanelSignature, panelCanonicalString,
  encodeDigest, panelTemplateProblems, panelConfigProblems, outcomeForInterview, outcomeForSurveyEnd, panelReconciliationCsv, panelOutcomeCounts, cleanPanelValue,
  type PanelHasher,
} from "./panels.js";
import { PanelConfig, PanelSigning } from "@rescript/schema";

const hasher: PanelHasher = (alg, data, secret) => {
  if (alg === "hmac-sha256") return createHmac("sha256", secret).update(data, "utf8").digest();
  if (alg === "hmac-sha1") return createHmac("sha1", secret).update(data, "utf8").digest();
  return createHash(alg === "sha256" ? "sha256" : "sha1").update(data + secret, "utf8").digest();
};
const hex = (b: Uint8Array) => encodeDigest(b, "hex");

test("signer: known vectors (RFC 4231 #2, RFC 2202 #2, FIPS 180 'abc')", () => {
  assert.equal(hex(hasher("hmac-sha256", "what do ya want for nothing?", "Jefe")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(hex(hasher("hmac-sha1", "what do ya want for nothing?", "Jefe")), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
  assert.equal(hex(hasher("sha1", "abc", "")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(hex(hasher("sha256", "abc", "")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  /* the salted scheme appends the secret: sha1("ab" + "c") is sha1("abc") */
  assert.equal(hex(hasher("sha1", "ab", "c")), "a9993e364706816aba3e25717850c26c9cd0d89d");
});

test("digest encodings: hex, base64, base64url (pure, matches Buffer)", () => {
  const b = hasher("hmac-sha256", "what do ya want for nothing?", "Jefe");
  assert.equal(encodeDigest(b, "base64"), Buffer.from(b).toString("base64"));
  assert.equal(encodeDigest(b, "base64url"), Buffer.from(b).toString("base64url"));
  assert.equal(encodeDigest(b, "hex", true), Buffer.from(b).toString("hex").toUpperCase());
  for (const n of [1, 2, 3, 4, 5]) { const x = new Uint8Array(n).map((_, i) => 250 - i * 7); assert.equal(encodeDigest(x, "base64"), Buffer.from(x).toString("base64")); }
});

test("sign and verify: url / query / params scopes; tampering and a wrong secret fail", () => {
  const url = "https://panel.example.com/end?status=complete&rid=AB%2012";
  const s = (o: Partial<PanelSigning>) => PanelSigning.parse({ algorithm: "hmac-sha256", ...o });
  const signed = signPanelUrl(url, s({}), "k3y", hasher);
  assert.match(signed, /&hash=[0-9a-f]{64}$/);
  assert.equal(signed.split("&hash=")[1], hex(hasher("hmac-sha256", "https://panel.example.com/end?status=complete&rid=AB+12", "k3y")), "the canonical URL is the WHATWG serialisation, signature left out");
  assert.ok(verifyPanelSignature(signed, s({}), "k3y", hasher));
  assert.ok(!verifyPanelSignature(signed.replace("complete", "completx"), s({}), "k3y", hasher), "a changed status fails");
  assert.ok(!verifyPanelSignature(signed, s({}), "other", hasher), "a wrong secret fails");
  const q = s({ scope: "query", param: "sig", encoding: "base64url", algorithm: "hmac-sha1" });
  assert.equal(panelCanonicalString(signPanelUrl(url, q, "k", hasher), q), "status=complete&rid=AB+12");
  assert.ok(verifyPanelSignature(signPanelUrl(url, q, "k", hasher), q, "k", hasher));
  const p = s({ scope: "params", params: ["rid", "status"], separator: "|", algorithm: "sha256" });
  assert.equal(panelCanonicalString(url, p), "AB 12|complete");
  assert.equal(signPanelUrl(url, p, "salt", hasher).split("hash=")[1], hex(hasher("sha256", "AB 12|complete", "salt")));
  /* re-signing replaces, never stacks */
  assert.equal(signPanelUrl(signPanelUrl(url, s({}), "k3y", hasher), s({}), "k3y", hasher), signed);
});

test("presets: every preset parses, says to verify, and its links are https with known tokens", () => {
  for (const id of Object.keys(PANEL_PRESETS) as (keyof typeof PANEL_PRESETS)[]) {
    const c = panelFromPreset(id, { completionCode: "C0DE1" });
    assert.ok(PanelConfig.safeParse(c).success, id);
    assert.match(PANEL_PRESETS[id].verify, /Verify with the panel's current integration docs/);
    for (const t of Object.values(c.redirects)) assert.deepEqual(panelTemplateProblems(t!, c), [], `${id}: ${t}`);
  }
  const pro = panelFromPreset("prolific", { completionCode: "ABC123" });
  assert.equal(pro.idParam, "PROLIFIC_PID");
  assert.deepEqual(pro.params.map((p) => p.param), ["STUDY_ID", "SESSION_ID"]);
  assert.equal(panelEntryLink("https://r.example.com/i/abc", pro), "https://r.example.com/i/abc?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}");
  assert.equal(panelEntryLink("https://r.example.com/i/abc", pro, { many: true }).split("?")[1].split("&")[0], "rp=prolific");
  assert.deepEqual(panelConfigProblems(pro), []);
  assert.match(panelConfigProblems(panelFromPreset("prolific")).join(" "), /completion code/);
});

test("capture: by rp, by id parameter, the only panel; missing id, macros, legacy pid", () => {
  const pro = panelFromPreset("prolific", { completionCode: "ABC123" });
  const cint = panelFromPreset("cint");
  const both = [pro, cint];
  const a = capturePanelEntry(both, { PROLIFIC_PID: "5f1e2d3c4b5a69788796a5b4", STUDY_ID: "s1", SESSION_ID: "x<script>" }, "ai_interview");
  assert.ok(a.ok && a.panel?.key === "prolific");
  assert.equal(a.ok && a.pid, "5f1e2d3c4b5a69788796a5b4");
  assert.deepEqual(a.ok && a.captured, { STUDY_ID: "s1", SESSION_ID: "xscript" }, "kept values are cleaned");
  const b = capturePanelEntry(both, { rp: "cint", RID: "6c5d2b9e-1f" }, "group_session");
  assert.ok(b.ok && b.panel?.key === "cint" && b.pid === "6c5d2b9e-1f");
  const c = capturePanelEntry([pro], {}, "ai_interview");
  assert.ok(!c.ok && c.reason === "missing_id");
  const d = capturePanelEntry([pro], { PROLIFIC_PID: "{{%PROLIFIC_PID%}}" }, "ai_interview");
  assert.ok(!d.ok && d.reason === "macro", "an unsubstituted macro is not an id");
  const e = capturePanelEntry([], { pid: "panel-42" }, "ai_interview");
  assert.ok(e.ok && e.panel === null && e.pid === "panel-42", "no panel configured: the legacy pid as before");
  const f = capturePanelEntry([{ ...pro, targets: ["survey"] }], { pid: "x" }, "ai_interview");
  assert.ok(f.ok && f.panel === null, "a panel for other links does not apply");
  const g = capturePanelEntry([{ ...pro, enabled: false }], { PROLIFIC_PID: "a" }, "ai_interview");
  assert.ok(!g.ok && g.reason === "disabled");
  assert.equal(cleanPanelValue("a b&c=d"), "abc=d");
  assert.equal(cleanPanelValue(""), null);
});

test("redirects: codes, encoding, fallbacks, missing code, signing with and without the secret", () => {
  const pro = panelFromPreset("prolific", { completionCode: "ABC123", codes: { screenout: "SCR9" } });
  const r = panelRedirect(pro, "complete", { pid: "5f1e" });
  assert.equal(r.url, "https://app.prolific.com/submissions/complete?cc=ABC123");
  assert.equal(r.code, "ABC123"); assert.equal(r.showCode, true);
  assert.equal(panelRedirect(pro, "screenout", { pid: "5f1e" }).url, "https://app.prolific.com/submissions/complete?cc=SCR9");
  const q = panelRedirect(pro, "quota_full", { pid: "5f1e" });
  assert.equal(q.url, null, "no code for quota full → no link (the page asks them to return the study)");
  assert.match(q.problems.join(), /no completion code/);
  const cint = panelFromPreset("cint");
  const unsigned = panelRedirect(cint, "screenout", { pid: "A&B 1" });
  assert.equal(unsigned.url, "https://samplicio.us/router/ClientCallBack.aspx?RIS=20&RID=A%26B%201");
  assert.equal(unsigned.signed, false); assert.match(unsigned.problems.join(), /signing secret is not set/);
  const signed = panelRedirect(cint, "complete", { pid: "R1" }, { secret: "s3cret", hasher });
  assert.ok(signed.signed && /&hash=[A-Za-z0-9_-]+$/.test(signed.url!));
  assert.ok(verifyPanelSignature(signed.url!, cint.signing, "s3cret", hasher));
  const ps = panelFromPreset("purespectrum", { redirects: { over_quota: undefined as never } });
  delete (ps.redirects as Record<string, unknown>).over_quota;
  assert.match(panelRedirect(ps, "over_quota", { pid: "t1" }).url!, /st=17/, "over quota falls back to quota full");
  const tol = panelFromPreset("toluna");
  assert.equal(panelRedirect(tol, "complete", { pid: "g1", captured: { sname: "S 9" } }).url, "https://ups.surveyrouter.com/trafficui/mscui/SOQualified.aspx?sname=S%209&gid=g1");
  const mt = panelFromPreset("mturk", { completionCode: "MT-1" });
  const m = panelRedirect(mt, "complete", { pid: "W1" });
  assert.equal(m.url, null); assert.equal(m.code, "MT-1"); assert.equal(m.showCode, true);
  const bad = PanelConfig.parse({ key: "x", redirects: { complete: "http://localhost/done?id={{pid}}&x={{nope}}" } });
  assert.equal(panelRedirect(bad, "complete", { pid: "1" }).url, null, "an unsafe template sends nobody anywhere");
  assert.match(panelTemplateProblems(bad.redirects.complete!, bad).join(" | "), /https.*public address.*\{\{nope\}\}/);
});

test("outcomes and reconciliation", () => {
  assert.equal(outcomeForInterview("completed"), "complete");
  assert.equal(outcomeForInterview("screened_out"), "screenout");
  assert.equal(outcomeForInterview("flagged"), "terminate");
  assert.equal(outcomeForInterview("in_progress"), null);
  assert.equal(outcomeForInterview("completed", { overQuota: true }), "over_quota");
  assert.equal(outcomeForSurveyEnd("screened"), "screenout");
  assert.equal(outcomeForSurveyEnd("quota_full"), "quota_full");
  const rows = [
    { panel: "prolific", pid: "b", outcome: "complete" as const, target: "ai_interview" },
    { panel: "prolific", pid: "=HYPERLINK(1)", outcome: "screenout" as const, target: "ai_interview" },
    { panel: "prolific", pid: "a", outcome: null, target: "group_session" },
  ];
  const csv = panelReconciliationCsv(rows);
  assert.equal(csv.split("\r\n")[0], "panel,panel_id,outcome,status,link,started_at,ended_at,test");
  assert.match(csv, /'=HYPERLINK\(1\)/, "formula injection neutralised");
  assert.deepEqual(panelOutcomeCounts(rows), { complete: 1, screenout: 1, quota_full: 0, terminate: 0, over_quota: 0, in_progress: 1 });
});
