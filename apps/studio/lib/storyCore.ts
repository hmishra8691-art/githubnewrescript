/**
 * STORY REPORTS — the rules, free of the database and of Next.
 *
 * A story report is saved as versions. An edit from the storyboard arrives
 * as a whole definition; before it is kept it is checked against the
 * version it replaces:
 *   - the numbers are not the editor's to change: a scene that keeps its id
 *     keeps its frozen chart data, table and statistic exactly (a new run
 *     regenerates them, a person does not);
 *   - every chart type is valid for its data;
 *   - ids are unique and the title scene stays first.
 * The status shown is derived from the definition, its checks and its
 * renders — never a flag someone forgot to clear.
 */
import type { StoryReport, Scene, QaReport } from "@rescript/analytics/story";
import { chartAllowed, chartWords, STORY_SCHEMA } from "@rescript/analytics/story";

export type StoryStatus = "draft" | "ready_for_review" | "validation_required" | "ready_to_render" | "rendering" | "completed" | "failed";

export interface DefinitionCheck { ok: boolean; errors: string[] }

const dataOf = (s: Scene): unknown => {
  const v = s.visual;
  if (v.type === "chart") return v.data;
  if (v.type === "table") return v.table;
  if (v.type === "stat") return [v.value, v.detail];
  if (v.type === "kpis") return v.items.map((k) => [k.label, k.value]);
  if (v.type === "verdicts") return v.items.map((k) => [k.label, k.verdict, k.reason]);
  if (v.type === "facts") return v.items.map((k) => [k.label, k.value]);
  return null;
};

/** the numbers a piece of text states (1,234 · 3.5 · 45% · .001) */
export function numbersIn(text: string): string[] {
  return (text.match(/(?<![\w.])-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g) ?? []).map((n) => n.replace(/,/g, "").replace(/^(-?)\./, "$10."));
}
const sceneText = (s: Scene): string => [s.title, s.subtitle, s.body, s.kicker, s.voiceover, s.visual.type === "bullets" ? s.visual.items.join(" ") : ""].filter(Boolean).join(" ");

const HEX = /^#[0-9a-fA-F]{6}$/;
const FAMILIES = new Set(["Inter", "Source Serif 4", "Montserrat"]);
/** a design is drawn into SVG and PowerPoint XML: every colour a hex code, every font a bundled one, the logo an image */
export function designProblems(d: unknown): string[] {
  const out: string[] = [];
  const x = d as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!x || typeof x !== "object" || !x.colors || !x.typography || !x.video) return ["The design is incomplete."];
  for (const [k, v] of Object.entries(x.colors as Record<string, unknown>)) {
    if (k === "chart") { if (!Array.isArray(v) || !v.length || v.length > 12 || v.some((c) => typeof c !== "string" || !HEX.test(c))) out.push("Chart colours must be 1–12 hex codes."); }
    else if (typeof v !== "string" || !HEX.test(v)) out.push(`The colour “${k}” must be a hex code like #1F3A5F.`);
  }
  for (const k of ["heading", "body", "numeric"]) if (!FAMILIES.has(x.typography[k])) out.push(`The ${k} font must be Inter, Source Serif 4 or Montserrat.`);
  if (x.logo != null) {
    if (typeof x.logo.dataUri !== "string" || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(x.logo.dataUri)) out.push("The logo must be a PNG, JPEG, GIF or WebP image.");
    else if (x.logo.dataUri.length > 2_000_000) out.push("The logo is too large to embed (keep it under 1.5 MB).");
    if (!(x.logo.width > 0 && x.logo.height > 0)) out.push("The logo needs its width and height (its proportions are kept).");
  }
  if (!["16:9", "9:16", "1:1"].includes(x.video.aspect)) out.push("The video is 16:9, 9:16 or 1:1.");
  if (![720, 1080, 1440, 2160].includes(x.video.height)) out.push("The video resolution is 720, 1080, 1440 or 2160.");
  if (![24, 25, 30].includes(x.video.fps)) out.push("The frame rate is 24, 25 or 30.");
  if (x.video.targetDurationSec != null && !(x.video.targetDurationSec >= 10 && x.video.targetDurationSec <= 3600)) out.push("A target length is 10 seconds to an hour.");
  return out;
}

