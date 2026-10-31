/**
 * S3b item 5 (audit MM-09) — PER-SCRIPT HISTORY AND A READABLE DIFF. The Versions panel compares whole definitions as
 * JSON lines; a programmer asking "what changed in THIS script" needs that item's code from two versions, as code
 * lines. Pure:
 *   · `itemKey` / `itemCode` — the item's code in any definition (a saved version, this session's undo history, now),
 *     by the script audit log's item (`${kind}:${id}`, engine `scriptItems`) so the history and the log agree;
 *   · `lineDiff` — a line diff (longest common subsequence), with line numbers on both sides;
 *   · `itemAuditEntries` — the S1c audit entries of one item.
 */
import type { SurveyDefinition } from "@rescript/schema";
import { scriptItems, type ScriptItemKind } from "@rescript/engine";

export const itemKey = (kind: ScriptItemKind, id: string) => `${kind}:${id}`;

/** the item's code in a definition; null when the item is not there (removed, or not yet added) */
export function itemCode(def: SurveyDefinition | null | undefined, key: string): string | null {
  const it = scriptItems(def).find((x) => `${x.kind}:${x.id}` === key);
  return it ? it.code : null;
}

export interface DiffLine { op: "same" | "add" | "del"; text: string; a?: number; b?: number }

/** a line diff of two texts (LCS); beyond `max` lines on either side, the middle is compared as one block */
export function lineDiff(before: string | null, after: string | null, max = 1500): DiffLine[] {
  const A = before == null || before === "" ? [] : before.replace(/\r\n?/g, "\n").split("\n");
  const B = after == null || after === "" ? [] : after.replace(/\r\n?/g, "\n").split("\n");
  // common head and tail first (most edits are small)
  let h = 0;
  while (h < A.length && h < B.length && A[h] === B[h]) h++;
  let t = 0;
  while (t < A.length - h && t < B.length - h && A[A.length - 1 - t] === B[B.length - 1 - t]) t++;
  const a = A.slice(h, A.length - t), b = B.slice(h, B.length - t);
  const out: DiffLine[] = [];
  for (let i = 0; i < h; i++) out.push({ op: "same", text: A[i]!, a: i + 1, b: i + 1 });
  if (a.length > max || b.length > max) {
    a.forEach((x, i) => out.push({ op: "del", text: x, a: h + i + 1 }));
    b.forEach((x, i) => out.push({ op: "add", text: x, b: h + i + 1 }));
  } else {
    const n = a.length, m = b.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { out.push({ op: "same", text: a[i]!, a: h + i + 1, b: h + j + 1 }); i++; j++; }
      /* a removal before an addition when both keep the subsequence as long: "- old / + new" reads as a replacement */
      else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) { out.push({ op: "del", text: a[i]!, a: h + i + 1 }); i++; }
      else { out.push({ op: "add", text: b[j]!, b: h + j + 1 }); j++; }
    }
  }
  for (let k = 0; k < t; k++) out.push({ op: "same", text: A[A.length - t + k]!, a: A.length - t + k + 1, b: B.length - t + k + 1 });
  return out;
}

export const diffStats = (d: DiffLine[]) => ({ added: d.filter((x) => x.op === "add").length, removed: d.filter((x) => x.op === "del").length });

/** the diff as text, `+`/`-`/` ` prefixed; unchanged runs longer than `context` * 2 are folded */
export function diffText(d: DiffLine[], context = 3): string {
  const keep = d.map((x, i) => x.op !== "same" || d.slice(Math.max(0, i - context), i + context + 1).some((y) => y.op !== "same"));
  const out: string[] = [];
  let skipped = 0;
  d.forEach((x, i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { out.push(`  … ${skipped} unchanged line${skipped === 1 ? "" : "s"}`); skipped = 0; }
    out.push(`${x.op === "add" ? "+" : x.op === "del" ? "-" : " "} ${x.text}`);
  });
  if (skipped) out.push(`  … ${skipped} unchanged line${skipped === 1 ? "" : "s"}`);
  return out.join("\n");
}

export interface AuditEntryLike { action: string; at: string; who: string; detail: Record<string, unknown>; text: string }
/** the audit log's entries for one item (newest first, as the route returns them) */
export function itemAuditEntries<T extends AuditEntryLike>(entries: T[], key: string): T[] {
  return entries.filter((e) => `${String(e.detail?.kind ?? "")}:${String(e.detail?.itemId ?? "")}` === key);
}
