import type { SurveyDefinition } from "@rescript/schema";
import { effectiveLimit, type QuotaCounts } from "./quotas.js";

/**
 * IS THERE ENOUGH SAMPLE FOR THE QUOTAS? (Intelligent Mode IM4, 2026-11-06)
 *
 * A quota is a promise about who will answer; the sample decides whether it can be kept. Given what the person (or
 * a vendor's stated feasibility) says is reachable — `available` people of the target audience, `incidence` % of
 * them who qualify, optionally `responseRate` % who will take part, and the population share of the groups the
 * cells read ("women are 35 %") — each cell's need (limit − completes so far) is set against its expected supply:
 *
 *     supply = available × incidence × responseRate × share(cell)
 *
 * A crossed cell's share is the product of its parts' shares (independence — said, because it is an assumption).
 * A cell whose share nobody gave is reported as "share unknown", never assumed equal: an equal split would make
 * every quota look feasible. Nothing here estimates a number the person did not give; the arithmetic is shown.
 */
export interface AvailabilityInput {
  available: number;
  /** % of the available who qualify (the screener's pass rate) */
  incidence?: number;
  /** % of those invited who complete; absent = not applied (the available are taken as people who will answer) */
  responseRate?: number;
  /** population shares by cell label or a part of one ("Female", "18-34"), in % */
  shares?: Record<string, number>;
  counts?: QuotaCounts;
}
export interface CellAvailability {
  quota: string; cell: string; need: number; share: number | null; supply: number | null;
  status: "ok" | "tight" | "short" | "unknown"; because: string;
}
export interface AvailabilityReport {
  total: { need: number; supply: number; status: "ok" | "tight" | "short"; because: string };
  cells: CellAvailability[];
  assumptions: string[];
  lines: string[];
}

const fmt = (n: number) => Math.round(n).toLocaleString("en");
/* the words people use for a group and the words a cell is labelled with: "women" is the "Female" cell */
const SYNONYMS: [RegExp, string][] = [[/^(?:women|woman|females?|girls?|ladies)$/, "female"], [/^(?:men|man|males?|boys?|gentlemen)$/, "male"], [/^(?:under\s+|below\s+)?(\d+)\s*(?:-|to)\s*(\d+)(?:\s*(?:years?|yrs?|year\s+olds?))?$/, "$1-$2"], [/^(\d+)\s*(?:\+|plus|and\s+(?:over|above|older))(?:\s*(?:years?|yrs?))?$/, "$1+"]];
const key = (s: string) => { let k = s.trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").replace(/\s*[=≤<>].*$/, "").trim(); for (const [re, to] of SYNONYMS) if (re.test(k)) { k = k.replace(re, to); break; } return k; };

export function sampleAvailability(def: SurveyDefinition, input: AvailabilityInput): AvailabilityReport {
  const ir = (input.incidence ?? 100) / 100;
  const rr = (input.responseRate ?? 100) / 100;
  const pool = input.available * ir * rr;
  const shares = new Map(Object.entries(input.shares ?? {}).map(([k, v]) => [key(k), v / 100]));
  const assumptions: string[] = [];
  if (input.incidence === undefined) assumptions.push("no incidence given — every available person is taken to qualify");
  if (input.responseRate === undefined) assumptions.push("no response rate given — the available are taken as people who will complete");
  const total = Math.max(0, def.research?.sampleSize ?? 0, ...def.quotas.map((q) => q.targetTotal ?? q.cells.reduce((s, c) => s + effectiveLimit(q, c.limit, c.limitType), 0)));
  const done = Math.max(0, ...def.quotas.map((q) => Object.values(input.counts?.[q.id] ?? {}).reduce((s, n) => s + n, 0)));
  const needTotal = Math.max(0, total - (def.quotas.length ? Math.min(done, total) : 0));
  const status = (supply: number, need: number): "ok" | "tight" | "short" => (supply < need ? "short" : supply < need * 1.5 ? "tight" : "ok");
  const tStatus = status(pool, needTotal);
  const cells: CellAvailability[] = [];
  let crossed = false;
  for (const q of def.quotas) for (const c of q.cells) {
    const limit = effectiveLimit(q, c.limit, c.limitType);
    const need = Math.max(0, limit - (input.counts?.[q.id]?.[c.id] ?? 0));
    const labels = c.label.split(/\s+×\s+/);
    const parts = labels.map(key);
    const whole = shares.get(key(c.label));
    const each = parts.map((p) => shares.get(p));
    const share = whole ?? (each.every((x) => x !== undefined) ? each.reduce((a, b) => a! * b!, 1)! : null);
    if (whole === undefined && parts.length > 1 && share !== null) crossed = true;
    if (share === null) { cells.push({ quota: q.name, cell: c.label, need, share: null, supply: null, status: "unknown", because: `share of ${labels.filter((_, i) => each[i] === undefined).map((l) => l.replace(/\s*[=≤<>].*$/, "").trim()).join(" and ")} unknown — say “${labels.find((_, i) => each[i] === undefined)!.replace(/\s*[=≤<>].*$/, "").trim()} is N %” to check it` }); continue; }
    const supply = pool * share;
    const st = need === 0 ? "ok" : status(supply, need);
    cells.push({ quota: q.name, cell: c.label, need, share, supply, status: st, because: `${fmt(input.available)} × ${Math.round(ir * 100)} %${input.responseRate !== undefined ? ` × ${Math.round(rr * 100)} %` : ""} × ${Math.round(share * 1000) / 10} % = ${fmt(supply)} expected for ${fmt(need)} needed${st === "short" ? ` — short by ${fmt(need - supply)}` : st === "tight" ? " — less than 1.5× the need: little room for screen-outs and rejections" : ""}` });
  }
  if (crossed) assumptions.push("a crossed cell's share is the product of its parts' shares (the groups taken as independent)");
  const lines: string[] = [];
  lines.push(`Overall: ${fmt(pool)} expected completes (${fmt(input.available)} available${input.incidence !== undefined ? ` × ${input.incidence} % incidence` : ""}${input.responseRate !== undefined ? ` × ${input.responseRate} % response` : ""}) for ${fmt(needTotal)} still needed — ${tStatus === "ok" ? "enough" : tStatus === "tight" ? "tight" : "not enough"}.`);
  for (const c of cells.filter((x) => x.status === "short")) lines.push(`✗ ${c.quota} / ${c.cell}: ${c.because}.`);
  for (const c of cells.filter((x) => x.status === "tight")) lines.push(`! ${c.quota} / ${c.cell}: ${c.because}.`);
  const unknown = cells.filter((x) => x.status === "unknown");
  if (unknown.length) lines.push(`${unknown.length} cell${unknown.length === 1 ? "" : "s"} not checked — the population share of ${[...new Set(unknown.map((u) => u.because.replace(/^share of (.+?) unknown.*$/, "$1")))].slice(0, 6).join(", ")} was not given.`);
  const ok = cells.filter((x) => x.status === "ok").length;
  if (ok) lines.push(`✓ ${ok} cell${ok === 1 ? "" : "s"} with enough expected supply.`);
  if (assumptions.length) lines.push(`Assumed: ${assumptions.join("; ")}.`);
  return { total: { need: needTotal, supply: pool, status: tStatus, because: lines[0] }, cells, assumptions, lines };
}
