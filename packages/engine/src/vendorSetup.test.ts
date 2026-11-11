import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { interpretRequest } from "./nlIntent.js";
import { changeItems } from "./changeItems.js";
import { createResponseState } from "./state.js";
import { advance, start, setAnswer } from "./flow.js";
import { resolveSampleSource } from "./sampleSource.js";
import { checkVendors, readVendorUrls, simulateVendorExits, vendorKey, vendorLink, vendorOf, vendorUrlsIn, vendorsUntouched } from "./vendorSetup.js";

const base = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S1", title: "Study", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{
    id: "q1", code: "Q1", type: "single_select", text: "Age?", variableName: "Q1",
    options: [{ code: 1, label: "Under 18" }, { code: 2, label: "18+" }, { code: 3, label: "Prefer not to say" }],
    skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, target: { kind: "terminate", status: "screened" } }, { id: "sk2", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 3 }, target: { kind: "terminate", status: "terminated" } }],
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
const run = (def: SurveyDefinition, actions: unknown[]) => { const c = coerceSurveyActions(actions as never); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions); };

const A = ["https://acme-sample.com/end?status=complete&rid=[RID]", "https://acme-sample.com/end?status=screenout&rid=[RID]", "https://acme-sample.com/end?status=quotafull&rid=[RID]", "https://acme-sample.com/end?status=quality&rid=[RID]"];
const B = ["https://survey.bravo.io/r/success?uid={{uid}}&proj=771", "https://survey.bravo.io/r/term?uid={{uid}}&proj=771", "https://survey.bravo.io/r/overquota?uid={{uid}}&proj=771", "https://survey.bravo.io/r/security?uid={{uid}}&proj=771"];

/** run the survey to its exit as one respondent */
function exit(def: SurveyDefinition, embedded: Record<string, string>, answer: number) {
  const state = createResponseState(def, { embedded });
  start(def, state, {});
  setAnswer(def, state, "q1", answer);
  return advance(def, state, {});
}

test("the four links are recognised from their own words, with the evidence", () => {
  const r = readVendorUrls(A.map((url) => ({ url })));
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.urls.map((u) => u.outcome), ["complete", "screenout", "quota_full", "terminate"]);
  assert.ok(r.urls.every((u) => u.confidence === "certain" && /the address says/.test(u.evidence)));
  assert.equal(r.idParam, "rid");
  assert.equal(r.redirects.complete, "https://acme-sample.com/end?status=complete&rid={{pid}}");
  assert.deepEqual(r.urls[0].fixed, [{ param: "status", value: "complete" }]);
  assert.equal(r.hostName, "Acme-sample");
});

test("any order; “term” is the screen-out when another link is the quality one, and is said to be worked out", () => {
  const r = readVendorUrls([B[3], B[1], B[0], B[2]].map((url) => ({ url })));
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.urls.map((u) => u.outcome), ["terminate", "screenout", "complete", "quota_full"]);
  assert.equal(r.urls[1].confidence, "inferred");
  assert.equal(r.idParam, "uid");
  assert.equal(r.redirects.screenout, "https://survey.bravo.io/r/term?uid={{pid}}&proj=771");
  assert.deepEqual(r.urls[0].fixed, [{ param: "proj", value: "771" }], "tracking parameters are kept exactly");
});

test("a known panel's documented links are matched to their outcomes (Dynata rst=1…4)", () => {
  const r = readVendorUrls([3, 1, 4, 2].map((n) => ({ url: `https://dkr1.ssisurveys.com/projects/end?rst=${n}&psid=[%psid%]` })));
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.urls.map((u) => u.outcome), ["quota_full", "complete", "terminate", "screenout"]);
  assert.equal(r.preset, "dynata");
});

test("links that only differ by a number are NOT guessed: a question, never the pasted order", () => {
  const r = readVendorUrls([1, 2, 3, 4].map((n) => ({ url: `https://panel.example.com/cb?st=${n}&id=[ID]` })));
  assert.equal(r.urls.filter((u) => u.outcome).length, 0);
  assert.ok(r.questions.some((q) => /cannot tell what these links are for/.test(q)), r.questions.join("|"));
});

