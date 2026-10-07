/**
 * ONE PLACE FOR WHAT A QUESTION SAYS (October 2026 review).
 *
 * A question's visible content is its text, written in the Text Editor
 * (visual or HTML). It used to have a rival: `customHtml`, edited as "HTML
 * Content" on a Text / HTML block and as "Custom HTML (above the input)" in
 * the Custom code panel. On a Text / HTML block it REPLACED the text — the
 * text editor showed one thing and the respondent saw another — and on every
 * other question it drew a second, separately authored block of HTML under
 * the text. Three editors, two fields, one job.
 *
 * The text is canonical. `customHtml` remains only as a Custom Component's
 * template, which is a different thing — markup a component script drives —
 * and nothing else reads it.
 *
 * Surveys saved before this keep rendering as they did. Every definition is
 * parsed through `Question`, and this runs first (a `z.preprocess`), so the
 * Studio, Preview, Test Survey, the live runtime, imports, clones and version
 * restores all see the same, migrated question:
 *
 *   Text / HTML block  the HTML becomes the text — it is what the respondent
 *                      saw. A text that said something the HTML did not (a
 *                      builder-only label) is kept in Programmer notes,
 *                      rather than lost.
 *   any other type     the HTML is appended to the instruction, which is the
 *                      rich content drawn between the text and the answer —
 *                      where "above the input" put it.
 *
 * Idempotent, pure, and it never mutates its input.
 */
export function normalizeQuestionContent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const q = raw as Record<string, unknown>;
  if (!("customHtml" in q) || q.type === "custom_component") return raw;
  const html = typeof q.customHtml === "string" ? q.customHtml : "";
  const out: Record<string, unknown> = { ...q };
  delete out.customHtml;
  if (!html.trim()) return out;

  if (q.type === "html") {
    const text = typeof q.text === "string" ? q.text : "";
    const said = plain(text);
    if (said && !plain(html).includes(said)) {
      const note = `Label before the HTML content was merged into the question text: ${text}`;
      out.notes = typeof q.notes === "string" && q.notes.trim() ? `${q.notes}\n\n${note}` : note;
    }
    out.text = html;
    return out;
  }

  const instruction = typeof q.instruction === "string" ? q.instruction : "";
  out.instruction = instruction.trim() ? `${instruction}${html}` : html;
  return out;
}

/** The words, for comparing a label with the content it labelled. */
function plain(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
