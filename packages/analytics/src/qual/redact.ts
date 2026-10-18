/**
 * PII REDACTION FOR QUALITATIVE TEXT (2026-10-18).
 *
 * Transcripts and open answers are people's own words, and the words carry
 * identifiers: an email address read out, a phone number, a participant's or
 * a colleague's name. Before ANY text goes to a model — and whenever it is
 * shown to a member without the contact-details permission
 * (`responses.read_pii`) — it passes through here: e-mail addresses, phone
 * numbers and every name on the study's names list are replaced by a label
 * ("[email]", "[phone]", "[name]").
 *
 * The replacements are recorded, so a span found in the redacted text (a
 * quote a model returned) maps back to the exact span of the ORIGINAL text:
 * evidence links always point at the source as recorded, and a quote is
 * always an exact substring of it. Pure; deterministic.
 */

export type RedactionKind = "email" | "phone" | "name";
export interface Replacement { kind: RedactionKind; /** in the original */ start: number; end: number; /** in the redacted text */ rStart: number; rEnd: number }
export interface Redacted { text: string; replacements: Replacement[] }
export interface RedactOptions { names?: readonly string[]; emails?: boolean; phones?: boolean }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/* a phone number: 7–15 digits with the usual separators, optionally +country and (area); not a year, a time or a price */
const PHONE = /(?<![\w£$€])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?![\w%])/g;
const digits = (s: string) => s.replace(/\D/g, "").length;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Redact a text; the replacements say what was replaced where (in both texts). */
export function redactText(text: string, opts: RedactOptions = {}): Redacted {
  const hits: { kind: RedactionKind; start: number; end: number }[] = [];
  if (opts.emails !== false) for (const m of text.matchAll(EMAIL)) hits.push({ kind: "email", start: m.index!, end: m.index! + m[0].length });
  if (opts.phones !== false) for (const m of text.matchAll(PHONE)) { const d = digits(m[0]); if (d >= 7 && d <= 15 && !/^\d{1,2}:\d{2}/.test(m[0])) hits.push({ kind: "phone", start: m.index!, end: m.index! + m[0].length }); }
  const names = [...new Set((opts.names ?? []).map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  if (names.length) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join("|")})(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) hits.push({ kind: "name", start: m.index!, end: m.index! + m[0].replace(/['’]s$/i, "").length });
  }
  /* overlaps: the earliest, then the longest, wins */
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof hits = [];
  for (const h of hits) if (!kept.length || h.start >= kept[kept.length - 1].end) kept.push(h);
  let out = "", at = 0;
  const replacements: Replacement[] = [];
  for (const h of kept) {
    out += text.slice(at, h.start);
    const label = `[${h.kind}]`;
    replacements.push({ kind: h.kind, start: h.start, end: h.end, rStart: out.length, rEnd: out.length + label.length });
    out += label;
    at = h.end;
  }
  out += text.slice(at);
  return { text: out, replacements };
}

/** a position in the redacted text → the position in the original (a position inside a label maps to the replaced span's edge) */
export function originalOffset(r: Redacted, pos: number, edge: "start" | "end"): number {
  let shift = 0;
  for (const x of r.replacements) {
    if (pos <= x.rStart) break;
    if (pos < x.rEnd) return edge === "start" ? x.start : x.end;
    shift = x.end - x.rEnd;
  }
  return pos + shift;
}

/** a span of the redacted text → the span of the original it stands for */
export function originalSpan(r: Redacted, start: number, end: number): { start: number; end: number } {
  return { start: originalOffset(r, start, "start"), end: originalOffset(r, end, "end") };
}

/** what was redacted, counted — for the audit trail and the "sent to the model" note */
export function redactionSummary(rs: readonly Redacted[]): Record<RedactionKind, number> {
  const out: Record<RedactionKind, number> = { email: 0, phone: 0, name: 0 };
  for (const r of rs) for (const x of r.replacements) out[x.kind]++;
  return out;
}
