import type { SurveyDefinition } from "@rescript/schema";
import { docKit, definitionStamp, type DocBlock } from "./docx.js";
import { PptxCtor } from "./pptx.js";
import type { QualExcerpt, QualSegment, QualState } from "../qual/types.js";
import type { HighlightReel, ItemState } from "../qual/highlights.js";
import { CLIP_NOTE } from "../qual/highlights.js";
import { formatTimestamp } from "../qual/transcripts.js";
import type { ThemeSynthesis } from "../qual/synthesis.js";
import type { StudyInsights, GroupComparison } from "../qual/insights.js";
import { OBJECTIVE_WORDS } from "../qual/insights.js";
import type { SynthClaim } from "../qual/evidence.js";
import { FREQUENCY_NOTE } from "../qual/analysis.js";

/**
 * HIGHLIGHT REELS AND THE QUALITATIVE DECK (2026-10-22) — through the same
 * kits as every Rescript document (`docKit` for Word, pptxgenjs for
 * PowerPoint), checked by the route with `checkDocx` / `checkPptx`:
 *
 *   • a HIGHLIGHT LIST (Word or PowerPoint): the reel's quotes in order, each with
 *     speaker, group, session, timestamp and clip range, the researcher's note —
 *     and what changed since an item was added. Clips are listed, not stitched
 *     (no video processing in the Studio);
 *   • the QUALITATIVE DECK (PowerPoint): key findings per objective with quotes,
 *     theme summaries (AI-written, labelled; stale ones marked), the segment
 *     comparison, method and limitations.
 *
 * `redact` prints a copy for a reader without contact details.
 */

const { h1, label, body, muted, divider, gridTable, cover, document, plain } = docKit;

export interface HighlightExportOptions { reel: HighlightReel; states?: Record<string, ItemState>; sources: Record<string, { title: string; date?: string }>; redact?: (t: string) => string; date?: string; author?: string; recordings?: Record<string, boolean> }

const where = (s: HighlightReel["items"][number]["snapshot"], sources: HighlightExportOptions["sources"]) => [sources[s.sourceId]?.title ?? "source", s.speaker, s.group, s.start != null ? formatTimestamp(s.start) : ""].filter(Boolean).join(" · ");
const clipWords = (s: HighlightReel["items"][number]["snapshot"]) => (s.start != null && s.end != null ? `clip ${formatTimestamp(s.start)}–${formatTimestamp(s.end)}` : "no timing");
const stateWords: Record<ItemState, string> = { current: "", changed: "the excerpt was changed since it was added (corrected transcript or re-anchored) — the quote below is as it was added", removed: "the excerpt was removed or rejected since it was added" };

export function buildHighlightsDocx(def: SurveyDefinition, o: HighlightExportOptions): Promise<Buffer> {
  const red = o.redact ?? ((t: string) => t);
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const out: DocBlock[] = [];
  out.push(...cover("Highlight reel", plain(o.reel.name, 90), [`${o.reel.items.length} quote${o.reel.items.length === 1 ? "" : "s"}`, `${date}${o.author ? ` · ${o.author}` : ""}`, `Project: ${def.meta.title}`]));
  if (o.reel.description) out.push(body(o.reel.description));
  out.push(h1("Quotes"));
  o.reel.items.forEach((it, i) => {
    out.push(label(`${i + 1}. ${where(it.snapshot, o.sources)}`));
    out.push(body(`“${red(it.snapshot.quote)}”`));
    out.push(muted(`${clipWords(it.snapshot)}${it.note ? ` · note: ${red(it.note)}` : ""}${o.states?.[it.excerptId] && o.states[it.excerptId] !== "current" ? ` · ${stateWords[o.states[it.excerptId]]}` : ""} · ${it.excerptId}`));
  });
  out.push(h1("Clip list"));
  out.push(gridTable(["#", "Source", "Speaker", "From", "To", "Excerpt"], o.reel.items.map((it, i) => [String(i + 1), o.sources[it.snapshot.sourceId]?.title ?? "", it.snapshot.speaker ?? "", it.snapshot.start != null ? formatTimestamp(it.snapshot.start) : "—", it.snapshot.end != null ? formatTimestamp(it.snapshot.end) : "—", it.excerptId]), [500, 3000, 1500, 1100, 1100, 1800]));
  out.push(muted(CLIP_NOTE));
  if (o.redact) out.push(muted("Personal details are redacted in this copy."));
  out.push(divider());
  out.push(muted(`${definitionStamp(def).text} · generated ${date}`));
  return document(`${plain(o.reel.name, 80)} — highlight reel`, `Highlight reel for ${def.meta.title}`, out, { header: `${def.meta.title} — Highlights`, footer: date });
}

