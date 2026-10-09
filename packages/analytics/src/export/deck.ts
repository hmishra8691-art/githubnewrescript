import type { AnalysisResult, ReportTheme } from "../types.js";
import { DEFAULT_THEME } from "../types.js";
import type { DeckDefinition, DeckSlide } from "../deck.js";
import { PptxCtor, addTable, drawAnalysisVisual, hex, type Pres, type Slide } from "./pptx.js";

/**
 * THE DECK DESIGN SYSTEM (Research Engine audit, Phase 5).
 *
 * One type ramp, one palette, one grid, and a slide builder per story
 * slide type. The analytical charts stay flat and native (editable in
 * PowerPoint, no perspective — the audit is explicit that 3D distorts the
 * comparisons a chart exists to make); the dimensional treatment goes
 * where it helps a reader and harms nothing: the cover, the section
 * dividers, the statistic callout cards and the so-what band, which carry
 * a soft shadow and layered panels. Significance is annotated in words and
 * a badge, never implied by a colour alone.
 */
export interface DeckStyle {
  /** the type ramp, in points */
  type: { display: number; title: number; headline: number; body: number; caption: number; stat: number };
  /** panel geometry, in inches */
  radius: number;
  gutter: number;
  shadow: { type: "outer"; blur: number; offset: number; angle: number; color: string; opacity: number };
}
export const DECK_STYLE: DeckStyle = {
  type: { display: 36, title: 22, headline: 17, body: 12, caption: 9, stat: 40 },
  radius: 0.08, gutter: 0.5,
  shadow: { type: "outer", blur: 6, offset: 2, angle: 90, color: "1B2233", opacity: 0.18 },
};

export interface DeckPptxInput {
  deck: DeckDefinition;
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  author?: string;
  footer?: string;
  /** pictures of charts the renderer drew, keyed by analysis id (maps and the like) */
  images?: Record<string, string>;
}

const W = 10, H = 5.625;