/** is an edited definition acceptable as the next version of `previous`? */
export function checkEditedDefinition(next: unknown, previous: StoryReport): DefinitionCheck {
  const errors: string[] = [];
  const r = next as StoryReport;
  if (!r || typeof r !== "object" || !Array.isArray(r.scenes) || typeof r.title !== "string" || !r.design) return { ok: false, errors: ["Not a story report definition."] };
  if (r.schema !== STORY_SCHEMA) errors.push(`Unknown definition schema ${String(r.schema)}.`);
  if (!r.title.trim()) errors.push("The report needs a title.");
  if (r.scenes.length > 120) errors.push("A report has at most 120 scenes.");
  errors.push(...designProblems(r.design));
  const ids = new Set<string>();
  for (const s of r.scenes) {
    if (!s || typeof s.id !== "string" || !s.id) { errors.push("Every scene needs an id."); continue; }
    if (ids.has(s.id)) errors.push(`Scene id “${s.id}” is used twice.`);
    ids.add(s.id);
    if (typeof s.title !== "string" || !s.title.trim()) errors.push(`Scene “${s.id}” needs a title.`);
    if (s.duration !== "auto" && (typeof s.duration !== "number" || s.duration < 1 || s.duration > 120)) errors.push(`Scene “${s.title}”: a duration is automatic or 1–120 seconds.`);
    if (s.visual?.type === "chart") {
      const ok = chartAllowed(s.visual.chart, s.visual.data);
      if (!ok.ok) errors.push(`“${s.title}”: ${chartWords(s.visual.chart)} cannot show this data — ${ok.why}`);
    }
    const before = previous.scenes.find((p) => p.id === s.id);
    if (before && JSON.stringify(dataOf(before)) !== JSON.stringify(dataOf(s))) errors.push(`“${s.title}”: its numbers come from the analysis run and cannot be edited. Regenerate the report from a new run to change them.`);
    /* numbers typed into text must be numbers the analysis gave: the scene's own (or, for a new scene, the report's) */
    const known = new Set(numbersIn(before ? `${sceneText(before)} ${JSON.stringify(before.visual)}` : JSON.stringify(previous.scenes.map((x) => [sceneText(x), x.visual]))));
    for (const k of [...known]) { const v = Number(k); if (Number.isFinite(v)) for (const d of [0, 1, 2]) { known.add(String(Number(v.toFixed(d)))); known.add(v.toFixed(d)); } }
    known.add(String(r.scenes.indexOf(s) + 1));
    const invented = numbersIn(sceneText(s)).filter((n) => !known.has(n) && !/^(19|20)\d\d$/.test(n) && !/^[1-9]$/.test(n));
    if (invented.length) errors.push(`“${s.title}”: ${invented.slice(0, 3).join(", ")} ${invented.length === 1 ? "is a number" : "are numbers"} the analysis did not produce. Numbers in the text must come from the results.`);
    if (!before && dataOf(s) !== null) errors.push(`“${s.title}”: a new scene can carry text, not data — add data scenes by regenerating from the analysis plan.`);
  }
  const main = r.scenes.filter((s) => s.section === "main");
  if (!main.length) errors.push("The main story needs at least one scene.");
  else if (main[0].kind !== "title" && previous.scenes.some((s) => s.kind === "title")) errors.push("The title scene stays first.");
  return { ok: errors.length === 0, errors };
}

