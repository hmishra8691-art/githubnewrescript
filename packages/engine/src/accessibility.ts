import type { Question, SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { stripHtmlText } from "./html.js";
import type { ResearchBrief } from "./researchBrief.js";

/**
 * ACCESSIBILITY, DEVICES AND THE LOOK, FROM THE DEFINITION (Intelligent Mode IM8, 2026-11-06).
 *
 *   accessibilityReview(def)   what a screen-reader, low-vision, keyboard or motor-impaired respondent would meet —
 *                              colour contrast of the theme's own pairs (WCAG 1.4.3 / 1.4.11), stimulus images with no
 *                              text alternative (1.1.1), time limits with no way to extend (2.2.1), text set below
 *                              16 px (1.4.4 reading comfort), a matrix too wide to read in order, the survey's
 *                              language. Each finding names its criterion and, where one action fixes it, carries it.
 *   deviceReview(def, device)  what a phone does to this survey: wide matrices, long option lists, side-by-side layouts,
 *                              rankings by drag, a fixed width — with the fix in words.
 *   adviseLook(def, brief)     a look keyed on PROPERTIES of the respondents (a professional audience, an older one,
 *                              a mobile-first one, a sensitive topic) — never a research-type table — each choice with
 *                              its because, as one set_theme.
 *
 * All pure: they read the definition the runtime renders; nothing is measured in a browser here, and the review says
 * so — a real assistive-technology check is still a person's job.
 */

/* ------------------------------------------------------------ colour */
const hex = (s: string | undefined): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((s ?? "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const lum = ([r, g, b]: [number, number, number]) => { const f = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
/** WCAG contrast ratio of two colours; null when either is not a hex colour */
export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  const x = hex(a), y = hex(b);
  if (!x || !y) return null;
  const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}
const toHex = (c: [number, number, number]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
/** the nearest colour to `fg` (darkened or lightened, hue kept) that reaches `ratio` against `bg` */
export function accessibleColor(fg: string, bg: string, ratio = 4.5): string {
  const f = hex(fg), b = hex(bg);
  if (!f || !b) return fg;
  if ((contrastRatio(fg, bg) ?? 0) >= ratio) return fg;
  const darker = lum(b) > 0.4;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = f.map((v) => (darker ? v * (1 - t) : v + (255 - v) * t)) as [number, number, number];
    if ((contrastRatio(toHex(c), bg) ?? 0) >= ratio) return toHex(c);
  }
  return darker ? "#000000" : "#ffffff";
}

export interface AccessibilityFinding { criterion: string; level: "error" | "warning"; where: string; message: string; fix?: string; actions?: SurveyAction[] }

const plain = (s: string | undefined, n = 50) => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const px = (s: string | undefined) => { const m = /^(\d+(?:\.\d+)?)px$/.exec((s ?? "").trim()); return m ? Number(m[1]) : null; };

export function accessibilityReview(def: SurveyDefinition): { findings: AccessibilityFinding[]; lines: string[] } {
  const out: AccessibilityFinding[] = [];
  const c = def.branding?.colors ?? ({} as NonNullable<SurveyDefinition["branding"]>["colors"]);
  const pairs: [string, string | undefined, string | undefined, number, string][] = [
    ["text", c.text, c.surface, 4.5, "Question and answer text on the card"],
    ["text", c.text, c.background, 4.5, "Text on the page background"],
    ["subtleText", c.subtleText, c.surface, 4.5, "Instructions and hints"],
    ["buttonText", c.buttonText ?? "#ffffff", c.buttonBackground ?? c.primary, 4.5, "The Next button's label"],
    ["link", c.link ?? c.accent ?? c.primary, c.surface, 4.5, "Links"],
    ["border", c.border, c.surface, 1.5, "Input borders"],
  ];
  const patch: Record<string, string> = {};
  for (const [key, fg, bg, need, where] of pairs) {
    const r = contrastRatio(fg, bg);
    if (r === null || r >= need) continue;
    const fixed = key === "buttonText" ? accessibleColor(c.buttonBackground ?? c.primary ?? "#2563eb", fg ?? "#ffffff", need) : accessibleColor(fg!, bg!, need);
    if (key === "buttonText") patch.buttonBackground = fixed; else patch[key] = fixed;
    out.push({ criterion: key === "border" ? "WCAG 1.4.11 (non-text contrast)" : "WCAG 1.4.3 (contrast)", level: key === "border" ? "warning" : "error", where, message: `${where}: contrast ${r}:1, below ${need}:1.`, fix: key === "buttonText" ? `button colour ${fixed}` : `${key} ${fixed}` });
  }
  if (Object.keys(patch).length) {
    const f = out.find((x) => x.criterion.includes("contrast"))!;
    f.actions = [{ op: "set_theme", patch: { colors: patch }, label: "Accessible contrast" } as SurveyAction];
  }
  const base = px(def.branding?.typography?.baseSize);
  if (base !== null && base < 16) out.push({ criterion: "WCAG 1.4.4 (text size)", level: "warning", where: "Typography", message: `The base text size is ${base}px — below 16px is hard to read on a phone and for older respondents.`, fix: "base size 16px", actions: [{ op: "set_theme", patch: { typography: { baseSize: "16px" } }, label: "Readable text size" } as SurveyAction] });
  for (const q of def.questions) {
    const s = (q.settings ?? {}) as Record<string, unknown> & { accessibility?: { altText?: string; decorative?: boolean }; mediaItems?: { alt?: string }[] };
    const hasStimulus = !!(s.imageUrl || s.mediaUrl || (s.mediaItems as unknown[] | undefined)?.length);
    const items = s.mediaItems ?? [];
    const alt = s.accessibility?.altText || s.accessibility?.decorative || (items.length > 0 && items.every((m) => m.alt !== undefined));
    if (hasStimulus && !alt) out.push({ criterion: "WCAG 1.1.1 (text alternative)", level: "error", where: q.code, message: `${q.code}'s stimulus image or video has no text alternative — a screen reader announces nothing.`, fix: `say what the stimulus shows, e.g. “Set the alt text of ${q.code} to …”` });
    const optsNoAlt = (q.options ?? []).filter((o) => o.imageUrl && !o.label?.trim());
    if (optsNoAlt.length) out.push({ criterion: "WCAG 1.1.1 (text alternative)", level: "error", where: q.code, message: `${optsNoAlt.length} image option${optsNoAlt.length === 1 ? "" : "s"} of ${q.code} ${optsNoAlt.length === 1 ? "has" : "have"} no label to read out.` });
    const limit = (q as Question & { timer?: { limitSeconds?: number } }).timer?.limitSeconds;
    if (limit) out.push({ criterion: "WCAG 2.2.1 (timing adjustable)", level: "warning", where: q.code, message: `${q.code} closes after ${limit} s with no way to extend it — respondents using assistive technology may need longer. Keep it only if the time limit is the measurement.` });
    const scale = (q.columns?.length || q.options?.length) ?? 0;
    if ((q.type === "matrix_single" || q.type === "matrix_multi") && scale > 7) out.push({ criterion: "WCAG 1.3.2 (meaningful sequence)", level: "warning", where: q.code, message: `${q.code} has ${scale} columns — read cell by cell, a screen reader repeats the column header ${scale} times per row.`, fix: "fewer scale points, or one question per row" });
    if (!plain(q.text) && !["hidden", "calculated", "embedded_data", "html"].includes(q.type)) out.push({ criterion: "WCAG 2.4.6 (labels)", level: "error", where: q.code, message: `${q.code} has no question text — nothing labels its answer.` });
  }
  const lines = out.length ? [`${out.filter((f) => f.level === "error").length} error${out.filter((f) => f.level === "error").length === 1 ? "" : "s"} and ${out.filter((f) => f.level === "warning").length} warning${out.filter((f) => f.level === "warning").length === 1 ? "" : "s"} against WCAG 2.1 AA, read from the definition:`, ...out.map((f) => `${f.level === "error" ? "✗" : "!"} ${f.message}${f.fix ? ` Fix: ${f.fix}.` : ""} (${f.criterion})`)] : ["Nothing in the definition fails the WCAG 2.1 AA checks it can be read for: contrast, text alternatives, time limits, text size, labels."];
  lines.push("Read from the definition — a check with a screen reader and a keyboard on the real page is still a person's job.");
  return { findings: out, lines };
}

/* ------------------------------------------------------------ devices */
export interface DeviceFinding { where: string; message: string; fix: string }
export function deviceReview(def: SurveyDefinition, device: "mobile" | "tablet" | "desktop" = "mobile"): { findings: DeviceFinding[]; lines: string[] } {
  const out: DeviceFinding[] = [];
  if (device === "desktop") return { findings: [], lines: ["On a desktop the survey renders at its full layout — nothing narrows."] };
  const narrow = device === "mobile";
  for (const q of def.questions) {
    /* a matrix's columns are its scale (options), or its own columns for the composite kinds */
    const cols = (q.columns?.length || q.options?.length) ?? 0;
    if ((q.type === "matrix_single" || q.type === "matrix_multi" || q.type === "matrix_dropdown") && cols > (narrow ? 5 : 8)) out.push({ where: q.code, message: `${q.code} is a ${cols}-column grid — on a ${device} it scrolls sideways or squeezes the labels.`, fix: narrow ? "the runtime shows it row by row on a phone; check the row labels read on their own" : "fewer columns" });
    const n = q.options?.length ?? 0;
    if ((q.type === "single_select" || q.type === "multi_select") && n > (narrow ? 12 : 20)) out.push({ where: q.code, message: `${q.code} lists ${n} options — a long scroll on a ${device}.`, fix: q.type === "single_select" ? "a dropdown or a searchable list" : "group the options (option groups) or split the question" });
    if (q.type === "ranking" && n > 6 && narrow) out.push({ where: q.code, message: `${q.code} asks to rank ${n} items by dragging — hard with a thumb.`, fix: "rank the top 3, or pick-the-best then rank" });
    if ((q.type === "slider") && narrow) out.push({ where: q.code, message: `${q.code} is a slider — imprecise on a touch screen.`, fix: "show the value, or use buttons for the scale points" });
    if (/<table|width\s*[:=]\s*["']?\d{4,}/i.test(q.text ?? "")) out.push({ where: q.code, message: `${q.code}'s text holds a table or a fixed width — it overflows a ${device} screen.`, fix: "put the content in the question's stimulus or simplify the HTML" });
  }
  const lines = out.length ? [`${out.length} thing${out.length === 1 ? "" : "s"} a ${device} would struggle with:`, ...out.map((f) => `${f.where}: ${f.message} Fix: ${f.fix}.`)] : [`Nothing in the definition is a known ${device} problem (wide grids, long lists, drag ranking, sliders, fixed widths).`];
  return { findings: out, lines };
}

/* ------------------------------------------------------------ the look, from who answers */
export interface LookAdvice { patch: Record<string, unknown>; because: string[] }
export function adviseLook(def: SurveyDefinition, brief: ResearchBrief): LookAdvice {
  const patch: Record<string, Record<string, unknown>> = {};
  const because: string[] = [];
  const set = (group: string, k: string, v: unknown) => { (patch[group] ??= {})[k] = v; };
  const text = `${def.research?.population ?? ""} ${def.research?.audience?.description ?? ""} ${brief.population ?? ""} ${brief.signals.map((x) => x.words).join(" ")} ${def.research?.objective ?? ""}`;
  const older = /\b(?:older|elderly|seniors?|retire\w*|pensioners?)\b|\b(?:55|60|65|70)\s*\+|\b(?:over|aged)\s+(?:55|60|65|70)\b/i.test(text);
  const young = /\b(?:students?|gen\s*z|teen\w*|young\s+(?:people|adults)|18\s*-\s*24)\b/i.test(text);
  const sensitive = /\b(?:health|illness|patients?|mental|grief|abuse|debt|harass\w*|diagnos\w*)\b/i.test(`${text} ${def.research?.objective ?? ""}`);
  if (brief.professional) { set("layout", "spacing", "compact"); set("layout", "cardStyle", "line"); set("appearance", "optionStyle", "minimal"); because.push(`${brief.population ?? "a professional audience"}: a restrained, compact layout reads as a serious instrument and gets through the questions faster`); }
  if (older) { set("typography", "baseSize", "18px"); set("layout", "spacing", "relaxed"); because.push("older respondents: 18px text and more space between options"); }
  if (brief.constraints.includes("mobileFirst") || young) { set("appearance", "optionStyle", "cards"); set("layout", "progressBar", "top"); because.push(`${young ? "a young, phone-first audience" : "mobile-first"}: large tappable option cards and the progress at the top`); }
  if (sensitive) { set("colors", "primary", "#3b6e8f"); set("colors", "background", "#f7f9fa"); because.push("a sensitive topic: calm, muted colours — nothing that reads as playful or alarming"); }
  if (!because.length) because.push("nothing about the respondents calls for a look other than the current one");
  return { patch, because };
}
