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

/**
 * THE DEAD "randomizeRows" SETTING (07-10-2026 review, Suraj #2).
 *
 * "Matrix with Randomized Rows" used to seed `settings.randomizeRows: true`,
 * which no part of the engine ever read: the preset was chosen, the rows were
 * promised to shuffle per respondent, and every respondent saw them in the
 * programmed order. Row order is the question's `randomization` (scope rows)
 * — the model the Randomization panel edits and `effectiveQuestion` applies —
 * so a question that carries the dead flag is given what it asked for:
 *
 *   no randomization (or switched off)  → rows shuffled, seeded per respondent
 *   randomization already on, other axis → rows added as a second axis
 *   rows already randomized              → unchanged
 *
 * `randomizeRows: false` (never written by anything) is simply dropped.
 * Idempotent and pure, like `normalizeQuestionContent`.
 */
export function normalizeLegacyRowRandomization(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const q = raw as Record<string, unknown>;
  const settings = q.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== "object" || !("randomizeRows" in settings)) return raw;
  const { randomizeRows, ...rest } = settings;
  const out: Record<string, unknown> = { ...q, settings: rest };
  if (randomizeRows !== true) return out;
  const r = (q.randomization && typeof q.randomization === "object" ? q.randomization : null) as Record<string, unknown> | null;
  if (!r || r.enabled !== true) {
    const next: Record<string, unknown> = { ...(r ?? {}), enabled: true, scope: "rows" };
    if (!next.method || next.method === "none") next.method = "shuffle";
    delete next.scopes;  // it was off: nothing else was being shuffled
    out.randomization = next;
    return out;
  }
  const axes = Array.isArray(r.scopes) && r.scopes.length ? (r.scopes as string[]) : [String(r.scope ?? "options")];
  if (!axes.includes("rows")) out.randomization = { ...r, scopes: [...axes, "rows"] };
  return out;
}

/** Every parse-time migration a question goes through, in order. */
export function normalizeQuestion(raw: unknown): unknown {
  return normalizeLegacyRowRandomization(normalizeQuestionContent(raw));
}

/*
 * THE SAME VALUE THE SCHEMA STORES, for comparing (2026-11-17, Error.xlsx item 2).
 *
 * The draft save asks whether anything the editor sent failed to survive parsing (`droppedFieldPaths`). Parsing is
 * not only stripping: every question goes through `normalizeQuestion` (customHtml folded into text / instruction,
 * legacy row randomisation moved) and every flag list through `normalizeOptionFlags` (the retired "none of the
 * above" / "don't know" / "refused" flags become "exclusive"). Compared with the raw input, those migrations looked
 * like data loss: "Save failed — Saved, but the server did not recognise questions[3].options[7].flags[0]" on a
 * save that had stored everything, repeated on every later save.
 *
 * This applies exactly those migrations to the input and nothing else (no stripping, no defaults), so what is left
 * different after it really was dropped. A new `transform` / `preprocess` in the schema must be added here too —
 * `schemaTransforms.test.ts` fails until it is.
 */
export function normalizeAsParsed<T>(value: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) {
      if (key === "flags" && v.every((x) => typeof x === "string")) return normalizeOptionFlagsLocal(v as string[]);
      const items = key === "questions" ? v.map((q) => normalizeQuestion(q)) : v;
      return items.map((x) => walk(x, null));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}

/* the retirement rule of question.ts `normalizeOptionFlags`, repeated here to keep this module free of the question
   schema (question.ts imports this file); schemaTransforms.test.ts checks the two agree */
const RETIRED = new Set(["none_of_above", "dont_know", "refused"]);
function normalizeOptionFlagsLocal(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of flags) { const m = RETIRED.has(f) ? "exclusive" : f; if (!out.includes(m)) out.push(m); }
  return out;
}