test("labels win; a word shared by every link says nothing; missing, duplicate and http links are questions", () => {
  const labelled = vendorUrlsIn("Complete Redirect: https://v.example.com/x?a=1&id=[ID]\nScreened-out Redirect: https://v.example.com/x?a=2&id=[ID]\nQuota-full Redirect: https://v.example.com/x?a=3&id=[ID]\nQuality Check / Termination Redirect: https://v.example.com/x?a=4&id=[ID]");
  assert.deepEqual(labelled.map((u) => u.outcome), ["complete", "screenout", "quota_full", "terminate"]);
  assert.deepEqual(readVendorUrls(labelled).questions, []);
  const folder = readVendorUrls(["a", "b", "c", "d"].map((x) => ({ url: `https://v.example.com/complete/${x}?id=[ID]` })));
  assert.equal(folder.urls.filter((u) => u.outcome).length, 0, "/complete/ on all four is the folder, not the outcome");
  assert.ok(readVendorUrls(A.slice(0, 3).map((url) => ({ url }))).questions.some((q) => /no quality check \/ termination link/.test(q)));
  assert.ok(readVendorUrls([A[0], A[0], A[2], A[3]].map((url) => ({ url }))).questions.some((q) => /same address/.test(q)));
  assert.ok(readVendorUrls([{ url: A[0].replace("https", "http") }]).questions.some((q) => /not an https link/.test(q)));
  assert.ok(readVendorUrls(["complete", "screenout", "quotafull", "quality"].map((s) => ({ url: `https://v.example.com/${s}` }))).questions.some((q) => /place for the respondent's id/.test(q)));
  assert.equal(vendorUrlsIn("Add vendor QualityPanel with these links: https://q.example.com/c?id=[ID]")[0].outcome, undefined, "the vendor's name is not a label");
});

test("add_vendor: a new vendor with its own code; the ends are not written to", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("add_vendor"));
  const r = run(base(), [{ op: "add_vendor", name: "Acme", urls: A }]);
  assert.deepEqual(r.errors, []);
  const p = r.def.panels![0];
  assert.equal(p.key, "acme"); assert.equal(p.label, "Acme"); assert.equal(p.idParam, "rid"); assert.deepEqual(p.targets, ["survey"]);
  const ed = r.def.flow[0] as { id: string; type: string; title?: string; fields: { name: string; source: string }[] };
  assert.equal(ed.id, "ed_vendor_acme"); assert.equal(ed.title, "Vendor Acme (acme)");
  assert.deepEqual(ed.fields.map((f) => `${f.name}:${f.source}`), ["rp:url", "rid:url"]);
  assert.equal((r.def.flow.find((n) => n.type === "end") as { redirectUrl?: string }).redirectUrl, undefined);
  assert.equal(r.def.deployment.sample.sourceParam, "rp");
  assert.equal(vendorLink("https://s.example.com/s/c/st", p), "https://s.example.com/s/c/st?rp=acme&rid=[RID]");
  assert.ok(r.warnings.some((w) => /only vendor.*\?rp=acme&rid=\[RID\]/.test(w)), r.warnings.join("|"));
});

test("ADDITIVE: adding Bravo leaves Acme byte-identical, and each vendor's respondents leave by their own links", () => {
  const a = run(base(), [{ op: "add_vendor", name: "Acme", urls: A }]).def;
  const acmeBefore = JSON.stringify(a.panels![0]);
  const r = run(a, [{ op: "add_vendor", name: "Bravo", urls: B }]);
  assert.deepEqual(r.errors, []);
  const def = r.def;
  assert.deepEqual(def.panels!.map((p) => p.key), ["acme", "bravo"]);
  assert.equal(JSON.stringify(def.panels![0]), acmeBefore);
  assert.equal(vendorsUntouched(a, def, "bravo"), null);
  assert.equal(def.deployment.sample.respondentParam, "rid", "the study's respondent parameter is not replaced by the new vendor's");
  assert.ok(!r.warnings.some((w) => /Acme/.test(w)), "nothing to warn about for the vendor that was not touched");
  const items = changeItems(a, def).items.filter((i) => i.field === "panels");
  assert.equal(items.length, 1);
  assert.equal(items[0].from, undefined, "the change list does not show Acme as rewritten");
  assert.match(items[0].to ?? "", /^Bravo \(bravo\)/);

  const acme = { rp: "acme", rid: "A-001" }, bravo = { rp: "bravo", uid: "B-900" };
  assert.equal(exit(def, acme, 2).redirectUrl, "https://acme-sample.com/end?status=complete&rid=A-001");
  assert.equal(exit(def, bravo, 2).redirectUrl, "https://survey.bravo.io/r/success?uid=B-900&proj=771");
  /* a terminating skip rule had no redirect at all before: now the vendor gets its screen-out / quality link */
  assert.equal(exit(def, acme, 1).redirectUrl, "https://acme-sample.com/end?status=screenout&rid=A-001");
  assert.equal(exit(def, bravo, 1).redirectUrl, "https://survey.bravo.io/r/term?uid=B-900&proj=771");
  assert.equal(exit(def, acme, 3).redirectUrl, "https://acme-sample.com/end?status=quality&rid=A-001");
  assert.equal(exit(def, bravo, 3).redirectUrl, "https://survey.bravo.io/r/security?uid=B-900&proj=771");
  /* without the code, the vendor's own id parameter is enough */
  assert.equal(exit(def, { uid: "B-7" }, 2).redirectUrl, "https://survey.bravo.io/r/success?uid=B-7&proj=771");
  /* nobody's respondent: exactly as before */
  assert.equal(exit(def, {}, 2).redirectUrl, undefined);
  assert.equal(exit(def, {}, 1).redirectUrl, undefined);
  assert.equal(vendorOf(def, {}), null);

  const sims = simulateVendorExits(def);
  assert.equal(sims.length, 8); assert.ok(sims.every((s) => s.ok), JSON.stringify(sims.filter((s) => !s.ok)));
  const check = checkVendors(def);
  assert.ok(check.ok, JSON.stringify(check.checks.filter((c) => !c.ok)));
});

