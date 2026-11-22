import "server-only";
import {
  guessRespondentMapping, parseDelimitedList, parseSpreadsheet, prepareRespondentList, summariseRespondentList,
  type ColumnTarget, type PreparedRespondent,
} from "@rescript/exporters";

/**
 * ADDING PEOPLE TO A RESPONDENT LIST — THE TWO STAGES (extracted 2026-11-21 from the respondents route so the
 * database route and the database-less sandbox run the SAME checks).
 *
 *   preview   reads what was typed, pasted or uploaded; maps the columns; reports every finding row by row; says
 *             who is already on this survey's list; writes nothing
 *   commit    adds the rows the researcher just looked at — leaving out the people already on the list when asked
 *
 * Where the people are kept is the store's business: Postgres in the product, memory in the sandbox.
 */
export const MAX_ROWS = 20_000;

export interface IntakeStore {
  /** which of these are already on this survey's list (lower-cased emails and ids) */
  existing(emails: string[], externalIds: string[]): Promise<{ emails: Set<string>; externalIds: Set<string> }>;
  /** add them; `rejected` names the ones the list refused (already there) */
  insert(people: PreparedRespondent[], listName: string | null): Promise<{ inserted: number; rejected: string[] } | { error: string; status: number; migration?: string }>;
}

export type IntakeOutcome = { status: number; body: Record<string, unknown>; committed?: { inserted: number; rejected: number; listName: string | null } };

/** the same precedence as the list's unique index: the id when there is one, the address otherwise */
export function alreadyThere(p: PreparedRespondent, have: { emails: Set<string>; externalIds: Set<string> }): boolean {
  return p.external_id ? have.externalIds.has(p.external_id.toLowerCase()) : !!p.email && have.emails.has(p.email.toLowerCase());
}

export async function runIntake(store: IntakeStore, body: any, environment: "TEST" | "LIVE"): Promise<IntakeOutcome> {
  const stage = body?.stage === "commit" ? "commit" : "preview";
  const listName = String(body?.listName ?? "").trim().slice(0, 120) || null;

  let headers: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let sheetInfo: { sheetName?: string; sheetNames?: string[] } = {};

  if (Array.isArray(body?.rows)) {
    rows = body.rows as Record<string, unknown>[];
    headers = Array.isArray(body?.headers) && body.headers.length ? body.headers.map(String) : Object.keys(rows[0] ?? {});
  } else if (typeof body?.xlsxBase64 === "string" && body.xlsxBase64) {
    /* a workbook is parsed on the server: the spreadsheet library is already here, and not in the browser bundle */
    try {
      const parsed = await parseSpreadsheet(Buffer.from(body.xlsxBase64, "base64"), { sheet: body?.sheet });
      headers = parsed.headers; rows = parsed.rows;
      sheetInfo = { sheetName: parsed.sheetName, sheetNames: parsed.sheetNames };
    } catch (e) {
      return { status: 422, body: { error: `that workbook could not be read: ${(e as Error).message}` } };
    }
  } else if (typeof body?.text === "string" && body.text.trim()) {
    const parsed = parseDelimitedList(body.text);
    headers = parsed.headers; rows = parsed.rows;
  } else {
    return { status: 422, body: { error: "nothing to import — type people in, paste a list, or choose a file" } };
  }

  if (!rows.length) return { status: 422, body: { error: "that file has a header row and no people in it" } };
  if (rows.length > MAX_ROWS) return { status: 413, body: { error: `${rows.length} rows is more than this can take at once (${MAX_ROWS}). Split the file.` } };

  const mapping: Record<string, ColumnTarget> = body?.mapping && typeof body.mapping === "object" ? body.mapping : guessRespondentMapping(headers);
  const parsed = prepareRespondentList(rows, mapping);
  const { people: prepared, issues, duplicates, problems } = parsed;
  const summary = summariseRespondentList(rows.length, parsed, mapping);

  /* who is already on this survey's list — said in the preview, and left out on commit when asked */
  let have = { emails: new Set<string>(), externalIds: new Set<string>() };
  try {
    have = await store.existing(prepared.filter((p) => !p.external_id && p.email).map((p) => p.email!.toLowerCase()), prepared.filter((p) => p.external_id).map((p) => p.external_id!.toLowerCase()));
  } catch { /* the list cannot be read (a migration not applied): the commit below says so */ }
  const onList = prepared.filter((p) => alreadyThere(p, have));

  if (stage === "preview") {
    return { status: 200, body: {
      stage: "preview", environment, listName, headers, mapping, ...sheetInfo, summary,
      issues: issues.slice(0, 20), duplicates: duplicates.slice(0, 20), problems,
      alreadyOnList: { count: onList.length, examples: onList.slice(0, 10).map((p) => p.email ?? p.external_id ?? p.name ?? "") },
      sample: prepared.slice(0, 10), rows,
      /* nothing blocks an upload except having no people in it */
      blocking: prepared.length === 0 ? "none of those rows has an email, an id or a name, so there is nobody to invite" : null,
    } };
  }

  if (!prepared.length) return { status: 422, body: { error: "there is nobody to invite in that file" } };
  const toAdd = body?.skipExisting === true ? prepared.filter((p) => !alreadyThere(p, have)) : prepared;
  const skipped = prepared.length - toAdd.length;
  if (!toAdd.length) return { status: 200, body: { ok: true, stage: "commit", environment, listName, inserted: 0, alreadyOnTheList: onList.slice(0, 20).map((p) => p.email ?? p.external_id ?? p.name ?? ""), alreadyOnTheListCount: skipped, summary }, committed: { inserted: 0, rejected: skipped, listName } };

  const out = await store.insert(toAdd, listName);
  if ("error" in out) return { status: out.status, body: { error: out.error, ...(out.migration ? { migration: out.migration } : {}) } };
  return {
    status: 200,
    body: { ok: true, stage: "commit", environment, listName, inserted: out.inserted, alreadyOnTheList: out.rejected.slice(0, 20), alreadyOnTheListCount: out.rejected.length + skipped, summary },
    committed: { inserted: out.inserted, rejected: out.rejected.length + skipped, listName },
  };
}

