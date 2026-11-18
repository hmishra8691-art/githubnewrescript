import { placeholderMismatch } from "@rescript/engine";

/**
 * BACK-TRANSLATION REVIEW (audit 2026-11-17, P2-09).
 *
 * A translation is translated back into the source language, by a different pass of the provider (or a person),
 * and the back-translation is compared with the source. Wording will differ; MEANING must not. This module holds
 * the comparison, deterministic and provider-free, so the same three strings always give the same verdict:
 *
 *   number      a figure in the source is missing, or a different one appears ("18 or older" → "16 or older")
 *   negation    the source says "not / never / no …" and the back-translation does not, or the reverse
 *   polarity    a scale word turned to its opposite (agree ↔ disagree, satisfied ↔ dissatisfied, likely ↔ unlikely)
 *   intensity   "very / extremely / slightly / somewhat …" gained or lost
 *   placeholder a piped value, a ${…} or a tag the source carries is damaged in the TRANSLATION itself
 *   untranslated the translation is the source, unchanged (the glossary may say a term stays as it is)
 *   glossary    the source uses a glossary term and the translation does not use its agreed wording
 *   drift       too few of the source's content words come back (a clause dropped, a different question asked)
 *
 * Each string gets a status — ok, review (wording drift worth a look) or shift (meaning changed) — and the
 * language a QA score: the share of its strings that are ok, with review counting half. A person reconciles each
 * flagged string (keep, revise, or accept with a reason) and the record keeps who decided what.
 */

export type BackIssueKind = "number" | "negation" | "polarity" | "intensity" | "placeholder" | "untranslated" | "glossary" | "drift";
export interface BackIssue { kind: BackIssueKind; severity: "shift" | "review"; message: string }
export interface BackItem { key: string; source: string; translation: string; back: string; kind?: string }
export interface BackItemReview { key: string; status: "ok" | "review" | "shift"; issues: BackIssue[]; /** share of the source's content words found in the back-translation, 0–1 */ recall: number }
export interface BackReview { language: string; items: BackItemReview[]; score: number; counts: { ok: number; review: number; shift: number }; checkedAt: string }

const NUM = /-?\d+(?:[.,]\d+)?/g;
const NEG = /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot|can't|don't|doesn't|didn't|won't|wouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|shouldn't|couldn't)\b/i;
const INTENSITY = /\b(?:very|extremely|completely|totally|slightly|somewhat|fairly|quite|rather|highly|strongly|absolutely)\b/gi;
/** pairs whose two sides mean opposite things on a scale; the negative side is checked first */
const POLES: [RegExp, RegExp, string][] = [
  [/\bdisagree\w*/i, /\bagree\w*/i, "agree / disagree"],
  [/\b(?:dissatisf\w*|unsatisf\w*)/i, /\bsatisf\w*/i, "satisfied / dissatisfied"],
  [/\bunlikely\b/i, /\blikely\b/i, "likely / unlikely"],
  [/\bdislike\w*/i, /\blike[sd]?\b/i, "like / dislike"],
  [/\bunimportant\b/i, /\bimportant\b/i, "important / unimportant"],
  [/\bincorrect\b/i, /\bcorrect\b/i, "correct / incorrect"],
  [/\bworse\b|\bworst\b/i, /\bbetter\b|\bbest\b/i, "better / worse"],
  [/\bless\b|\bfewer\b|\blower\b/i, /\bmore\b|\bhigher\b/i, "more / less"],
  [/\bdecrease\w*/i, /\bincrease\w*/i, "increase / decrease"],
  [/\bunhappy\b/i, /\bhappy\b/i, "happy / unhappy"],
];
const STOP = new Set("a an the of to in on at for by with from and or but is are was were be been being do does did have has had this that these those it its your you yours we our they their he she his her i me my as if than then so such which who whom what when where why how all any each some please also about into over under there here can could would should will may might must shall".split(" "));