test("a vendor set up the old way (its link written on the end) keeps working, and the new vendor is not sent to it", () => {
  const old = run(base(), [{ op: "connect_panel", panel: "custom", key: "legacy", label: "Legacy", idParam: "pid", redirects: { complete: "https://legacy.example.com/done?pid={{pid}}" } }]).def;
  const end = old.flow.find((n) => n.type === "end") as { redirectUrl?: string };
  assert.equal(end.redirectUrl, "https://legacy.example.com/done?pid={{ed.pid}}");
  const def = run(old, [{ op: "add_vendor", name: "Bravo", urls: B }]).def;
  assert.equal((def.flow.find((n) => n.type === "end") as { redirectUrl?: string }).redirectUrl, "https://legacy.example.com/done?pid={{ed.pid}}", "the end is not rewritten");
  assert.equal(exit(def, { pid: "L-1" }, 2).redirectUrl, "https://legacy.example.com/done?pid=L-1");
  assert.equal(exit(def, { rp: "bravo", uid: "B-2" }, 2).redirectUrl, "https://survey.bravo.io/r/success?uid=B-2&proj=771");
  /* Legacy has no screen-out link: its respondent is not sent to Bravo's */
  assert.equal(exit(def, { pid: "L-1" }, 1).redirectUrl, undefined);
});

test("the survey's own redirect on an end stays for everyone else", () => {
  const d = base();
  (d.flow[1] as { redirectUrl?: string }).redirectUrl = "https://client.example.com/thanks";
  const def = run(d, [{ op: "add_vendor", name: "Acme", urls: A }]).def;
  assert.equal(exit(def, {}, 2).redirectUrl, "https://client.example.com/thanks");
  assert.equal(exit(def, { rp: "acme", rid: "A-5" }, 2).redirectUrl, "https://acme-sample.com/end?status=complete&rid=A-5");
});

test("a full quota sends the vendor's respondent to that vendor's quota-full link — and nobody else anywhere new", () => {
  const d = base();
  d.quotas = [{ id: "qa", name: "Adults", mode: "hard", cells: [{ id: "c1", label: "18+", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 2 }, limit: 1, limitType: "count" }], onFull: { kind: "terminate" }, countStatus: ["complete"] }] as never;
  d.flow.splice(1, 0, { type: "quota_check", id: "qc", quotaIds: ["qa"], onFull: { kind: "terminate" } } as never);
  const def = run(run(d, [{ op: "add_vendor", name: "Acme", urls: A }]).def, [{ op: "add_vendor", name: "Bravo", urls: B }]).def;
  const full = (embedded: Record<string, string>) => { const state = createResponseState(def, { embedded }); start(def, state, { qa: { c1: 1 } }); setAnswer(def, state, "q1", 2); return advance(def, state, { qa: { c1: 1 } }); };
  const a = full({ rp: "acme", rid: "A-9" });
  assert.equal(a.endStatus, "quota_full");
  assert.equal(a.redirectUrl, "https://acme-sample.com/end?status=quotafull&rid=A-9");
  assert.equal(full({ rp: "bravo", uid: "B-9" }).redirectUrl, "https://survey.bravo.io/r/overquota?uid=B-9&proj=771");
  const none = full({});
  assert.equal(none.endStatus, "quota_full"); assert.equal(none.redirectUrl, undefined);
});