const W = 13.333, H = 7.5;
const NAVY = "1F2A44", MUTED = "5B6475", ACCENT = "2F6FDE";

function newDeck() {
  const pres = new PptxCtor();
  pres.layout = "LAYOUT_WIDE";
  return pres;
}
type Deck = ReturnType<typeof newDeck>;
const titleSlide = (pres: Deck, title: string, sub: string[]) => {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  s.addText(title, { x: 0.7, y: 2.2, w: W - 1.4, h: 1.4, fontSize: 36, bold: true, color: "FFFFFF", fontFace: "Calibri" });
  s.addText(sub.filter(Boolean).join("\n"), { x: 0.7, y: 3.8, w: W - 1.4, h: 1.6, fontSize: 16, color: "D9E1F2", fontFace: "Calibri" });
};
const textSlide = (pres: Deck, title: string, lines: { text: string; quote?: boolean; muted?: boolean }[], foot?: string) => {
  const s = pres.addSlide();
  s.addText(title, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.8, fontSize: 24, bold: true, color: NAVY, fontFace: "Calibri" });
  const runs = lines.slice(0, 14).map((l) => ({ text: l.text, options: { bullet: !l.quote && !l.muted, italic: !!l.quote, color: l.muted ? MUTED : l.quote ? ACCENT : "222222", fontSize: l.quote ? 15 : l.muted ? 12 : 16, breakLine: true, paraSpaceAfter: 6 } }));
  s.addText(runs.length ? runs : [{ text: "—", options: {} }], { x: 0.7, y: 1.3, w: W - 1.4, h: H - 2.2, valign: "top", fontFace: "Calibri" });
  if (foot) s.addText(foot, { x: 0.6, y: H - 0.7, w: W - 1.2, h: 0.4, fontSize: 10, color: MUTED, fontFace: "Calibri" });
};

export async function buildHighlightsPptx(def: SurveyDefinition, o: HighlightExportOptions): Promise<Buffer> {
  const red = o.redact ?? ((t: string) => t);
  const pres = newDeck();
  titleSlide(pres, o.reel.name, [`Highlight reel · ${o.reel.items.length} quotes`, def.meta.title, o.date ?? new Date().toISOString().slice(0, 10)]);
  for (const it of o.reel.items.slice(0, 100)) {
    const s = pres.addSlide();
    s.addText(`“${red(it.snapshot.quote)}”`, { x: 0.9, y: 1.4, w: W - 1.8, h: 3.4, fontSize: 26, italic: true, color: NAVY, fontFace: "Calibri", valign: "middle" });
    s.addText(`— ${where(it.snapshot, o.sources)}`, { x: 0.9, y: 4.9, w: W - 1.8, h: 0.5, fontSize: 16, color: MUTED, fontFace: "Calibri" });
    s.addText([clipWords(it.snapshot), it.note ? `Note: ${red(it.note)}` : "", o.states?.[it.excerptId] && o.states[it.excerptId] !== "current" ? stateWords[o.states[it.excerptId]] : ""].filter(Boolean).join(" · "), { x: 0.9, y: 5.5, w: W - 1.8, h: 0.6, fontSize: 12, color: MUTED, fontFace: "Calibri" });
  }
  textSlide(pres, "About these clips", [{ text: CLIP_NOTE, muted: true }, ...(o.redact ? [{ text: "Personal details are redacted in this copy.", muted: true }] : [])]);
  return (await pres.write({ outputType: "nodebuffer" })) as Buffer;
}

export interface QualDeckOptions { state: QualState; segments: QualSegment[]; insights?: (StudyInsights & { state?: string }) | null; syntheses?: (ThemeSynthesis & { state?: string })[]; comparison?: GroupComparison | null; sources: Record<string, { title: string }>; redact?: (t: string) => string; date?: string; author?: string }