/** Build the deck as a 16:9 PowerPoint — one builder per slide type. */
export async function buildDeckPptx(input: DeckPptxInput): Promise<Buffer> {
  const theme = input.theme ?? DEFAULT_THEME;
  const st = DECK_STYLE;
  const p = new PptxCtor();
  p.layout = "LAYOUT_16x9";
  p.title = input.deck.title;
  p.author = input.author ?? "Rescript";
  const font = theme.fontFamily.split(",")[0].trim();
  const heading = (theme.headingFontFamily ?? theme.fontFamily).split(",")[0].trim();
  const primary = hex(theme.colors.primary), secondary = hex(theme.colors.secondary), accent = hex(theme.colors.accent), text = hex(theme.colors.text), subtle = hex(theme.colors.subtle), bg = hex(theme.colors.background);
  const palette = theme.colors.palette.map(hex);
  const ctx = { font, text, subtle, primary, palette };
  const footer = input.footer ?? theme.footer ?? "";
  let no = 0;
  const g = st.gutter;

  const frame = (s: Slide, title?: string, kicker?: string) => {
    no++;
    s.background = { color: bg };
    if (kicker) s.addText(kicker.toUpperCase(), { x: g, y: 0.22, w: W - 2 * g, h: 0.22, fontSize: st.type.caption, bold: true, color: primary, fontFace: font, charSpacing: 2 });
    if (title) s.addText(title, { x: g, y: kicker ? 0.42 : 0.3, w: W - 2 * g, h: 0.7, fontSize: st.type.title, bold: true, color: text, fontFace: heading, valign: "top", fit: "shrink" });
    if (footer) s.addText(footer, { x: g, y: H - 0.38, w: W - 2 * g - 0.8, h: 0.25, fontSize: st.type.caption - 1, color: subtle, fontFace: font });
    s.addText(String(no), { x: W - g - 0.6, y: H - 0.38, w: 0.6, h: 0.25, fontSize: st.type.caption - 1, color: subtle, align: "right", fontFace: font });
    if (theme.logoUrl?.startsWith("data:")) s.addImage({ data: theme.logoUrl, x: W - g - 1.1, y: 0.22, w: 1.1, h: 0.45 });
  };
  const card = (s: Slide, box: { x: number; y: number; w: number; h: number }, fill = "FFFFFF") => {
    s.addShape(p.ShapeType.roundRect, { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: fill }, line: { color: "E5E9F0", width: 0.5 }, rectRadius: st.radius, shadow: st.shadow } as never);
  };
  const badge = (s: Slide, x: number, y: number, label: string, ok: boolean) => {
    s.addShape(p.ShapeType.roundRect, { x, y, w: 1.55, h: 0.26, fill: { color: ok ? accent : subtle }, line: { color: ok ? accent : subtle }, rectRadius: 0.13 });
    s.addText(label, { x, y, w: 1.55, h: 0.26, fontSize: st.type.caption, bold: true, color: "FFFFFF", align: "center", valign: "middle", fontFace: font });
  };
  const bullets = (s: Slide, items: string[], box: { x: number; y: number; w: number; h: number }, size = st.type.body) => {
    s.addText(items.map((t) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 6 } })) as never, { x: box.x, y: box.y, w: box.w, h: box.h, fontSize: size, color: text, fontFace: font, valign: "top", fit: "shrink" } as never);
  };

  for (const slide of input.deck.slides) {
    const s = p.addSlide();
    switch (slide.type) {
      case "title": {
        no++;
        s.background = { color: hex(theme.cover?.background ?? theme.colors.primary) };
        const tc = hex(theme.cover?.textColor ?? "#ffffff");
        // a layered panel: the dimensional treatment belongs on the cover, not on a chart
        s.addShape(p.ShapeType.roundRect, { x: g, y: 1.3, w: W - 2 * g, h: 2.6, fill: { color: secondary, transparency: 55 }, line: { color: secondary, transparency: 100 }, rectRadius: 0.12, shadow: st.shadow } as never);
        s.addText(slide.title, { x: g + 0.4, y: 1.5, w: W - 2 * g - 0.8, h: 1.3, fontSize: st.type.display, bold: true, color: tc, fontFace: heading, valign: "top", fit: "shrink" });
        s.addText(slide.subtitle, { x: g + 0.4, y: 2.85, w: W - 2 * g - 0.8, h: 0.5, fontSize: st.type.headline - 2, color: tc, fontFace: font });
        s.addText(`${slide.date}${slide.client ? ` · for ${slide.client}` : ""} · ${slide.audience} edition`, { x: g, y: H - 0.9, w: W - 2 * g, h: 0.4, fontSize: st.type.body - 1, color: tc, fontFace: font });
        if (theme.logoUrl?.startsWith("data:")) s.addImage({ data: theme.logoUrl, x: g, y: 0.4, w: 1.6, h: 0.7 });
        break;
      }
      case "summary": {
        frame(s, slide.title, "Summary");
        card(s, { x: g, y: 1.2, w: W - 2 * g, h: 0.95 }, "F5F7FA");
        s.addText(slide.headline, { x: g + 0.25, y: 1.25, w: W - 2 * g - 0.5, h: 0.85, fontSize: st.type.headline, bold: true, color: primary, fontFace: heading, valign: "middle", fit: "shrink" });
        bullets(s, slide.bullets, { x: g, y: 2.3, w: W - 2 * g, h: H - 2.3 - 0.5 });
        break;
      }
      case "section": {
        no++;
        s.background = { color: secondary };
        s.addShape(p.ShapeType.rect, { x: g, y: 2.2, w: 1.2, h: 0.06, fill: { color: accent }, line: { color: accent } });
        s.addText(slide.title, { x: g, y: 2.35, w: W - 2 * g, h: 0.9, fontSize: st.type.display - 6, bold: true, color: "FFFFFF", fontFace: heading });
        if (slide.subtitle) s.addText(slide.subtitle, { x: g, y: 3.25, w: W - 2 * g, h: 0.6, fontSize: st.type.body + 2, color: "FFFFFF", fontFace: font, fit: "shrink" });
        break;
      }
      case "key_finding": {
        frame(s, slide.title, slide.beyond ? "Beyond the plan" : slide.hypothesis ? `Key finding · ${slide.hypothesis}` : "Key finding");
        const result = slide.analysisId ? input.results[slide.analysisId] : undefined;
        const chartBox = { x: g, y: 1.2, w: 5.7, h: 3.35 };
        if (result) drawAnalysisVisual(p, s, result, slide.chart, theme, chartBox, ctx, { tableBox: { x: g, w: 5.7 }, fontSize: 8, maxRows: 10, image: slide.analysisId ? input.images?.[slide.analysisId] : undefined });
        else { card(s, chartBox, "F5F7FA"); s.addText("Chart data not available in this export", { x: chartBox.x, y: chartBox.y, w: chartBox.w, h: chartBox.h, fontSize: st.type.caption, color: subtle, align: "center", valign: "middle", fontFace: font }); }
        // the so-what band: a card with the badge and the one sentence that says why it matters
        const bx = g + 5.7 + 0.3, bw = W - g - bx;
        card(s, { x: bx, y: 1.2, w: bw, h: 3.35 });
        badge(s, bx + 0.2, 1.38, slide.significant ? "SIGNIFICANT" : "NOT SIGNIFICANT", slide.significant);
        s.addText("So what", { x: bx + 0.2, y: 1.8, w: bw - 0.4, h: 0.25, fontSize: st.type.caption, bold: true, color: subtle, fontFace: font, charSpacing: 2 });
        s.addText(slide.soWhat, { x: bx + 0.2, y: 2.05, w: bw - 0.4, h: 1.75, fontSize: st.type.body, color: text, fontFace: font, valign: "top", fit: "shrink" });
        s.addText(slide.evidence, { x: bx + 0.2, y: 3.85, w: bw - 0.4, h: 0.6, fontSize: st.type.caption, italic: true, color: subtle, fontFace: font, valign: "bottom", fit: "shrink" });
        break;
      }
      case "segment_comparison": {
        frame(s, slide.title, "Segment comparison");
        const result = slide.analysisId ? input.results[slide.analysisId] : undefined;
        const left = { x: g, y: 1.2, w: 5.4, h: 3.35 };
        if (result && slide.chart) drawAnalysisVisual(p, s, result, slide.chart, theme, left, ctx, { tableBox: { x: g, w: 5.4 }, fontSize: 8, maxRows: 10 });
        else {
          const rows = slide.groups.map((gr) => ({ group: gr.label, value: Number(gr.value), n: gr.n }));
          addTable(s, { id: "groups", title: slide.measure, columns: [{ key: "group", label: "Group" }, { key: "value", label: slide.measure, type: "number", decimals: 2 }, { key: "n", label: "n", type: "count" }], rows }, theme, { x: g, y: 1.2, w: 5.4 }, 10, 9);
        }
        const bx = g + 5.4 + 0.3, bw = W - g - bx;
        card(s, { x: bx, y: 1.2, w: bw, h: 3.35 });
        s.addText("Who differs", { x: bx + 0.2, y: 1.35, w: bw - 0.4, h: 0.25, fontSize: st.type.caption, bold: true, color: subtle, fontFace: font, charSpacing: 2 });
        s.addText(slide.differs, { x: bx + 0.2, y: 1.62, w: bw - 0.4, h: 1.5, fontSize: st.type.body, color: text, fontFace: font, valign: "top", fit: "shrink" });
        s.addText(slide.groups.map((gr) => ({ text: `${gr.label}: ${gr.value} (n = ${gr.n})`, options: { breakLine: true } })) as never, { x: bx + 0.2, y: 3.15, w: bw - 0.4, h: 1.3, fontSize: st.type.caption, color: subtle, fontFace: font, valign: "top", fit: "shrink" } as never);
        break;
      }
      case "statistical_highlight": {
        frame(s, slide.title, "Statistical highlight");
        // the callout card: the statistic large, the words beside it
        card(s, { x: g, y: 1.3, w: 3.6, h: 3.0 }, "F5F7FA");
        s.addText(slide.stat, { x: g + 0.2, y: 1.5, w: 3.2, h: 1.2, fontSize: st.type.stat, bold: true, color: primary, fontFace: heading, align: "center", valign: "middle", fit: "shrink" });
        s.addText(slide.label, { x: g + 0.2, y: 2.75, w: 3.2, h: 0.4, fontSize: st.type.headline - 3, bold: true, color: text, fontFace: font, align: "center" });
        s.addText(`${slide.test}, ${slide.p} · n = ${slide.n}`, { x: g + 0.2, y: 3.2, w: 3.2, h: 0.9, fontSize: st.type.caption + 1, color: subtle, fontFace: font, align: "center", valign: "top", fit: "shrink" });
        const bx = g + 3.6 + 0.35, bw = W - g - bx;
        s.addText(slide.context, { x: bx, y: 1.4, w: bw, h: 0.8, fontSize: st.type.body, color: text, fontFace: font, valign: "top", fit: "shrink" });
        if (slide.pairs) { s.addText("Pairs that differ", { x: bx, y: 2.3, w: bw, h: 0.25, fontSize: st.type.caption, bold: true, color: subtle, fontFace: font, charSpacing: 2 }); s.addText(slide.pairs, { x: bx, y: 2.55, w: bw, h: 1.7, fontSize: st.type.body - 1, color: text, fontFace: font, valign: "top", fit: "shrink" }); }
        break;
      }
      case "implications": {
        frame(s, slide.title, "Implications");
        bullets(s, slide.bullets, { x: g, y: 1.2, w: W - 2 * g, h: H - 1.2 - 0.5 });
        break;
      }
      case "recommendations": {
        frame(s, slide.title, "Recommendations");
        s.addText(slide.items.map((t, i) => ({ text: t, options: { bullet: { type: "number" as const, indent: 18 }, breakLine: true, paraSpaceAfter: 7 } })) as never, { x: g, y: 1.2, w: W - 2 * g, h: H - 1.2 - 0.5, fontSize: st.type.body, color: text, fontFace: font, valign: "top", fit: "shrink" } as never);
        break;
      }
      case "method": {
        frame(s, slide.title, "Method");
        const rows = slide.items.map((it) => ({ label: it.label, value: it.value }));
        addTable(s, { id: "method", title: "Method", columns: [{ key: "label", label: "" }, { key: "value", label: "" }], rows }, theme, { x: g, y: 1.2, w: W - 2 * g }, 12, 10);
        break;
      }
      case "caveats": {
        frame(s, slide.title, "Caveats");
        bullets(s, slide.bullets, { x: g, y: 1.2, w: W - 2 * g, h: H - 1.2 - 0.5 }, st.type.body - 1);
        break;
      }
    }
  }
  const out = await p.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