const words = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}|\$\{[^}]*\}|\[[^\]]*\]/g, " ").match(/[a-z][a-z'’-]*/g) ?? [];
/** a crude stem, so "purchased" meets "purchase" and "stores" meets "store" */
const stem = (w: string) => w.replace(/['’]s$/, "").replace(/(?:ing|ed|es|s|ly)$/, "").replace(/e$/, "");
const content = (s: string) => [...new Set(words(s).filter((w) => !STOP.has(w) && w.length > 2 && !NEG.test(w)).map(stem))];
const numbers = (s: string) => (s.replace(/<[^>]*>|\{[^}]*\}|\$\{[^}]*\}/g, " ").match(NUM) ?? []).map((n) => String(Number(n.replace(",", "."))));
const multiset = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
const poleOf = (s: string, neg: RegExp, pos: RegExp): "neg" | "pos" | null => (neg.test(s) ? "neg" : pos.test(s) ? "pos" : null);

export interface BackReviewOptions {
  language: string;
  /** the agreed wordings for this language: a source term → its target (equal to the source = stays untranslated) */
  glossary?: { source: string; target: string }[];
  /** below this share of content words recovered, the string is flagged for review (default 0.5) */
  minRecall?: number;
  now?: string;
}

export function reviewBackItem(it: BackItem, opts: BackReviewOptions): BackItemReview {
  const issues: BackIssue[] = [];
  const src = it.source.trim(), tr = it.translation.trim(), back = it.back.trim();

  /* in the translation itself: what the respondent will read */
  const ph = placeholderMismatch(src, tr);
  if (ph) issues.push({ kind: "placeholder", severity: "shift", message: `The translation damaged a placeholder or tag: ${ph}.` });
  const keepsAsIs = (opts.glossary ?? []).some((g) => g.source.trim().toLowerCase() === src.toLowerCase() && g.target.trim().toLowerCase() === src.toLowerCase());
  if (src && tr === src && /[a-z]{3}/i.test(src) && !keepsAsIs) issues.push({ kind: "untranslated", severity: "review", message: "The translation is the source text, unchanged." });
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim() || !new RegExp(`\\b${g.source.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(src)) continue;
    if (!tr.toLowerCase().includes(g.target.trim().toLowerCase())) issues.push({ kind: "glossary", severity: "review", message: `“${g.source}” should be “${g.target}” here (the glossary).` });
  }
  const trNums = multiset(numbers(tr)), srcNums = multiset(numbers(src));
  for (const [n, c] of srcNums) if ((trNums.get(n) ?? 0) < c) { issues.push({ kind: "number", severity: "shift", message: `The source's ${n} is not in the translation.` }); break; }

  /* source against back-translation: what the translation MEANS */
  const backNums = multiset(numbers(back));
  const lost = [...srcNums].filter(([n, c]) => (backNums.get(n) ?? 0) < c).map(([n]) => n);
  const gained = [...backNums].filter(([n, c]) => (srcNums.get(n) ?? 0) < c).map(([n]) => n);
  if ((lost.length || gained.length) && !issues.some((i) => i.kind === "number")) issues.push({ kind: "number", severity: "shift", message: lost.length && gained.length ? `The source says ${lost.join(", ")}; the back-translation says ${gained.join(", ")}.` : lost.length ? `The source's ${lost.join(", ")} did not come back.` : `The back-translation adds ${gained.join(", ")}, which the source does not have.` });
  const sNeg = NEG.test(src), bNeg = NEG.test(back);
  if (sNeg !== bNeg) issues.push({ kind: "negation", severity: "shift", message: sNeg ? "The source is negative (“not”, “never”, “no”…); the back-translation is not." : "The back-translation is negative; the source is not." });
  for (const [neg, pos, label] of POLES) {
    const a = poleOf(src, neg, pos), b = poleOf(back, neg, pos);
    if (a && b && a !== b) { issues.push({ kind: "polarity", severity: "shift", message: `The scale turned round (${label}): the source is “${a === "neg" ? "the negative side" : "the positive side"}”, the back-translation the other.` }); break; }
    if (a && !b && /agree|satisf|likely/.test(label)) { issues.push({ kind: "polarity", severity: "review", message: `The source's “${label.split(" / ")[a === "pos" ? 0 : 1]}” did not come back.` }); break; }
  }
  const sInt = new Set((src.match(INTENSITY) ?? []).map((w) => w.toLowerCase())), bInt = new Set((back.match(INTENSITY) ?? []).map((w) => w.toLowerCase()));
  if (sInt.size !== bInt.size && (sInt.size === 0 || bInt.size === 0)) issues.push({ kind: "intensity", severity: "review", message: sInt.size ? `“${[...sInt].join(", ")}” was lost.` : `“${[...bInt].join(", ")}” was added.` });

  const want = content(src);
  const have = new Set(content(back));
  const recall = want.length ? want.filter((w) => have.has(w)).length / want.length : 1;
  const min = opts.minRecall ?? 0.5;
  if (want.length >= 3 && recall < min && !issues.some((i) => i.severity === "shift")) issues.push({ kind: "drift", severity: "review", message: `Only ${Math.round(recall * 100)}% of the source's content words came back — the meaning may have drifted.` });

  const status = issues.some((i) => i.severity === "shift") ? "shift" : issues.length ? "review" : "ok";
  return { key: it.key, status, issues, recall: Math.round(recall * 100) / 100 };
}

export function reviewBackTranslation(items: readonly BackItem[], opts: BackReviewOptions): BackReview {
  const reviewed = items.map((it) => reviewBackItem(it, opts));
  const counts = { ok: 0, review: 0, shift: 0 };
  for (const r of reviewed) counts[r.status]++;
  const score = reviewed.length ? Math.round(((counts.ok + counts.review * 0.5) / reviewed.length) * 100) : 100;
  return { language: opts.language, items: reviewed, score, counts, checkedAt: opts.now ?? new Date().toISOString() };
}

/* ------------------------------------------------------------- reconciliation */

export type Reconcile = { key: string; action: "keep"; reason: string } | { key: string; action: "revise"; text: string; reason?: string };
export interface ReconcileRecord { key: string; status: BackItemReview["status"]; action: Reconcile["action"]; reason?: string; from?: string; to?: string; by: string; at: string }

/**
 * Apply a person's decisions to the flagged strings. Every flagged string needs one; a "keep" needs a reason (a
 * shift kept as it is must say why). Returns the revised translations and the record, or the strings still open.
 */
export function reconcileBackTranslation(review: BackReview, translations: Record<string, string>, decisions: readonly Reconcile[], by: string, now = new Date().toISOString(), sources?: Record<string, string>): { translations: Record<string, string>; record: ReconcileRecord[]; open: string[]; refused: string[] } {
  const out = { ...translations };
  const record: ReconcileRecord[] = [];
  const refused: string[] = [];
  const decided = new Map(decisions.map((d) => [d.key, d]));
  const open: string[] = [];
  for (const r of review.items) {
    if (r.status === "ok") continue;
    const d = decided.get(r.key);
    if (!d) { open.push(r.key); continue; }
    if (d.action === "keep" && !d.reason?.trim()) { refused.push(`${r.key}: keeping a flagged translation needs a reason`); open.push(r.key); continue; }
    if (d.action === "revise" && !d.text.trim()) { refused.push(`${r.key}: a revision needs the new text`); open.push(r.key); continue; }
    if (d.action === "revise") {
      const src = sources?.[r.key];
      const ph = src != null ? placeholderMismatch(src, d.text) : null;
      if (ph) { refused.push(`${r.key}: the revision damages a placeholder or tag (${ph})`); open.push(r.key); continue; }
      record.push({ key: r.key, status: r.status, action: "revise", ...(d.reason ? { reason: d.reason } : {}), from: translations[r.key], to: d.text, by, at: now });
      out[r.key] = d.text;
    } else record.push({ key: r.key, status: r.status, action: "keep", reason: d.reason, by, at: now });
  }
  return { translations: out, record, open, refused };
}