/** the qualitative deck: findings, themes, groups, method and limitations — every AI-written line labelled */
export async function buildQualDeckPptx(def: SurveyDefinition, o: QualDeckOptions): Promise<Buffer> {
  const red = o.redact ?? ((t: string) => t);
  const byId = new Map<string, QualExcerpt>(o.state.excerpts.map((e) => [e.id, e]));
  const q = (c: SynthClaim) => c.excerptIds.map((id) => byId.get(id)).filter((e): e is QualExcerpt => !!e).slice(0, 1).map((e) => ({ text: `“${red(e.quote)}” — ${[o.sources[e.sourceId]?.title, e.speaker].filter(Boolean).join(" · ")}`, quote: true }));
  const claim = (c: SynthClaim) => ({ text: `${red(c.text)}${c.origin === "edited" ? " (edited)" : ""}${c.interpretation ? " — interpretation" : ""}` });
  const pres = newDeck();
  titleSlide(pres, def.qualStudy?.title ?? def.meta.title, ["Qualitative findings", o.date ?? new Date().toISOString().slice(0, 10), o.author ?? ""]);
  const ins = o.insights;
  if (ins) {
    textSlide(pres, "Executive summary", ins.executiveSummary.flatMap((c) => [claim(c), ...q(c)]), `AI-written from cited excerpts${ins.state === "stale" ? " · the coding has changed since — regenerate" : ""}`);
    for (const ob of ins.objectives) textSlide(pres, `${ob.ref} · ${OBJECTIVE_WORDS[ob.status]}`, [{ text: plain(ob.objective, 160), muted: true }, ...(ob.findings.length ? ob.findings.flatMap((c) => [claim(c), ...q(c)]) : [{ text: "Not enough evidence in the coded data to answer this objective." }]), ...(ob.note ? [{ text: ob.note, muted: true }] : [])], "Findings cite the excerpts they rest on");
    if (ins.recommendations.length) textSlide(pres, "Recommendations (interpretation)", ins.recommendations.map(claim), "Interpretation, not findings: each rests on the cited excerpts");
  }
  for (const sy of o.syntheses ?? []) textSlide(pres, sy.themeName, [...sy.summary.flatMap((c) => [claim(c), ...q(c)]), ...sy.bySegment.map((c) => ({ text: `${c.group}: ${red(c.text)}` })), ...sy.contradicting.map((c) => ({ text: `Against: ${red(c.text)}` }))], `${sy.coverage.words} · AI-written${sy.status === "edited" ? ", edited" : ""}${sy.state === "stale" ? " · stale — regenerate" : ""}`);
  if (o.comparison?.rows.length) {
    const c = o.comparison;
    const s = pres.addSlide();
    s.addText(`${c.a} vs ${c.b}`, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.8, fontSize: 24, bold: true, color: NAVY, fontFace: "Calibri" });
    const head = ["Theme", c.a, c.b, "Difference"].map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: NAVY } } }));
    s.addTable([head, ...c.rows.slice(0, 12).map((r) => [r.theme, `${r.a.segments} (${r.a.share}%)`, `${r.b.segments} (${r.b.share}%)`, `${r.difference > 0 ? "+" : ""}${r.difference}`].map((t) => ({ text: t, options: {} })))], { x: 0.6, y: 1.3, w: W - 1.2, fontSize: 13, fontFace: "Calibri", border: { type: "solid", color: "D0D5DD", pt: 0.5 } });
    s.addText(FREQUENCY_NOTE, { x: 0.6, y: H - 0.8, w: W - 1.2, h: 0.5, fontSize: 10, color: MUTED, fontFace: "Calibri" });
  }
  textSlide(pres, "Method and limitations", [
    { text: `${new Set(o.segments.map((s) => s.sourceId)).size} sources, ${o.state.codebook.codes.filter((c) => c.status !== "rejected").length} codes, ${o.state.excerpts.filter((e) => e.status !== "rejected").length} excerpts; coded with AI assistance and human review.` },
    { text: "AI-written lines cite the excerpts they rest on; uncited sentences and numbers the evidence does not give were removed; every count is the Studio's." },
    { text: FREQUENCY_NOTE },
    { text: "Qualitative samples are purposive: the findings describe these participants, not a population." },
    ...(o.redact ? [{ text: "Personal details are redacted in this copy.", muted: true }] : []),
  ], `${definitionStamp(def).text}`);
  return (await pres.write({ outputType: "nodebuffer" })) as Buffer;
}

