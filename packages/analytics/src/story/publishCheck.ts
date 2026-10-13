/**
 * THE CHECK A STORY PASSES BEFORE IT IS PUBLISHED (audit Phase 4).
 *
 * The storyboard's layout checks (qa.ts) answer "does this fit on a slide".
 * This answers "can a stranger open it, read it and trust it": every scene has
 * a headline, every figure has a source and numbers a chart can draw, nothing
 * claims a significance test that was not run, text is readable against its
 * background, and the colours that carry data are distinguishable from it.
 * A problem blocks publishing and names the scene; a warning is shown and
 * does not block.
 */
import { contrast } from "./design.js";
import type { Scene, StoryReport } from "./types.js";

export interface PublishIssue { sceneId?: string; code: string; message: string }
export interface PublishCheck { ok: boolean; problems: PublishIssue[]; warnings: PublishIssue[] }

const label = (s: Scene, i: number) => `Scene ${i + 1} (“${(s.title || "untitled").slice(0, 50)}”)`;

export function checkStoryForPublish(story: StoryReport): PublishCheck {
  const problems: PublishIssue[] = [], warnings: PublishIssue[] = [];
  const problem = (code: string, message: string, sceneId?: string) => problems.push({ code, message, ...(sceneId ? { sceneId } : {}) });
  const warn = (code: string, message: string, sceneId?: string) => warnings.push({ code, message, ...(sceneId ? { sceneId } : {}) });
  if (!story.scenes.length) problem("no_scenes", "The story has no scenes.");
  if (!story.title.trim()) problem("no_title", "The story has no title.");
  story.scenes.forEach((s, i) => {
    const where = label(s, i);
    if (!s.title.trim()) problem("no_headline", `${where} has no headline.`, s.id);
    const v = s.visual;
    if (v.type === "chart") {
      const d = v.data;
      if (!d.categories.length || !d.series.length) problem("empty_chart", `${where} has a chart with nothing to draw.`, s.id);
      for (const ser of d.series) {
        if (ser.values.length !== d.categories.length) problem("chart_shape", `${where}: “${ser.name}” has ${ser.values.length} values for ${d.categories.length} categories.`, s.id);
        if (ser.values.some((x) => x != null && !Number.isFinite(x))) problem("chart_number", `${where}: “${ser.name}” holds a value that is not a number.`, s.id);
        if (!d.significanceTested && ser.sig?.some(Boolean)) problem("untested_letters", `${where} shows significance letters but no test was run on these figures.`, s.id);
      }
      if (!s.notes.sources.length && !v.source?.name) problem("no_source", `${where} has a chart with no source.`, s.id);
      if (d.base == null) warn("no_base", `${where} does not say how many respondents the chart is based on.`, s.id);
      else if (d.base < 30) warn("small_base", `${where} is based on ${d.base} respondents — read with care.`, s.id);
    }
    if (v.type === "table") {
      if (!v.table.rows.length) problem("empty_table", `${where} has a table with no rows.`, s.id);
      if (!s.notes.sources.length && !v.source?.name) problem("no_source", `${where} has a table with no source.`, s.id);
    }
    if (s.evidence === "significant" && v.type === "chart" && !v.data.significanceTested) warn("claim_without_test", `${where} says the evidence is supported by a test, but the chart carries no test marks.`, s.id);
  });
  const c = story.design.colors;
  const text = (name: string, fg: string, min: number) => { const r = contrast(fg, c.background); if (r < min) problem("contrast", `${name} (${fg}) on the background (${c.background}) has contrast ${r.toFixed(1)}:1; at least ${min}:1 is needed to be readable.`); };
  text("Body text", c.text, 4.5);
  text("Secondary text", c.textMuted, 4.5);
  text("Link and heading colour", c.primary, 3);
  c.chart.forEach((col, i) => { const r = contrast(col, c.background); if (r < 1.8) warn("chart_contrast", `Chart colour ${i + 1} (${col}) is hard to tell from the background (${r.toFixed(1)}:1).`); });
  if (story.design.logo && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(story.design.logo.dataUri)) warn("logo", "The logo is not an embedded image, so the shared page leaves it out.");
  return { ok: problems.length === 0, problems, warnings };
}
