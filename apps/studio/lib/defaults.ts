import { SurveyDefinition, type Branding } from "@rescript/schema";

export function newSurveyDefinition(id: string, code: string, title: string): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id, code, title, version: "1.0", status: "draft" },
    flow: [
      { type: "page", id: "page_1", title: "Welcome", questionIds: [] },
      { type: "end", id: "end_complete", status: "complete" },
    ],
  });
}

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
      layout: { maxWidth: "760px", cardStyle: "card", radius: "10px", spacing: "regular", progressBar: "top", progressStyle: "bar" },
      buttons: { style: "solid", nextLabel: "Next", backLabel: "Back", submitLabel: "Submit", showBack: true },
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
      layout: { maxWidth: "680px", cardStyle: "line", radius: "2px", spacing: "relaxed", progressBar: "bottom", progressStyle: "percent" },
      buttons: { style: "outline", nextLabel: "Continue", backLabel: "Return", submitLabel: "Complete", showBack: true },
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
      layout: { maxWidth: "720px", cardStyle: "card", radius: "14px", spacing: "relaxed", progressBar: "top", progressStyle: "steps" },
      buttons: { style: "solid", nextLabel: "Continue →", backLabel: "← Go back", submitLabel: "Finish", showBack: true },
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
      layout: { maxWidth: "640px", cardStyle: "card", radius: "20px", spacing: "regular", progressBar: "top", progressStyle: "percent" },
      buttons: { style: "pill", nextLabel: "Next ✨", backLabel: "Back", submitLabel: "Done 🎉", showBack: true },
    },
  },
];
