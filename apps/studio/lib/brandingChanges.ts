/**
 * WHAT JUST CHANGED, IN WORDS (Branding redesign, 2026-11-07).
 *
 * The Branding workspace shows every edit in the live preview AND says what it was: "Primary colour #2563eb →
 * #e11d48 — buttons, selected answers and the progress bar". This file is the pure half: diff two branding
 * snapshots (plus the survey's navigation setting), name each changed setting the way the panel labels it, and say
 * which part of the respondent's page it affects — the `region` the preview outlines.
 */

export type PreviewRegion = "page" | "cards" | "text" | "hints" | "options" | "inputs" | "progress" | "buttons" | "error" | "logo" | "nav";

export interface BrandingChange {
  path: string;
  label: string;
  before: string;
  after: string;
  impact: string;
  region: PreviewRegion;
}

interface Meta { label: string; impact: string; region: PreviewRegion }

/* exact paths first, then the longest matching prefix */
const META: Record<string, Meta> = {
  "colors.primary": { label: "Primary colour", impact: "buttons, selected answers and the progress bar", region: "buttons" },
  "colors.secondary": { label: "Secondary colour", impact: "the Back button and secondary accents", region: "buttons" },
  "colors.background": { label: "Page background", impact: "the page behind the questions", region: "page" },
  "colors.surface": { label: "Card colour", impact: "the cards each question sits on", region: "cards" },
  "colors.text": { label: "Text colour", impact: "question text and answers", region: "text" },
  "colors.subtleText": { label: "Hint text colour", impact: "instructions and helper text", region: "hints" },
  "colors.border": { label: "Border colour", impact: "card, option and input borders", region: "cards" },
  "colors.error": { label: "Error colour", impact: "validation messages", region: "error" },
  "colors.accent": { label: "Accent colour", impact: "highlights and links (otherwise the primary colour)", region: "options" },
  "colors.heading": { label: "Heading colour", impact: "question text", region: "text" },
  "colors.link": { label: "Link colour", impact: "links in question text", region: "text" },
  "colors.inputBackground": { label: "Input background", impact: "text boxes and dropdowns", region: "inputs" },
  "colors.buttonBackground": { label: "Button colour", impact: "the Next / Submit button", region: "buttons" },
  "colors.buttonText": { label: "Button text colour", impact: "the label on the Next / Submit button", region: "buttons" },
  "colors.progress": { label: "Progress colour", impact: "the progress indicator", region: "progress" },
  "typography.fontFamily": { label: "Font", impact: "all text on the page", region: "text" },
  "typography.baseSize": { label: "Text size", impact: "all text on the page", region: "text" },
  "typography.headingFont": { label: "Question font", impact: "question text", region: "text" },
  "typography.headingWeight": { label: "Question weight", impact: "how bold question text is", region: "text" },
  "typography.questionSize": { label: "Question size", impact: "question text", region: "text" },
  "typography.lineHeight": { label: "Line height", impact: "spacing between lines of text", region: "text" },
  "typography.letterSpacing": { label: "Letter spacing", impact: "spacing between letters", region: "text" },
  "layout.widthMode": { label: "Desktop width", impact: "how wide the survey is on a computer", region: "page" },
  "layout.maxWidth": { label: "Maximum width", impact: "the width of the survey column", region: "page" },
  "layout.contentAlign": { label: "Text alignment", impact: "how questions line up in the column", region: "text" },
  "layout.cardStyle": { label: "Card style", impact: "how each question is framed", region: "cards" },
  "layout.radius": { label: "Corner rounding", impact: "cards, options, inputs and buttons", region: "cards" },
  "layout.spacing": { label: "Spacing", impact: "the room between questions", region: "page" },
  "layout.progressBar": { label: "Progress position", impact: "where the progress indicator sits", region: "progress" },
  "layout.progressStyle": { label: "Progress style", impact: "how progress is shown (bar, percent, steps)", region: "progress" },
  "layout.showBlockTitles": { label: "Block names", impact: "whether block names appear as page headings", region: "text" },
  "layout.questionNumbers": { label: "Question numbers", impact: "the number before each question", region: "text" },
  "layout.optionNumbering": { label: "Option labels", impact: "the letter or number before each answer", region: "options" },
  "layout.autoAdvance": { label: "Auto-next", impact: "single-answer pages move on as soon as they are answered", region: "options" },
  "logoUrl": { label: "Logo", impact: "the header", region: "logo" },
  "logoPosition": { label: "Logo position", impact: "where the logo sits in the header", region: "logo" },
  "logoDisplay": { label: "Logo size", impact: "how big the logo is", region: "logo" },
  "buttons.style": { label: "Button style", impact: "the Next and Back buttons", region: "buttons" },
  "buttons.nextLabel": { label: "Next button text", impact: "the Next button", region: "buttons" },
  "buttons.backLabel": { label: "Back button text", impact: "the Back button", region: "buttons" },
  "buttons.submitLabel": { label: "Submit button text", impact: "the button on the last page", region: "buttons" },
  "buttons.showBack": { label: "Back button", impact: "whether respondents can go back", region: "buttons" },
  "navigation.sectionNav": { label: "Section navigation", impact: "how respondents move between sections", region: "nav" },
  "navigation.position": { label: "Navigator position", impact: "where the section navigator sits", region: "nav" },
  "appearance.optionStyle": { label: "Answer style", impact: "how answer choices look", region: "options" },
  "appearance.controlStyle": { label: "Radio buttons & checkboxes", impact: "the circles and boxes next to answers", region: "options" },
  "appearance.inputStyle": { label: "Input style", impact: "text boxes and dropdowns", region: "inputs" },
  "appearance.shadow": { label: "Card shadow", impact: "the depth of each card", region: "cards" },
  "appearance.cardPadding": { label: "Card padding", impact: "the room inside each card", region: "cards" },
  "appearance.borderWidth": { label: "Border width", impact: "card, option and input borders", region: "cards" },
  "appearance.optionGap": { label: "Gap between answers", impact: "the space between answer choices", region: "options" },
  "appearance.selectedTint": { label: "Selected tint", impact: "how strongly a chosen answer is highlighted", region: "options" },
  "appearance.focusColor": { label: "Focus colour", impact: "the keyboard focus ring", region: "options" },
  "appearance.buttonRadius": { label: "Button rounding", impact: "the Next and Back buttons", region: "buttons" },
  "appearance.progressHeight": { label: "Progress thickness", impact: "the progress bar", region: "progress" },
  "appearance.logoMaxHeight": { label: "Logo height", impact: "the logo", region: "logo" },
  "background": { label: "Background image", impact: "the page behind the questions", region: "page" },
  "responsive.tablet": { label: "Tablet sizes", impact: "the survey on tablets", region: "page" },
  "responsive.mobile": { label: "Phone sizes", impact: "the survey on phones", region: "page" },
  "aiConversation": { label: "AI interviewer", impact: "how the survey is conducted (text, voice, conversational)", region: "page" },
  "headerHtml": { label: "Header HTML", impact: "the custom header", region: "logo" },
  "footerHtml": { label: "Footer HTML", impact: "the custom footer", region: "page" },
  "customCss": { label: "Custom CSS", impact: "anything the stylesheet targets", region: "page" },
  "uxItems": { label: "Styles, animations & scripts", impact: "the elements those rules target", region: "page" },
  "themeId": { label: "Workspace theme", impact: "where this look came from", region: "page" },
};

