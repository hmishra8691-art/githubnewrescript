/**
 * TWO QUOTA SYSTEMS, ONE WARNING (platform audit 2026-11-05).
 *
 * A survey has quotas of its own: cells over answers to questionnaire items, counted mid-interview, closing a
 * branch when full (migrations 0006, 0010, 0057; the Quotas panel). A recruitment project has quota CELLS: the
 * composition of the sample being bought, counted at the recruitment link before the survey (0088, 0089; the
 * Smart Recruitment panel). Both are correct and they count different things — and a researcher who writes
 * "50% female" in both places gets two independent counters that will disagree, with nothing telling them.
 *
 * This does not reconcile the two (they cannot be reconciled: one is a cap on answers, the other a target for
 * arrivals). It names the pairs that look like the same intention — a recruitment cell whose label or
 * criterion value matches a survey quota cell's label — and says whether their numbers agree. The researcher
 * decides which one means what.
 */

export interface SurveyQuotaLike {
  name: string;
  cells: { id?: string; label: string; limit: number; limitType?: "count" | "percent"; target?: number }[];
  targetTotal?: number;
}

export interface RecruitmentCellLike {
  id?: string;
  label: string;
  criteria?: Record<string, unknown>;
  /** in completes */
  targetCompletes: number;
}

export interface QuotaCrossNote {
  kind: "agree" | "disagree";
  surveyQuota: string;
  surveyCell: string;
  recruitmentCell: string;
  /** the survey cell's cap in completes — null when the cap is a percentage with no base to resolve it against */
  surveyCompletes: number | null;
  recruitmentCompletes: number;
  statement: string;
}

export interface QuotaCrossCheck {
  notes: QuotaCrossNote[];
  /** pairs that disagree */
  conflicts: number;
  statement: string | null;
}

/** "Female", " female ", "FEMALE", "18–24", "18-24", "18 to 24" compare equal */
export function normaliseQuotaLabel(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+to\s+/g, "-")
    .replace(/[^a-z0-9+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function surveyCap(q: SurveyQuotaLike, c: SurveyQuotaLike["cells"][number], fallbackTotal: number | null): number | null {
  const type = c.limitType ?? "count";
  if (type === "count") return Number.isFinite(c.limit) ? Math.round(c.limit) : null;
  const base = q.targetTotal ?? fallbackTotal;
  if (base === null || !Number.isFinite(base) || base <= 0) return null;
  return Math.round((c.limit / 100) * base);
}

export function crossCheckQuotas(
  surveyQuotas: readonly SurveyQuotaLike[],
  recruitmentCells: readonly RecruitmentCellLike[],
  requiredCompletes: number | null,
): QuotaCrossCheck {
  const notes: QuotaCrossNote[] = [];
  if (!surveyQuotas.length || !recruitmentCells.length) return { notes, conflicts: 0, statement: null };

  const recruitment = recruitmentCells.map((r) => ({
    cell: r,
    keys: new Set([normaliseQuotaLabel(r.label), ...Object.values(r.criteria ?? {}).map(normaliseQuotaLabel)].filter(Boolean)),
  }));

  for (const q of surveyQuotas) {
    for (const c of q.cells) {
      const key = normaliseQuotaLabel(c.label);
      if (!key) continue;
      for (const r of recruitment) {
        if (!r.keys.has(key)) continue;
        const cap = surveyCap(q, c, requiredCompletes);
        const buy = Math.round(r.cell.targetCompletes);
        const agree = cap !== null && cap === buy;
        notes.push({
          kind: agree ? "agree" : "disagree",
          surveyQuota: q.name, surveyCell: c.label, recruitmentCell: r.cell.label,
          surveyCompletes: cap, recruitmentCompletes: buy,
          statement: cap === null
            ? `“${c.label}” is set in both places: the survey quota “${q.name}” caps it as a percentage with no base to resolve, and recruitment buys ${buy.toLocaleString()}.`
            : agree
              ? `“${c.label}” is set in both places at ${buy.toLocaleString()} — the survey quota “${q.name}” caps answers there, and recruitment buys that many arrivals. The two are counted separately and will drift as screen-outs and partials accrue.`
              : `“${c.label}” is set twice with different numbers: the survey quota “${q.name}” caps it at ${cap.toLocaleString()} completes, recruitment buys ${buy.toLocaleString()}. ${buy > cap ? "Arrivals beyond the survey cap will be turned away mid-interview after the recruitment cell admitted them." : "The survey cap will never be reached from this recruitment alone."}`,
        });
      }
    }
  }

  const conflicts = notes.filter((n) => n.kind === "disagree").length;
  const statement = !notes.length
    ? null
    : conflicts
      ? `${conflicts} quota ${conflicts === 1 ? "target is" : "targets are"} set in both the Quotas panel and the recruitment cells with different numbers. The two systems count different things — answers mid-interview against arrivals at the door — and nothing reconciles them.`
      : `${notes.length} quota ${notes.length === 1 ? "target is" : "targets are"} set in both the Quotas panel and the recruitment cells. They agree today, but are counted separately and will drift.`;
  return { notes, conflicts, statement };
}
