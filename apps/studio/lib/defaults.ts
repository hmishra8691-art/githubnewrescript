import { SurveyDefinition, type Branding } from "@rescript/schema";

export function newSurveyDefinition(id: string, code: string, title: string): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id, code, title, version: "1.0", status: "draft" },
    flow: [
      { type: "page", id: "page_1", title: "Welcome", questionIds: [] },
      { type: "end", id: "end_complete", status: "complete" },
    ],
    /* a new survey starts with selection cards (no visible radio buttons / checkboxes); existing surveys keep their look */
    branding: { appearance: { optionStyle: "tiles" } },
  });
}

/** a plain preset clears a motif theme's identity (selection style, decorations, motion) when applied over it */
const PLAIN: Partial<NonNullable<Branding["appearance"]>> = { optionStyle: undefined, motif: undefined, illustrations: undefined, motion: undefined };

/** Theme presets (requirement §19–20) — same engine, different worlds. */
export const THEME_PRESETS: { name: string; description: string; branding: Partial<Branding> }[] = [
  {
    name: "Corporate",
    description: "Professional blue, card layout — B2B / corporate research",
    branding: {
      colors: {
        primary: "#1d4ed8", secondary: "#0f172a", background: "#f1f5f9", surface: "#ffffff",
        text: "#0f172a", subtleText: "#64748b", border: "#e2e8f0", error: "#dc2626",
      },
      typography: { fontFamily: "Inter, system-ui, sans-serif", baseSize: "16px", headingWeight: 650 },
      layout: { maxWidth: "760px", cardStyle: "card", radius: "10px", spacing: "regular", progressBar: "top", progressStyle: "bar", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "solid", nextLabel: "Next", backLabel: "Back", submitLabel: "Submit", showBack: true },
      appearance: PLAIN,
    },
  },
  {
    name: "Luxury",
    description: "Dark, serif, gold accents — premium brand studies",
    branding: {
      colors: {
        primary: "#b4924c", secondary: "#c9b380", background: "#111113", surface: "#1b1b1f",
        text: "#f4f1ea", subtleText: "#9a958a", border: "#33323a", error: "#e6817b",
      },
      typography: { fontFamily: "Georgia, 'Times New Roman', serif", baseSize: "17px", headingWeight: 600 },
      layout: { maxWidth: "680px", cardStyle: "line", radius: "2px", spacing: "relaxed", progressBar: "bottom", progressStyle: "percent", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "outline", nextLabel: "Continue", backLabel: "Return", submitLabel: "Complete", showBack: true },
      appearance: PLAIN,
    },
  },
  {
    name: "Healthcare",
    description: "Calm teal, large type, high accessibility",
    branding: {
      colors: {
        primary: "#0d9488", secondary: "#134e4a", background: "#f0fdfa", surface: "#ffffff",
        text: "#134e4a", subtleText: "#5f8f8a", border: "#ccece8", error: "#b91c1c",
      },
      typography: { fontFamily: "'Atkinson Hyperlegible', Verdana, sans-serif", baseSize: "18px", headingWeight: 700 },
      layout: { maxWidth: "720px", cardStyle: "card", radius: "14px", spacing: "relaxed", progressBar: "top", progressStyle: "steps", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "solid", nextLabel: "Continue →", backLabel: "← Go back", submitLabel: "Finish", showBack: true },
      appearance: PLAIN,
    },
  },
  {
    name: "Gen-Z",
    description: "Bold gradients, pill buttons, playful",
    branding: {
      colors: {
        primary: "#8b5cf6", secondary: "#ec4899", background: "#fdf4ff", surface: "#ffffff",
        text: "#1e1b4b", subtleText: "#7c7a99", border: "#ead8fb", error: "#e11d48",
      },
      typography: { fontFamily: "'Space Grotesk', system-ui, sans-serif", baseSize: "16px", headingWeight: 700 },
      layout: { maxWidth: "640px", cardStyle: "card", radius: "20px", spacing: "regular", progressBar: "top", progressStyle: "percent", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "pill", nextLabel: "Next ✨", backLabel: "Back", submitLabel: "Done 🎉", showBack: true },
      appearance: PLAIN,
    },
  },
  /* ---------------- 2026-11-07: themes with their own identity, not only colours ---------------- */
  {
    name: "Premium Peach",
    description: "Our signature look — warm peach, soft cards, elegant type, selection cards",
    branding: {
      colors: {
        primary: "#e5734a", secondary: "#f4a582", background: "#fff6f0", surface: "#ffffff",
        text: "#3b2319", subtleText: "#8a6a5c", border: "#f3dccf", error: "#c2410c",
      },
      typography: { fontFamily: "'DM Sans', 'Inter', system-ui, sans-serif", baseSize: "16px", headingWeight: 650, headingFont: "'Fraunces', Georgia, serif" },
      layout: { maxWidth: "720px", cardStyle: "card", radius: "16px", spacing: "relaxed", progressBar: "top", progressStyle: "bar", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "pill", nextLabel: "Continue", backLabel: "Back", submitLabel: "Submit", showBack: true },
      appearance: { optionStyle: "tiles", motif: "peach", illustrations: true, motion: "subtle", shadow: "soft", selectedTint: 10, inputStyle: "filled" },
      background: { gradient: "linear-gradient(160deg, #fff8f3 0%, #ffe9dc 100%)", size: "cover", position: "center", repeat: false, attachment: "fixed" },
    },
  },
  {
    name: "Kids & Cartoon",
    description: "Bright, playful and friendly — big answer cards, cartoon characters, bouncy feedback",
    branding: {
      colors: {
        primary: "#7c3aed", secondary: "#f59e0b", background: "#fef9e7", surface: "#ffffff",
        text: "#2e1065", subtleText: "#6b5b95", border: "#e9d5ff", error: "#dc2626",
      },
      typography: { fontFamily: "'Baloo 2', 'Nunito', 'Trebuchet MS', system-ui, sans-serif", baseSize: "18px", headingWeight: 800 },
      layout: { maxWidth: "680px", cardStyle: "card", radius: "22px", spacing: "relaxed", progressBar: "top", progressStyle: "steps", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "center" },
      buttons: { style: "pill", nextLabel: "Next! →", backLabel: "← Back", submitLabel: "All done! 🎉", showBack: true },
      appearance: { optionStyle: "tiles", motif: "kids", illustrations: true, motion: "lively", selectedTint: 14, optionGap: "12px" },
      background: { gradient: "linear-gradient(180deg, #e0f2fe 0%, #fef9e7 55%, #fde68a 100%)", size: "cover", position: "center", repeat: false, attachment: "fixed" },
    },
  },
  {
    name: "AI & Robotics",
    description: "Futuristic and glowing — dark glass cards, circuit lines, a friendly robot",
    branding: {
      colors: {
        primary: "#22d3ee", secondary: "#a78bfa", background: "#060b18", surface: "#0d1528",
        text: "#e6f1ff", subtleText: "#8aa0c2", border: "#1f2c4a", error: "#fb7185",
        buttonText: "#04111d",
      },
      typography: { fontFamily: "'Space Grotesk', 'Inter', system-ui, sans-serif", baseSize: "16px", headingWeight: 600 },
      layout: { maxWidth: "720px", cardStyle: "card", radius: "14px", spacing: "regular", progressBar: "top", progressStyle: "bar", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "solid", nextLabel: "Next", backLabel: "Back", submitLabel: "Submit", showBack: true },
      appearance: { optionStyle: "tiles", motif: "robotics", illustrations: true, motion: "subtle", selectedTint: 16, inputStyle: "filled" },
      background: { gradient: "radial-gradient(1200px 600px at 80% -10%, rgba(34,211,238,.18), transparent 60%), radial-gradient(900px 500px at -10% 110%, rgba(167,139,250,.16), transparent 60%), linear-gradient(180deg, #060b18, #0a1226)", size: "cover", position: "center", repeat: false, attachment: "fixed" },
    },
  },
  {
    name: "Creative Studio",
    description: "Next-generation SaaS — gradient accents, crisp cards, smooth motion; for consumer and marketing research",
    branding: {
      colors: {
        primary: "#6366f1", secondary: "#ec4899", background: "#f7f7fb", surface: "#ffffff",
        text: "#111827", subtleText: "#6b7280", border: "#e6e6f0", error: "#e11d48",
      },
      typography: { fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif", baseSize: "16px", headingWeight: 700 },
      layout: { maxWidth: "740px", cardStyle: "card", radius: "14px", spacing: "regular", progressBar: "top", progressStyle: "percent", showBlockTitles: true, presentation: "pages", voice: { readAloud: false, dictation: false }, widthMode: "full", contentAlign: "left" },
      buttons: { style: "solid", nextLabel: "Next", backLabel: "Back", submitLabel: "Submit", showBack: true },
      appearance: { optionStyle: "tiles", motif: "creative", illustrations: true, motion: "subtle", selectedTint: 10, shadow: "soft" },
      background: { gradient: "radial-gradient(800px 400px at 100% 0%, rgba(99,102,241,.10), transparent 60%), radial-gradient(700px 400px at 0% 100%, rgba(236,72,153,.08), transparent 60%)", size: "cover", position: "center", repeat: false, attachment: "fixed" },
    },
  },
];
