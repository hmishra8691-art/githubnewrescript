import { test } from "node:test";
import assert from "node:assert/strict";
import { providerObjectStore } from "@rescript/media";
import { MemoryStorageProvider } from "@rescript/storage";
import { SurveyDefinition } from "@rescript/schema";
import { buildProposalDocx, buildResearchPlanDocx } from "@rescript/analytics/export";
import { REPORT_THEMES, reportThemeHash } from "@rescript/analytics";
import { FakeDb } from "../../../../scripts/lib/fakeSupabase.mjs";
import {
  artifactFingerprint, artifactCapability, artifactState, definitionHash, editionOf, storageKey, versionsToPrune, visibleTo, GENERATOR_VERSION, DOCX_MIME, KEEP_VERSIONS, SIGNED_URL_SECONDS,
  type FingerprintInputs,
} from "./core.ts";
import { obtainArtifact, artifactLink, listArtifacts, persistArtifact, readArtifact, ARTIFACTS_BUCKET, sha256, type ArtifactDeps, type Produced } from "./service.ts";

/*
 * PERSISTENT DOCUMENT ARTIFACTS (2026-10-18) — over the in-memory database and the in-memory object store:
 * one generation per content version (fingerprint), reuse without generation, a new version when the inputs
 * change or on request, history kept, signed links minted per download and refreshed without regenerating,
 * missing / corrupt files refused with clear errors, private artifacts and project isolation enforced.
 */

const SURVEY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ANA = "aaaaaaaa-0000-4000-8000-000000000002";
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "BRAND26", title: "Brand study" }, research: { objective: "Why people choose Brand A", hypotheses: ["Trust drives intent"] },
  questions: [{ id: "q1", code: "Q1", variableName: "TRUST", type: "single_select", text: "Do you trust Brand A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }],
  flow: [{ type: "page", id: "p", questionIds: ["q1"] }],
});

function setup(clock = { t: Date.parse("2026-10-18T09:00:00Z") }) {
  const db = new FakeDb();
  (db.tables as Record<string, unknown[]>).artifacts = [];
  const provider = new MemoryStorageProvider({ baseUrl: "https://store.test", now: () => new Date(clock.t) });
  const store = providerObjectStore(provider as never);
  const deps: ArtifactDeps = { db: db as never, store, now: () => new Date(clock.t) };
  let generations = 0;
  const generate = (d = def, theme?: (typeof REPORT_THEMES)[number]) => async (): Promise<Produced> => {
    generations++;
    const bytes = await buildResearchPlanDocx(d, { date: "2026-10-18", ...(theme ? { theme } : {}) });
    return { bytes, fileName: "BRAND26_Research_Plan_2026-10-18.docx", mime: DOCX_MIME, summary: "Research plan: 1 hypothesis" };
  };
  return { db, provider, store, deps, clock, generate, generations: () => generations };
}
const inputs = (d = def, theme?: (typeof REPORT_THEMES)[number]): FingerprintInputs => ({ type: "research_plan_docx", edition: "standard", definition: { hash: definitionHash(d), revision: 1 }, theme: theme ? { ref: theme.id!, version: theme.version ?? 1, hash: reportThemeHash(theme) } : null, generator: GENERATOR_VERSION });
const ask = (fp: string, userId: string | null = OWNER, extra: Partial<Parameters<typeof obtainArtifact>[1]> = {}) => ({ surveyId: SURVEY, type: "research_plan_docx" as const, edition: "standard", fingerprint: fp, userId, customerId: "cust-1", inputs: { generator: GENERATOR_VERSION }, ...extra });
const allow = () => true;

