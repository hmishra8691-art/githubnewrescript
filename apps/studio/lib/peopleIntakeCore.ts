/**
 * ADDING PEOPLE — WHAT THE SCREEN DECIDES BEFORE ANYTHING IS SENT (2026-11-21). Pure, browser-safe.
 *
 * Three ways in, one way out. A researcher types people in, pastes a column of addresses, or uploads a file made
 * from the template; all three become the same rows with the same three headings, go through the same server check,
 * and are shown in the same preview before anything is added. Nothing here writes anything.
 */
export interface ManualRow { name: string; email: string; id: string }
export const EMPTY_ROW: ManualRow = { name: "", email: "", id: "" };
export const MANUAL_HEADERS = ["name", "email", "id"] as const;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const ACCEPTED_FILES = ".csv,.tsv,.txt,.xlsx,.xlsm";
export const ACCEPTED_FILES_WORDS = "Excel (.xlsx) or CSV";

/**
 * A pasted block of people, however it was copied: one per line or separated by commas or semicolons;
 * `Ada Lovelace <ada@example.com>`, `Ada Lovelace, ada@example.com`, `ada@example.com Ada Lovelace`, or just the
 * address. A piece with no address in it is kept as a name, so nothing typed is silently thrown away.
 */
export function parseQuickPaste(text: string): ManualRow[] {
  const out: ManualRow[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const found = line.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];
    if (found.length <= 1) {
      const email = (found[0] ?? "").replace(/[.]+$/, "");
      const name = line.replace(found[0] ?? "", " ").replace(/[<>"]/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/\s+/g, " ").trim();
      if (email || name) out.push({ name, email: email.toLowerCase(), id: "" });
      continue;
    }
    /* several addresses on one line: each piece between separators is one person */
    for (const piece of line.split(/[;,]/)) {
      const m = piece.match(/[^\s<>"']+@[^\s<>"']+/);
      if (!m) continue;
      const name = piece.replace(m[0], " ").replace(/[<>"]/g, " ").replace(/\s+/g, " ").trim();
      out.push({ name, email: m[0].replace(/[.]+$/, "").toLowerCase(), id: "" });
    }
  }
  return out;
}

export const isBlank = (r: ManualRow) => !r.name.trim() && !r.email.trim() && !r.id.trim();

/** what is wrong with each typed row, said beside it as it is typed (row index → sentence) */
export function manualProblems(rows: ManualRow[]): Record<number, string> {
  const out: Record<number, string> = {};
  const emails = new Map<string, number>(), ids = new Map<string, number>();
  rows.forEach((r, i) => {
    if (isBlank(r)) return;
    const email = r.email.trim().toLowerCase(), id = r.id.trim().toLowerCase();
    if (email && !EMAIL.test(email)) out[i] = "This does not look like an email address.";
    else if (id && ids.has(id)) out[i] = `The same ID is on line ${ids.get(id)! + 1}.`;
    else if (!id && email && emails.has(email)) out[i] = `The same email is on line ${emails.get(email)! + 1}.`;
    else if (!email && !id) out[i] = "Add an email or an ID, so this person can be invited and told apart.";
    if (id && !ids.has(id)) ids.set(id, i);
    if (email && !emails.has(email)) emails.set(email, i);
  });
  return out;
}

/** typed rows as the upload the server reads: the three headings, blank lines dropped */
export function manualToUpload(rows: ManualRow[]): { headers: string[]; rows: Record<string, string>[] } {
  return { headers: [...MANUAL_HEADERS], rows: rows.filter((r) => !isBlank(r)).map((r) => ({ name: r.name.trim(), email: r.email.trim(), id: r.id.trim() })) };
}

/** merge pasted people into the typed rows: blank typed rows are replaced, nobody already typed is repeated */
export function mergeRows(current: ManualRow[], added: ManualRow[]): ManualRow[] {
  const kept = current.filter((r) => !isBlank(r));
  const seen = new Set(kept.map((r) => r.email.trim().toLowerCase()).filter(Boolean));
  for (const r of added) { const e = r.email.trim().toLowerCase(); if (e && seen.has(e)) continue; if (e) seen.add(e); kept.push(r); }
  return kept;
}

export interface IntakeSummary { read: number; people: number; dropped: number; duplicatesInFile: number; invalidEmails?: number; withEmail: number; withExternalId: number; embeddedFields: string[] }
export interface IntakeProblem { row: number; kind: string; value: string; skipped: boolean; message: string }

/** the preview's headline, in one sentence a researcher can act on */
export function previewHeadline(s: IntakeSummary, alreadyOnList: number, skipExisting: boolean, envWord: string): string {
  const adding = Math.max(0, s.people - (skipExisting ? alreadyOnList : 0));
  if (s.people === 0) return "There is nobody to add in this list.";
  const left = [s.duplicatesInFile ? `${s.duplicatesInFile} repeated in the file` : "", skipExisting && alreadyOnList ? `${alreadyOnList} already on the list` : ""].filter(Boolean);
  return `${adding} ${adding === 1 ? "person" : "people"} will be added to the ${envWord} list${left.length ? ` (${left.join(", ")} left out)` : ""}.`;
}

/** a list name that is safe to offer for a file: its name without the extension */
export const listNameFromFile = (fileName: string): string => fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