test("an existing vendor is never changed by an add: a question first, an update only when asked, and then confirmed", () => {
  const a = run(base(), [{ op: "add_vendor", name: "Acme", urls: A }]).def;
  const again = applySurveyActions(a, coerceSurveyActions([{ op: "add_vendor", name: "acme", urls: B }] as never).actions);
  assert.ok(again.errors.some((e) => /already a vendor on this study \(code acme\).*UPDATE.*SEPARATE/.test(JSON.stringify(e))), JSON.stringify(again.errors));
  assert.equal(JSON.stringify(again.def.panels), JSON.stringify(a.panels));
  const sep = run(a, [{ op: "add_vendor", name: "Acme", urls: B, mode: "new" }]);
  assert.deepEqual(sep.def.panels!.map((p) => `${p.key}|${p.label}`), ["acme|Acme", "acme-2|Acme (acme-2)"]);
  const upd = run(a, [{ op: "add_vendor", name: "Acme", urls: B, mode: "update" }]);
  assert.equal(upd.def.panels!.length, 1);
  assert.equal(upd.def.panels![0].redirects.complete, "https://survey.bravo.io/r/success?uid={{pid}}&proj=771");
  assert.ok(upd.destructive.some((x) => /existing vendor Acme/.test(x)), JSON.stringify(upd.destructive));
  assert.equal(vendorKey(sep.def, "Acme"), "acme-3");
});

test("Intelligent Mode reads the request without a model: a proposal, or a question with the answers", () => {
  const def = base();
  const ok = interpretRequest(def, `Add vendor Acme Research with these redirect links:\n${A.join("\n")}`);
  assert.equal(ok.kind, "actions");
  if (ok.kind !== "actions") return;
  assert.match(ok.understood, /Add Acme Research as a new vendor with its own code, acme-research/);
  const applied = applySurveyActions(def, ok.actions);
  assert.deepEqual(applied.errors, []);
  assert.deepEqual(applied.def.panels![0].redirects, { complete: A[0].replace("[RID]", "{{pid}}"), screenout: A[1].replace("[RID]", "{{pid}}"), quota_full: A[2].replace("[RID]", "{{pid}}"), terminate: A[3].replace("[RID]", "{{pid}}") });

  const unclear = interpretRequest(def, `add vendor Numbers: ${[1, 2, 3, 4].map((n) => `https://panel.example.com/cb?st=${n}&id=[ID]`).join(" ")}`);
  assert.equal(unclear.kind, "clarify");
  if (unclear.kind !== "clarify") return;
  assert.match(unclear.question, /cannot tell/);
  assert.equal(unclear.choices.length, 1);
  const chosen = interpretRequest(def, unclear.choices[0].text);
  assert.equal(chosen.kind, "actions", JSON.stringify(chosen));
  if (chosen.kind === "actions") assert.equal(applySurveyActions(def, chosen.actions).def.panels![0].redirects.quota_full, "https://panel.example.com/cb?st=3&id={{pid}}");

  const withAcme = applied.def;
  const dup = interpretRequest(withAcme, `add vendor Acme Research ${B.join(" ")}`);
  assert.equal(dup.kind, "clarify");
  if (dup.kind !== "clarify") return;
  assert.deepEqual(dup.choices.map((c) => c.label), ["Update Acme Research (acme-research)", "Add as a separate vendor"]);
  const upd = interpretRequest(withAcme, dup.choices[0].text);
  assert.equal(upd.kind, "actions");
  if (upd.kind === "actions") assert.equal((upd.actions[0] as { mode?: string }).mode, "update");
  const sep = interpretRequest(withAcme, dup.choices[1].text);
  assert.equal(sep.kind, "actions");
  if (sep.kind === "actions") assert.deepEqual(applySurveyActions(withAcme, sep.actions).def.panels!.map((p) => p.key), ["acme-research", "acme-research-2"]);

  const ask = interpretRequest(def, "add a new vendor");
  assert.equal(ask.kind, "clarify");
  assert.notEqual(interpretRequest(def, "how do vendors work?").kind, "clarify");
});

test("the vendor code is the response's source, and each vendor's own parameter is its respondent id", () => {
  const def = run(run(base(), [{ op: "add_vendor", name: "Acme", urls: A }]).def, [{ op: "add_vendor", name: "Bravo", urls: B }]).def;
  assert.deepEqual(resolveSampleSource(def, { rp: "bravo", uid: "B-1" }), { source: "bravo", sourceParam: "rp", respondent: "B-1", respondentParam: "uid" });
  assert.deepEqual(resolveSampleSource(def, { rp: "acme", rid: "A-1" }), { source: "acme", sourceParam: "rp", respondent: "A-1", respondentParam: "rid" });
  assert.deepEqual(resolveSampleSource(def, { uid: "B-2" }), { source: "bravo", sourceParam: "uid", respondent: "B-2", respondentParam: "uid" });
  assert.deepEqual(resolveSampleSource(base(), { src: "x", pid: "1" }), { source: "x", sourceParam: "src", respondent: "1", respondentParam: "pid" });
});
