import { guessRespondentMapping, type ColumnTarget, type RespondentField } from "./respondentList.js";

/**
 * WHICH COLUMN IS WHAT, READ FROM THE FILE ITSELF (2026-11-22).
 *
 * `guessRespondentMapping` reads the headings only, and only the headings it has seen before. A client's file
 * calls its columns whatever the client calls them ("Work e-mail", "Staff no.", "Surname", "Correo"), so this reads
 * the VALUES as well: a column whose cells are email addresses is the email column whatever it is called; an ID is
 * a column whose heading says so and whose values are all different; a name is one column, or a first-name and a
 * last-name column joined in that order.
 *
 * It never decides silently when two columns could be the same thing: it picks the likelier one as the default and
 * returns a QUESTION naming both, which the screen (or the agent) puts to the researcher before anything is added.
 * Every decision carries the reason it was made, in words.
 */
export interface ColumnReading { header: string; target: ColumnTarget; why: string }
export interface ColumnQuestion { field: RespondentField; ask: string; options: string[]; chosen: string | null }
export interface PeopleColumns {
  /** keys are in the order `prepareRespondentList` should read them: a first name before a last name */
  mapping: Record<string, ColumnTarget>;
  columns: ColumnReading[];
  questions: ColumnQuestion[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SAMPLE = 300;
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").trim();

const EMAIL_HEAD = /\b(e ?mails?|mail|correo|courriel)\b/;
const ID_HEAD = /\b(id|ids|identifier|code|number|no|nr|num|ref|reference|key)\b/;
/* headings that carry "number" or "code" and are not who the person is */
const NOT_ID_HEAD = /\b(phone|mobile|cell|tel|telephone|fax|zip|post|postal|postcode|pin|area|country|dial)\b/;
const FULL_NAME_HEAD = /^(name|full name|respondent name|participant name|employee name|contact|contact name|nombre completo|nom complet)$/;
const FIRST_NAME_HEAD = /^(first|first name|given name|forename|fname|vorname|prenom|prénom|nombre)$/;
const LAST_NAME_HEAD = /^(last|last name|family name|surname|lname|nachname|nom|apellido|apellidos)$/;

interface Stats { header: string; filled: number; emailShare: number; uniqueShare: number; avgLength: number; nameShare: number }
/* two to four words of letters: "Ada Lovelace", "José Ángel de la Cruz" — not "Ops", not "North-2", not an address */
const PERSON = /^\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*){1,3}$/u;

function stats(header: string, rows: Record<string, unknown>[]): Stats {
  const values: string[] = [];
  for (const r of rows.slice(0, SAMPLE)) { const v = r[header]; const t = v == null ? "" : String(v).trim(); if (t) values.push(t); }
  const n = values.length;
  return {
    header, filled: n,
    emailShare: n ? values.filter((v) => EMAIL.test(v)).length / n : 0,
    uniqueShare: n ? new Set(values.map((v) => v.toLowerCase())).size / n : 0,
    avgLength: n ? values.reduce((s, v) => s + v.length, 0) / n : 0,
    nameShare: n ? values.filter((v) => PERSON.test(v)).length / n : 0,
  };
}

export function readPeopleColumns(headers: string[], rows: Record<string, unknown>[]): PeopleColumns {
  const heads = headers.map((h) => h?.trim()).filter((h): h is string => !!h);
  const st = new Map(heads.map((h) => [h, stats(h, rows)]));
  const exact = guessRespondentMapping(heads);
  const target = new Map<string, ColumnTarget>();
  const why = new Map<string, string>();
  const questions: ColumnQuestion[] = [];
  const share = (x: number) => `${Math.round(x * 100)}%`;

  /* ---- email: by what the cells contain first, by the heading second */
  const emailByContent = heads.filter((h) => st.get(h)!.filled > 0 && st.get(h)!.emailShare >= 0.6);
  const emailByHead = heads.filter((h) => !emailByContent.includes(h) && EMAIL_HEAD.test(norm(h)) && (st.get(h)!.filled === 0 || st.get(h)!.emailShare > 0));
  const emails = [...emailByContent, ...emailByHead].sort((a, b) =>
    Number(exact[b] === "email") - Number(exact[a] === "email") || st.get(b)!.emailShare * st.get(b)!.filled - st.get(a)!.emailShare * st.get(a)!.filled);
  if (emails.length) {
    const pick = emails[0]!;
    target.set(pick, "email");
    why.set(pick, emailByContent.includes(pick) ? `its values are email addresses (${share(st.get(pick)!.emailShare)} of the filled cells)` : "its heading says email");
    if (emails.length > 1) questions.push({ field: "email", ask: `${emails.length} columns hold email addresses. Which one should invitations go to?`, options: emails, chosen: pick });
  }

  /* ---- their own ID: the heading must say so, and the values must tell people apart */
  const ids = heads.filter((h) => !target.has(h) && ID_HEAD.test(norm(h)) && !NOT_ID_HEAD.test(norm(h)) && st.get(h)!.emailShare < 0.2
    && (st.get(h)!.filled === 0 || (st.get(h)!.uniqueShare >= 0.95 && st.get(h)!.avgLength <= 60)))
    .sort((a, b) => Number(exact[b] === "external_id") - Number(exact[a] === "external_id") || st.get(b)!.filled - st.get(a)!.filled);
  if (ids.length) {
    const pick = ids[0]!;
    target.set(pick, "external_id");
    why.set(pick, st.get(pick)!.filled ? "its heading says it is an ID, and every value is different" : "its heading says it is an ID");
    if (ids.length > 1) questions.push({ field: "external_id", ask: `${ids.length} columns could be the person's ID. Which one identifies each person?`, options: ids, chosen: pick });
  }

  /* ---- the name: one column, or first and last joined in that order */
  const free = heads.filter((h) => !target.has(h));
  const full = free.find((h) => FULL_NAME_HEAD.test(norm(h)));
  const first = free.find((h) => FIRST_NAME_HEAD.test(norm(h)));
  const last = free.find((h) => h !== first && LAST_NAME_HEAD.test(norm(h)));
  const nameOrder: string[] = [];
  if (full) { nameOrder.push(full); why.set(full, "its heading says it is the person's name"); }
  else {
    if (first) { nameOrder.push(first); why.set(first, last ? "the first name; joined with the last name" : "the first name, used as the name"); }
    if (last) { nameOrder.push(last); why.set(last, first ? "the last name; joined after the first name" : "the last name, used as the name"); }
  }
  /* no heading says "name": a column whose cells read like people's names, nearly all different, is offered as the
     name — with its reason, and as a question when more than one column reads that way */
  if (!nameOrder.length) {
    const looks = free.filter((h) => st.get(h)!.filled >= 2 && st.get(h)!.nameShare >= 0.7 && st.get(h)!.uniqueShare >= 0.8);
    if (looks.length) {
      nameOrder.push(looks[0]!);
      why.set(looks[0]!, `its values read like people's names (${share(st.get(looks[0]!)!.nameShare)} are two or more words, nearly all different)`);
      if (looks.length > 1) questions.push({ field: "name", ask: `${looks.length} columns read like people's names. Which one is the person's name?`, options: looks, chosen: looks[0]! });
    }
  }
  for (const h of nameOrder) target.set(h, "name");

  /* ---- nothing tells people apart: ask, do not guess */
  if (!emails.length && !ids.length && heads.length) {
    questions.push({ field: "email", ask: "No column looks like an email address or an ID. Which column tells one person from another?", options: heads.filter((h) => !nameOrder.includes(h)), chosen: null });
  }

  /* the mapping's key order is the reading order: name parts first-then-last, whatever order the file has them in */
  const mapping: Record<string, ColumnTarget> = {};
  for (const h of nameOrder) mapping[h] = "name";
  for (const h of heads) if (!(h in mapping)) mapping[h] = target.get(h) ?? "embedded";
  return {
    mapping, questions,
    columns: heads.map((h) => ({ header: h, target: mapping[h]!, why: why.get(h) ?? "kept with the person as extra information" })),
  };
}