const humanize = (path: string) => path.split(".").pop()!.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export function metaFor(path: string): Meta {
  if (META[path]) return META[path];
  const parts = path.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const m = META[parts.slice(0, i).join(".")];
    if (m) return { ...m, label: `${m.label} · ${humanize(path)}` };
  }
  return { label: humanize(path), impact: "the respondent's page", region: "page" };
}

/** settings stored as whole objects are compared (and described) as one setting */
const ATOMIC = new Set(["logoDisplay", "voice", "uxItems", "aiConversation"]);

function flatten(v: unknown, prefix: string, out: Map<string, unknown>) {
  if (v && typeof v === "object" && !Array.isArray(v) && !ATOMIC.has(prefix.split(".").pop() ?? "")) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    if (!Object.keys(v as object).length && prefix) out.set(prefix, undefined);
  } else if (prefix) out.set(prefix, v);
}

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "default";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 38)}…` : v;
  const j = JSON.stringify(v);
  return j.length > 40 ? `${j.slice(0, 38)}…` : j;
};

/** every changed setting between two snapshots, described */
export function describeBrandingChanges(before: unknown, after: unknown): BrandingChange[] {
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flatten(before, "", a); flatten(after, "", b);
  const out: BrandingChange[] = [];
  const seen = new Set<string>();
  for (const path of [...b.keys(), ...a.keys()]) {
    if (seen.has(path)) continue;
    seen.add(path);
    const x = a.get(path), y = b.get(path);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if ((x === undefined || x === "") && (y === undefined || y === "")) continue;
    const m = metaFor(path);
    out.push({ path, label: m.label, before: show(x), after: show(y), impact: m.impact, region: m.region });
  }
  /* settings under one heading (a background, a device's sizes) collapse into the heading */
  const grouped = new Map<string, BrandingChange>();
  for (const c of out) {
    const key = c.label.split(" · ")[0]!;
    const g = grouped.get(key);
    if (!g) grouped.set(key, { ...c, label: key });
    else grouped.set(key, { ...g, before: "…", after: "changed" });
  }
  return [...grouped.values()];
}