test("the fingerprint is the content version: same inputs → same; the definition, theme, data, edition or generator → another", () => {
  const a = artifactFingerprint(inputs());
  assert.equal(artifactFingerprint(inputs()), a);
  assert.equal(artifactFingerprint({ ...inputs(), definition: { hash: definitionHash(JSON.parse(JSON.stringify(def))), revision: 1 } }), a, "key order / a JSON round trip does not change it");
  const changed = structuredClone(def); changed.research!.hypotheses.push("Price matters");
  assert.notEqual(artifactFingerprint(inputs(changed)), a, "a design change");
  assert.notEqual(artifactFingerprint(inputs(def, REPORT_THEMES[0])), a, "a theme");
  assert.notEqual(artifactFingerprint(inputs(def, REPORT_THEMES[0])), artifactFingerprint(inputs(def, REPORT_THEMES[1])), "another theme");
  assert.notEqual(artifactFingerprint({ ...inputs(), generator: "next" }), a, "a new generator");
  const findings: FingerprintInputs = { ...inputs(), type: "findings_docx", edition: "client", data: { stamp: "120:2026-10-18T08:00:00Z", environment: "LIVE", dataset: "clean", latestRunId: "r1" }, narrative: "auto" };
  assert.notEqual(artifactFingerprint({ ...findings, data: { ...findings.data!, stamp: "121:2026-10-18T08:05:00Z" } }), artifactFingerprint(findings), "new responses");
  assert.notEqual(artifactFingerprint({ ...findings, edition: "executive" }), artifactFingerprint(findings), "another edition");
  assert.match(a, /^rese-[0-9a-f]{16}$/);
  assert.equal(editionOf("research_plan_docx", "executive"), "standard");
  assert.equal(editionOf("findings_pptx", "board"), "client");
  assert.equal(editionOf("findings_pptx", "executive"), "executive");
  assert.equal(storageKey(SURVEY, "findings_pptx", "executive", 3, "abc"), `${SURVEY}/artifacts/findings_pptx/executive/v3-abc.pptx`);
  assert.equal(artifactState("x", "x"), "current"); assert.equal(artifactState("x", "y"), "stale"); assert.equal(artifactState("x", null), "current");
  assert.deepEqual(versionsToPrune([1, 2, 3, 4, 5, 6, 7].map((version) => ({ version }))).map((r) => r.version), [2, 1]);
});

test("generated once, then downloaded without generating: the second ask and a reload reuse the stored, checked file", async () => {
  const s = setup();
  const fp = artifactFingerprint(inputs());
  const first = await obtainArtifact(s.deps, ask(fp), s.generate());
  assert.ok(first.ok && !first.reused && first.row, JSON.stringify(first));
  assert.equal(s.generations(), 1);
  const row = (first as { row: Record<string, unknown> }).row;
  assert.equal(row.version, 1); assert.equal(row.checksum, sha256((first as { bytes: Uint8Array }).bytes));
  assert.equal(row.storage_key, storageKey(SURVEY, "research_plan_docx", "standard", 1, String(row.id)));
  assert.ok(!JSON.stringify(row).includes("X-Signature"), "no signed URL is stored");
  const again = await obtainArtifact(s.deps, ask(fp), s.generate());
  assert.ok(again.ok && again.reused);
  assert.equal(s.generations(), 1, "no generation on the second ask");
  assert.deepEqual(Buffer.from((again as { bytes: Uint8Array }).bytes), Buffer.from((first as { bytes: Uint8Array }).bytes), "the same bytes");
  /* the reload: the list restores the line, the link downloads it — still one generation */
  const listed = await listArtifacts(s.deps, { surveyId: SURVEY, userId: OWNER, may: allow });
  assert.ok(listed.ok && listed.lines.length === 1 && listed.lines[0].latest.id === row.id);
  const link = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: String(row.id), userId: OWNER, can: allow });
  assert.ok(link.ok, JSON.stringify(link));
  const got = await s.provider.handleRequest({ method: "GET", url: (link as { link: { url: string } }).link.url });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(got.body as Uint8Array).length, Number(row.size_bytes));
  assert.equal(s.generations(), 1, "a download never generates");
});

test("a changed design is a new version (the old one kept as history); an explicit regenerate makes one even when nothing changed", async () => {
  const s = setup();
  const fp1 = artifactFingerprint(inputs());
  await obtainArtifact(s.deps, ask(fp1), s.generate());
  const changed = structuredClone(def); changed.research!.hypotheses.push("Price matters");
  const fp2 = artifactFingerprint(inputs(changed));
  /* the list knows a new version is available before anything is generated */
  const before = await listArtifacts(s.deps, { surveyId: SURVEY, userId: OWNER, may: allow });
  assert.equal(before.ok && artifactState(before.lines[0].latest.fingerprint, fp2), "stale");
  const v2 = await obtainArtifact(s.deps, ask(fp2), s.generate(changed));
  assert.ok(v2.ok && !v2.reused && v2.row?.version === 2);
  const regen = await obtainArtifact(s.deps, ask(fp2, OWNER, { regenerate: true }), s.generate(changed));
  assert.ok(regen.ok && !regen.reused && regen.row?.version === 3, JSON.stringify(regen.ok && regen.row));
  assert.equal(s.generations(), 3);
  const listed = await listArtifacts(s.deps, { surveyId: SURVEY, userId: OWNER, may: allow });
  assert.ok(listed.ok);
  const line = listed.lines[0];
  assert.deepEqual(line.versions.map((v) => v.version), [3, 2, 1], "every earlier version is kept");
  assert.equal(artifactState(line.latest.fingerprint, fp2), "current", "the regenerated version is the current one");
  assert.equal(s.db.tables.artifacts.filter((r) => r.status === "ready").length, 1, "one ready version; the rest superseded");
  /* an earlier version still downloads */
  const old = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: line.versions[2].id, userId: OWNER, can: allow });
  assert.ok(old.ok && old.link.version === 1);
});

