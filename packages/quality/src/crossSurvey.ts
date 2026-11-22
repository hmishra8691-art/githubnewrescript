import { fnv1a, isGenericAnswer, normalizeText, textSimilarity, words } from "./metrics.js";

/**
 * CROSS-SURVEY DUPLICATES (Level 5 roadmap F3 — 2026-11-29).
 *
 * Inside one survey, the duplicate rules compare a response with its peers. Across surveys, identity resolution
 * (0083) already merges the same e-mail, phone or panel ID into one trust id, and the fraud graph (0085) finds rings
 * of identities sharing devices and networks. Two things neither sees:
 *
 *   text_reuse         the same open-ended answer (identical, or nearly — 85% character-shingle overlap, the in-survey rule's standard setting) given in DIFFERENT
 *                      surveys by DIFFERENT identities. Answer farms keep a stock of plausible paragraphs; a person
 *                      writing for themselves does not produce the same 12-word sentence as a stranger in another
 *                      study.
 *   same_person_reuse  one identity pasting the same paragraph into several studies. Informational: lazy, not
 *                      fraud, and the reviewer may want to know.
 *   pid_switch         one trust id behind two or more participant IDs of the same vendor: one person holding
 *                      several panel accounts, which is how a respondent gets into a study they were already in.
 *
 * Rules that keep it honest:
 *   - one organisation at a time; records of two organisations are refused, never compared;
 *   - short answers (under `minWords`) and generic ones ("very good product") are never evidence;
 *   - a text shared by very many sessions across many surveys is boilerplate (a piped default, a quoted brief),
 *     not a farm, and is dropped with a note;
 *   - nothing here blocks or rejects anyone. A finding opens a case for a person to review.
 */
export interface CrossSurveyRecord {
  customerId: string;
  surveyId: string;
  sessionId: string;
  responseId?: string | null;
  /** the trust id; null when identity resolution was not used — then each session counts as its own identity */
  identity?: string | null;
  completedAt?: string | null;
  texts: { key: string; text: string }[];
}
export interface VendorMapping { customerId: string; identity: string; integrationId: string; participantId: string }
export interface CrossSurveyOptions { minWords?: number; similarity?: number; boilerplateSessions?: number; boilerplateSurveys?: number }
export type CrossSurveyKind = "text_reuse" | "same_person_reuse" | "pid_switch";
export interface CrossSurveyFinding {
  kind: CrossSurveyKind;
  strength: "strong" | "moderate" | "informational";
  /** stable across runs: the same finding is recognised and not opened twice */
  signature: string;
  riskScore: number;
  reason: string;
  surveys: string[];
  members: { surveyId: string; sessionId: string; responseId?: string | null; identity: string | null }[];
  /** the start of the shared text, for the reviewer (text_reuse only) */
  sample?: string;
  participantIds?: string[];
}
export interface CrossSurveyReport { findings: CrossSurveyFinding[]; notes: string[]; compared: { sessions: number; texts: number; surveys: number } }

/** free-text answers out of a stored answers object: strings of at least `minWords` words (codes and short labels are not text) */
export function textsFromAnswers(answers: Record<string, unknown> | null | undefined, minWords = 8): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const [k, v] of Object.entries(answers ?? {})) {
    if (typeof v === "string" && words(v).length >= minWords) out.push({ key: k, text: v });
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (typeof v2 === "string" && words(v2).length >= minWords) out.push({ key: `${k}.${k2}`, text: v2 });
    }
  }
  return out;
}

