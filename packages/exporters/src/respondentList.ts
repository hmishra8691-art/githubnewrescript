/**
 * READING A CLIENT'S RESPONDENT LIST (§24).
 *
 * The file a client sends is never the file you would design. It has a title
 * row above the headings, a column called "Employee No." and another called
 * "e-mail", three people entered twice, one address with a space in it, and a
 * handful of empty rows at the bottom where somebody deleted content instead
 * of rows.
 *
 * This module turns that into respondents, and its governing rule is that a
 * list which refuses to load is worse than a list that loads with its
 * problems named. Inviting 3 997 of 4 000 people and being told which three
 * to fix is a working afternoon; being told "invalid email on row 2 891" and
 * nothing else is not.
 *
 * It lives here, beside `spreadsheetImport`, because it is the same concern —
 * making sense of somebody else's spreadsheet — and because it is pure, which
 * is the only reason it can be tested properly. The route that calls it does
 * the parts that are not pure: permissions, the two-stage preview, and the
 * insert that lets the database mint each token.
 */

/** What an uploaded column can become. Everything else travels as embedded data. */
export const RESPONDENT_FIELDS = ["email", "external_id", "name"] as const;
export type RespondentField = (typeof RESPONDENT_FIELDS)[number];
export type ColumnTarget = RespondentField | "embedded";

/**
 * How a column heading is guessed.
 *
 * Generous on purpose, because the alternative is a researcher hand-mapping
 * every column of every file — and these are the headings client files
 * actually use. A guess is only ever a default: the screen shows the mapping
 * and lets it be corrected before anything is written.
 */
const HEADER_GUESSES: Record<RespondentField, RegExp> = {
  email: /^(e[-_ ]?mails?|email[-_ ]?address(es)?|mail|address)$/i,
  external_id:
    /^(external[-_ ]?id|respondent[-_ ]?id|employee[-_ ]?(id|no\.?|number)|staff[-_ ]?id|member[-_ ]?id|customer[-_ ]?id|panel(ist)?[-_ ]?id|id|ref(erence)?)$/i,
  name: /^(name|full[-_ ]?name|respondent[-_ ]?name|contact([-_ ]?name)?|first[-_ ]?name)$/i,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * A default mapping for these headings.
 *
 * Each field is claimed at most once, by the FIRST heading that matches it,
 * so a file with both "id" and "employee_id" does not end up with two columns
 * fighting over `external_id` — the earlier one wins and the later becomes
 * embedded data, which is recoverable on screen. The alternative (last wins)
 * is not, because it silently changes which column identifies the person.
 */
export function guessRespondentMapping(headers: string[]): Record<string, ColumnTarget> {
  const out: Record<string, ColumnTarget> = {};
  const taken = new Set<RespondentField>();
  for (const raw of headers) {
    const key = raw?.trim();
    if (!key) continue;
    const hit = RESPONDENT_FIELDS.find((f) => !taken.has(f) && HEADER_GUESSES[f].test(key));
    if (hit) { out[key] = hit; taken.add(hit); }
    else out[key] = "embedded";
  }
  return out;
}

/**
 * Split pasted text into a heading row and rows.
 *
 * Tab or comma, decided by whichever the first line has more of — a pasted
 * column out of Excel is tab-separated, and a saved file is usually not.
 * Quoted fields are honoured, because a name like `Smith, Ada` is ordinary.
 */
export function parseDelimitedList(text: string): { headers: string[]; rows: Record<string, unknown>[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { headers: [], rows: [] };
  const delim = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";

  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };

  const headers = split(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cells = split(l);
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

export interface PreparedRespondent {
  email: string | null;
  external_id: string | null;
  name: string | null;
  /** every column that was not a field, kept with the person */
  embedded: Record<string, unknown>;
}

export interface PreparedList {
  people: PreparedRespondent[];
  /** things worth reading, none of which stops the upload */
  issues: string[];
  /** rows with nothing to identify anybody by */
  dropped: number;
  /** the same person twice IN THIS FILE — the second occurrence is skipped */
  duplicates: string[];
}

/**
 * Turn parsed rows into respondents.
 *
 * A row is dropped for ONE reason: there is nobody in it — no address, no id,
 * no name. Everything else is kept and reported, including addresses that do
 * not look like addresses, because "looks wrong" and "is wrong" are not the
 * same thing and a research team knows their client's data better than a
 * regular expression does.
 *
 * Duplicates are caught HERE rather than left to the database's unique index,
 * because the index can only refuse the second row — it cannot say which row
 * it clashed with, and "duplicate key value violates unique constraint" is
 * not a usable message about a file with 4 000 rows in it.
 */
export function prepareRespondentList(
  rows: Record<string, unknown>[],
  mapping: Record<string, ColumnTarget>,
): PreparedList {
  const people: PreparedRespondent[] = [];
  const issues: string[] = [];
  const duplicates: string[] = [];
  const seenExternal = new Set<string>();
  const seenEmail = new Set<string>();
  let dropped = 0;
  let badEmails = 0;

  rows.forEach((raw, i) => {
    const rec: PreparedRespondent = { email: null, external_id: null, name: null, embedded: {} };

    for (const [column, target] of Object.entries(mapping)) {
      const value = raw[column];
      const text = value == null ? "" : String(value).trim();
      if (target === "embedded") {
        if (text !== "") rec.embedded[column] = text;
        continue;
      }
      if (text === "") continue;
      /*
       * The address is lowercased because it is a matching key — the same
       * person written `Ada@Example.com` in one file and `ada@example.com` in
       * the next must be one person, or the reminder file invites them again.
       */
      if (target === "email") rec.email = text.toLowerCase();
      else if (target === "external_id") rec.external_id = text;
      else rec.name = text.slice(0, 200);
    }

    if (!rec.email && !rec.external_id && !rec.name) { dropped++; return; }

    if (rec.email && !EMAIL_RE.test(rec.email)) {
      badEmails++;
      // +2 because a human counting rows in their spreadsheet counts the heading
      if (badEmails <= 5) issues.push(`row ${i + 2}: “${rec.email}” does not look like an email address`);
    }

    /*
     * The id is the dedupe key when there is one, and the address otherwise —
     * the same precedence the database's partial unique index uses, so this
     * check and that constraint can never disagree about who is a duplicate.
     */
    if (rec.external_id) {
      const key = rec.external_id.toLowerCase();
      if (seenExternal.has(key)) { duplicates.push(rec.external_id); return; }
      seenExternal.add(key);
    } else if (rec.email) {
      if (seenEmail.has(rec.email)) { duplicates.push(rec.email); return; }
      seenEmail.add(rec.email);
    }

    people.push(rec);
  });

  if (badEmails > 5) issues.push(`…and ${badEmails - 5} more addresses that do not look valid`);
  return { people, issues, dropped, duplicates };
}

/** What the preview shows, so the screen and the route cannot describe it differently. */
export function summariseRespondentList(
  read: number,
  prepared: PreparedList,
  mapping: Record<string, ColumnTarget>,
) {
  return {
    read,
    people: prepared.people.length,
    dropped: prepared.dropped,
    duplicatesInFile: prepared.duplicates.length,
    withEmail: prepared.people.filter((p) => p.email).length,
    withExternalId: prepared.people.filter((p) => p.external_id).length,
    embeddedFields: [...new Set(Object.entries(mapping).filter(([, t]) => t === "embedded").map(([c]) => c))],
  };
}