test("history is kept to the last versions: older objects are removed from storage", async () => {
  const s = setup();
  let d = def;
  for (let i = 0; i < KEEP_VERSIONS + 2; i++) {
    d = structuredClone(d); d.research!.hypotheses.push(`H${i}`);
    await obtainArtifact(s.deps, ask(artifactFingerprint(inputs(d))), s.generate(d));
  }
  const live = s.db.tables.artifacts.filter((r) => !r.deleted_at);
  assert.equal(live.length, KEEP_VERSIONS);
  assert.equal(s.provider.objects.size, KEEP_VERSIONS, "pruned versions' files are gone from storage");
  assert.deepEqual(s.db.tables.artifacts.filter((r) => r.deleted_at).map((r) => r.version).sort(), [1, 2]);
});

test("an expired signed link is refreshed by asking again — a new link, no regeneration", async () => {
  const s = setup();
  const r = await obtainArtifact(s.deps, ask(artifactFingerprint(inputs())), s.generate());
  const id = String((r as unknown as { row: { id: string } }).row.id);
  const a = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: id, userId: OWNER, can: allow });
  assert.ok(a.ok);
  assert.equal(Date.parse(a.link.expiresAt) - s.clock.t, SIGNED_URL_SECONDS * 1000);
  s.clock.t += (SIGNED_URL_SECONDS + 10) * 1000;
  const stale = await s.provider.handleRequest({ method: "GET", url: a.link.url });
  assert.equal(stale.status, 403, "the old link has expired");
  const b = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: id, userId: OWNER, can: allow });
  assert.ok(b.ok && b.link.url !== a.link.url);
  assert.equal((await s.provider.handleRequest({ method: "GET", url: b.link.url })).status, 200);
  assert.equal(s.generations(), 1, "refreshing the link generated nothing");
});

test("missing, truncated and tampered files are refused with clear errors; a reuse retires the damaged copy and makes a new one", async () => {
  const s = setup();
  const fp = artifactFingerprint(inputs());
  const r = await obtainArtifact(s.deps, ask(fp), s.generate());
  const row = (r as { row: Record<string, unknown> }).row;
  const key = `reports/${row.storage_key}`;
  const original = s.provider.objects.get(key)!;
  /* tampered: same size, different bytes */
  const bad = new Uint8Array(original.body); bad[bad.length - 30] ^= 0xff;
  s.provider.objects.set(key, { ...original, body: bad });
  let l = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: String(row.id), userId: OWNER, can: allow });
  assert.ok(!l.ok && l.status === 422 && l.code === "artifact_corrupt" && /does not match what was saved/.test(l.error), JSON.stringify(l));
  /* a file whose checksum matches the row but is not a Word package (the row was written for garbage) */
  const garbage = new TextEncoder().encode("<html>an error page saved as a document</html>");
  const fake = { ...row, size_bytes: garbage.length, checksum: sha256(garbage) };
  s.provider.objects.set(key, { ...original, body: garbage });
  const read = await readArtifact(s.deps, fake);
  assert.ok(!read.ok && read.code === "artifact_corrupt" && /damaged: the file is not a ZIP/.test(read.error), JSON.stringify(read));
  /* missing */
  s.provider.objects.delete(key);
  l = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: String(row.id), userId: OWNER, can: allow });
  assert.ok(!l.ok && l.status === 410 && l.code === "artifact_missing" && /missing from storage/.test(l.error));
  /* asking for the document again: the missing copy is retired, a new version made, and the answer says why */
  const again = await obtainArtifact(s.deps, ask(fp), s.generate());
  assert.ok(again.ok && !again.reused && again.row?.version === 2 && /missing from storage.*A new copy was made/.test(again.note ?? ""), JSON.stringify(again.ok && again.note));
  assert.equal(s.db.tables.artifacts.find((x) => x.id === row.id)!.status, "deleted");
});