/** the status the workspace shows */
export function statusFor(args: { stored: string; qa: Pick<QaReport, "critical"> | null; activeRender: boolean; lastRender: { status: string; version: number } | null; version: number }): StoryStatus {
  if (args.activeRender) return "rendering";
  if (args.qa && args.qa.critical.length) return "validation_required";
  if (args.lastRender && args.lastRender.version === args.version) {
    if (args.lastRender.status === "completed") return "completed";
    if (args.lastRender.status === "failed") return "failed";
  }
  if (args.stored === "ready_to_render" || args.stored === "ready_for_review") return args.stored;
  return "draft";
}

export interface VersionDiff { added: string[]; removed: string[]; moved: string[]; changed: { id: string; title: string; fields: string[] }[]; design: string[] }

/** what changed between two versions, scene by scene and in the design */
export function diffVersions(a: StoryReport, b: StoryReport): VersionDiff {
  const ai = new Map(a.scenes.map((s, i) => [s.id, { s, i }]));
  const bi = new Map(b.scenes.map((s, i) => [s.id, { s, i }]));
  const added = b.scenes.filter((s) => !ai.has(s.id)).map((s) => s.title);
  const removed = a.scenes.filter((s) => !bi.has(s.id)).map((s) => s.title);
  const common = a.scenes.filter((s) => bi.has(s.id)).map((s) => s.id);
  const orderB = b.scenes.filter((s) => ai.has(s.id)).map((s) => s.id);
  const moved = common.filter((id, i) => orderB[i] !== id).map((id) => bi.get(id)!.s.title);
  const changed: VersionDiff["changed"] = [];
  for (const id of common) {
    const x = ai.get(id)!.s, y = bi.get(id)!.s;
    const fields = (["title", "subtitle", "body", "kicker", "voiceover", "layout", "emphasis", "duration", "section"] as const).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])) as string[];
    if (JSON.stringify(x.visual) !== JSON.stringify(y.visual)) fields.push(x.visual.type === "chart" && y.visual.type === "chart" && x.visual.chart !== y.visual.chart ? `chart (${chartWords(x.visual.chart)} → ${chartWords(y.visual.chart)})` : "visual");
    if (JSON.stringify(x.motion) !== JSON.stringify(y.motion)) fields.push("motion");
    if (fields.length) changed.push({ id, title: y.title, fields });
  }
  const design: string[] = [];
  const da = a.design as unknown as Record<string, unknown>, db = b.design as unknown as Record<string, unknown>;
  for (const k of Object.keys({ ...da, ...db })) if (JSON.stringify(da[k]) !== JSON.stringify(db[k])) design.push(k);
  return { added, removed, moved, changed, design };
}

/** a short sentence for a version list */
export function describeDiff(d: VersionDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} scene${d.added.length === 1 ? "" : "s"} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.moved.length) parts.push(`${d.moved.length} moved`);
  if (d.changed.length) parts.push(`${d.changed.length} edited`);
  if (d.design.length) parts.push(`design (${d.design.slice(0, 4).join(", ")})`);
  return parts.join(", ") || "no changes";
}

/** storage keys: segments are content-addressed per survey; artifacts are unique per render */
export const REPORTS_BUCKET = "rescript-reports";
export const segmentPath = (surveyId: string, hash: string) => `${surveyId}/segments/${hash}.mp4`;
export const artifactPath = (surveyId: string, storyId: string, version: number, renderId: string, ext: "mp4" | "pptx" | "srt") => `${surveyId}/stories/${storyId}/v${version}-${renderId}.${ext}`;

/** how long a finished artifact is kept (days), from REPORT_ARTIFACT_RETENTION_DAYS, default 90 */
export function retentionDays(): number {
  const n = Number(process.env.REPORT_ARTIFACT_RETENTION_DAYS ?? "");
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.round(n) : 90;
}

/** a file name for a download */
export function downloadName(title: string, version: number, kind: "video" | "pptx" | "srt" | "html"): string {
  const base = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 80) || "report";
  return `${base}_v${version}.${kind === "video" ? "mp4" : kind}`;
}