/* ------------------------------------------------------------------ the sandbox's list (no database, never in production) */

export interface SandboxPerson { id: string; token: string; name: string | null; email: string | null; external_id: string | null; status: string; list_name: string | null; sent_at: string | null; invited_at: string; embedded: Record<string, unknown>; is_test: boolean }
declare global {
  // eslint-disable-next-line no-var
  var __rescriptSandboxPeople: SandboxPerson[] | undefined;
}
export const sandboxPeople = (): SandboxPerson[] => (globalThis.__rescriptSandboxPeople ??= []);
/** the /sandbox fixture answers from memory only where there is no database and it is not production */
export const peopleSandboxAllowed = (surveyId: string): boolean => surveyId === "sandbox" && !process.env.SUPABASE_URL && !process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NODE_ENV !== "production";

export function sandboxStore(isTest: boolean): IntakeStore {
  const mine = () => sandboxPeople().filter((p) => p.is_test === isTest);
  return {
    async existing(emails, ids) {
      const e = new Set(emails), x = new Set(ids);
      return { emails: new Set(mine().filter((p) => !p.external_id && p.email && e.has(p.email.toLowerCase())).map((p) => p.email!.toLowerCase())), externalIds: new Set(mine().filter((p) => p.external_id && x.has(p.external_id.toLowerCase())).map((p) => p.external_id!.toLowerCase())) };
    },
    async insert(people, listName) {
      let inserted = 0; const rejected: string[] = [];
      for (const p of people) {
        /* the same rule as the database's unique index on (survey, environment, external id) */
        if (p.external_id && mine().some((q) => q.external_id?.toLowerCase() === p.external_id!.toLowerCase())) { rejected.push(p.external_id); continue; }
        const n = sandboxPeople().length + 1;
        sandboxPeople().push({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, token: `sandbox${String(n).padStart(25, "0")}`, name: p.name, email: p.email, external_id: p.external_id, status: "invited", list_name: listName, sent_at: null, invited_at: new Date(Date.now() + n).toISOString(), embedded: p.embedded, is_test: isTest });
        inserted++;
      }
      return { inserted, rejected };
    },
  };
}