test("access: another member's PRIVATE artifact is 403, another project's is 404 (isolation), a report needs analytics.export", async () => {
  const s = setup();
  const priv = await obtainArtifact(s.deps, ask(artifactFingerprint(inputs()), OWNER, { visibility: "private" }), s.generate());
  const id = String((priv as unknown as { row: { id: string } }).row.id);
  const asAna = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: id, userId: ANA, can: allow });
  assert.ok(!asAna.ok && asAna.status === 403 && asAna.code === "artifact_private");
  assert.equal(((await listArtifacts(s.deps, { surveyId: SURVEY, userId: ANA, may: allow })) as { lines: unknown[] }).lines.length, 0, "Ana does not see it listed");
  /* Ana asking for the same document makes her own (the owner's private copy is not reused for her) */
  const hers = await obtainArtifact(s.deps, ask(artifactFingerprint(inputs()), ANA, { visibility: "private" }), s.generate());
  assert.ok(hers.ok && !hers.reused && hers.row?.owner_id === ANA);
  /* isolation: the id from one project asked through another */
  const cross = await artifactLink(s.deps, { surveyId: OTHER, artifactId: id, userId: OWNER, can: allow });
  assert.ok(!cross.ok && cross.status === 404, "no existence oracle across projects");
  assert.equal(((await listArtifacts(s.deps, { surveyId: OTHER, userId: OWNER, may: allow })) as { lines: unknown[] }).lines.length, 0);
  /* capability by type: the findings deck needs analytics.export to download, analytics.read to list */
  assert.equal(artifactCapability("findings_pptx", "download"), "analytics.export");
  assert.equal(artifactCapability("findings_docx", "list"), "analytics.read");
  assert.equal(artifactCapability("research_plan_docx", "download"), "project.read");
  const deck = await persistArtifact(s.deps, { surveyId: SURVEY, customerId: null, userId: OWNER, type: "findings_pptx", edition: "client", fingerprint: "find-0000000000000001", inputs: {}, bytes: (await buildProposalDocx(def, {})), fileName: "deck.pptx", mime: DOCX_MIME });
  assert.ok(deck.ok);
  const viewer = await artifactLink(s.deps, { surveyId: SURVEY, artifactId: String(deck.row.id), userId: ANA, can: (c) => c !== "analytics.export" });
  assert.ok(!viewer.ok && viewer.status === 403 && viewer.code === "artifact_forbidden" && /export/.test(viewer.error));
  const lines = await listArtifacts(s.deps, { surveyId: SURVEY, userId: ANA, may: (t) => t !== "findings_pptx" });
  assert.ok(lines.ok && !lines.lines.some((l) => l.type === "findings_pptx"), "a line the caller may not list is not listed");
  assert.equal(visibleTo({ visibility: "private", owner_id: OWNER }, null), false);
});

test("two requests racing on the same inputs end with one stored document; a database without 0064 still sends the file", async () => {
  const s = setup();
  const fp = artifactFingerprint(inputs());
  const [a, b] = await Promise.all([obtainArtifact(s.deps, ask(fp), s.generate()), obtainArtifact(s.deps, ask(fp), s.generate())]);
  assert.ok(a.ok && b.ok);
  assert.equal(s.db.tables.artifacts.filter((r) => !r.deleted_at).length, 1, "one row");
  assert.equal(s.provider.objects.size, 1, "the loser's object was taken back");
  const legacy = setup();
  delete (legacy.db.tables as Record<string, unknown>).artifacts;
  const sent = await obtainArtifact(legacy.deps, ask(fp), legacy.generate());
  assert.ok(sent.ok && sent.row === null && sent.bytes.length > 1000 && !sent.reused, "the document is still made and sent");
  assert.equal(sent.ok && sent.note, undefined, "no alarming note: the installation simply does not keep documents yet");
  assert.equal(legacy.provider.objects.size, 0, "nothing orphaned in storage");
  assert.equal(ARTIFACTS_BUCKET, "rescript-reports");
});