export function crossSurveyDuplicates(records: CrossSurveyRecord[], mappings: VendorMapping[] = [], opts: CrossSurveyOptions = {}): CrossSurveyReport {
  const customers = new Set([...records.map((r) => r.customerId), ...mappings.map((m) => m.customerId)]);
  if (customers.size > 1) throw new Error("crossSurveyDuplicates compares one organisation at a time");
  const minWords = opts.minWords ?? 8, thr = opts.similarity ?? 0.85;
  const bpSessions = opts.boilerplateSessions ?? 50, bpSurveys = opts.boilerplateSurveys ?? 5;
  const notes: string[] = [];
  const findings: CrossSurveyFinding[] = [];
  const who = (r: CrossSurveyRecord) => r.identity ?? `session:${r.surveyId}:${r.sessionId}`;

  /* ---- text: bucket by the first eight normalised words, then compare inside a bucket */
  type Item = { r: CrossSurveyRecord; text: string; norm: string };
  const buckets = new Map<string, Item[]>();
  let texts = 0;
  for (const r of records) for (const t of r.texts) {
    if (words(t.text).length < minWords || isGenericAnswer(t.text)) continue;
    const norm = normalizeText(t.text);
    const key = norm.split(" ").slice(0, 8).join(" ");
    texts++;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push({ r, text: t.text, norm });
  }
  for (const items of buckets.values()) {
    if (items.length < 2 || new Set(items.map((i) => i.r.surveyId)).size < 2) continue;
    /* group within the bucket: union of pairs at or above the threshold */
    const parent = items.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      if (find(i) === find(j)) continue;
      if (items[i]!.norm === items[j]!.norm || textSimilarity(items[i]!.text, items[j]!.text) >= thr) parent[find(i)] = find(j);
    }
    const groups = new Map<number, Item[]>();
    items.forEach((it, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(it));
    for (const g of groups.values()) {
      const surveys = [...new Set(g.map((x) => x.r.surveyId))].sort();
      if (surveys.length < 2) continue;
      const sessions = [...new Map(g.map((x) => [`${x.r.surveyId}:${x.r.sessionId}`, x.r])).values()];
      if (sessions.length > bpSessions && surveys.length >= bpSurveys) { notes.push(`A text shared by ${sessions.length} sessions in ${surveys.length} surveys was treated as boilerplate (a default, piped or quoted text) and not reported.`); continue; }
      const identities = new Set(sessions.map(who));
      const same = identities.size === 1;
      const members = sessions.map((r) => ({ surveyId: r.surveyId, sessionId: r.sessionId, responseId: r.responseId ?? null, identity: r.identity ?? null }));
      const exact = new Set(g.map((x) => x.norm)).size === 1;
      findings.push({
        kind: same ? "same_person_reuse" : "text_reuse",
        strength: same ? "informational" : identities.size >= 3 || exact ? "strong" : "moderate",
        signature: `xs:${same ? "self" : "text"}:${fnv1a(members.map((m) => `${m.surveyId}:${m.sessionId}`).sort().join("|"))}`,
        riskScore: same ? 0 : identities.size >= 3 || exact ? 70 : 50,
        reason: same
          ? `The same respondent gave the same ${words(g[0]!.text).length}-word answer in ${surveys.length} surveys.`
          : `${exact ? "The same" : "Nearly the same"} ${words(g[0]!.text).length}-word answer was given by ${identities.size} different respondents in ${surveys.length} surveys.`,
        surveys, members, sample: g[0]!.text.slice(0, 120),
      });
    }
  }

  /* ---- one identity, several participant IDs at one vendor */
  const byKey = new Map<string, Set<string>>();
  for (const m of mappings) (byKey.get(`${m.identity}\u0000${m.integrationId}`) ?? byKey.set(`${m.identity}\u0000${m.integrationId}`, new Set()).get(`${m.identity}\u0000${m.integrationId}`)!).add(m.participantId);
  for (const [key, pids] of byKey) {
    if (pids.size < 2) continue;
    const [identity, integrationId] = key.split("\u0000") as [string, string];
    const mine = records.filter((r) => r.identity === identity);
    const surveys = [...new Set(mine.map((r) => r.surveyId))].sort();
    findings.push({
      kind: "pid_switch", strength: "strong",
      signature: `xs:pid:${fnv1a(`${identity}|${integrationId}|${[...pids].sort().join(",")}`)}`,
      riskScore: 75,
      reason: `One respondent is behind ${pids.size} participant IDs of the same vendor${surveys.length ? `, seen in ${surveys.length} survey${surveys.length === 1 ? "" : "s"}` : ""}.`,
      surveys, members: mine.map((r) => ({ surveyId: r.surveyId, sessionId: r.sessionId, responseId: r.responseId ?? null, identity })), participantIds: [...pids].sort(),
    });
  }
  findings.sort((a, b) => b.riskScore - a.riskScore);
  return { findings, notes, compared: { sessions: records.length, texts, surveys: new Set(records.map((r) => r.surveyId)).size } };
}
