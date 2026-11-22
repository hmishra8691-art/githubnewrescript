import { applyPortalTemplate, portalTemplate, type PortalChange } from "@rescript/engine";
import { PortalSettings } from "@rescript/schema";

/**
 * RESEARCH OPERATIONS IN INTELLIGENT MODE — THE PARTS THAT ARE DECISIONS (2026-11-22). Pure, so they are tested
 * without a browser: what a settings request does to the survey's portal block, what depends on what, and what a
 * researcher's answer to "which column is the email?" does to the column mapping.
 * components/intelligent/copilot/opsTurn.ts does the reading and writing.
 */
export interface OpsQuestion { field: "email" | "external_id" | "name"; ask: string; options: string[]; chosen: string | null }

const editingWords = (p: PortalSettings) => (p.editing.mode === "none" ? "never" : p.editing.mode === "until_locked" ? "until you lock them" : p.editing.mode === "window" ? `for ${p.editing.windowHours ?? "?"} hours` : "until a date");
export function settingValue(p: PortalSettings, key: PortalChange["key"]): string {
  if (key === "enabled") return p.enabled ? "on" : "off";
  if (key === "messages") return p.messages ? "on" : "off";
  if (key === "editing") return editingWords(p);
  if (key === "maxAttempts") return p.maxAttempts ? String(p.maxAttempts) : "the survey's own rule";
  if (key === "template") return portalTemplate(p.template)?.name ?? "standard portal";
  if (key === "identity") return p.identity === "assessment" ? "an account for this assessment only" : "one account per person";
  return p.show[key.slice(5) as keyof PortalSettings["show"]] ? "on" : "off";
}
/** the same change the screen's controls make, one setting at a time */
export function applyPortalChange(p: PortalSettings, c: PortalChange): void {
  if (c.key === "enabled") p.enabled = c.value === true;
  else if (c.key === "messages") p.messages = c.value === true;
  else if (c.key === "editing") { p.editing.mode = c.value as PortalSettings["editing"]["mode"]; if (c.value === "window") p.editing.windowHours = c.hours; }
  else if (c.key === "maxAttempts") { if (typeof c.value === "number") p.maxAttempts = c.value; else delete p.maxAttempts; }
  else if (c.key === "identity") p.identity = c.value === "assessment" ? "assessment" : "persistent";
  else if (c.key === "template") { /* applied whole, by settingsAfter: a template sets many switches at once */ }
  else p.show[c.key.slice(5) as keyof PortalSettings["show"]] = c.value === true;
}
/** the portal block after the changes — a template first (it sets many switches), then the switches asked for */
export function settingsAfter(current: PortalSettings | undefined, changes: PortalChange[]): PortalSettings {
  let next = structuredClone(current ?? PortalSettings.parse({ enabled: false }));
  const t = changes.find((c) => c.key === "template");
  if (t) { if (typeof t.value === "string") next = applyPortalTemplate(next, t.value) ?? next; else delete next.template; }
  for (const c of changes) applyPortalChange(next, c);
  return next;
}


/** what depends on what, said before a change is applied rather than discovered in the portal */
export function settingNotes(after: PortalSettings, o: { scoredTest: boolean }): string[] {
  const notes: string[] = [];
  if (after.show.history && !after.show.answers) notes.push("Earlier attempts are only shown when respondents can see their answers. Ask for that too.");
  if (after.show.trends && !(after.show.scores && after.show.history)) notes.push("Change over time needs two things on: respondents can see their scores, and their earlier attempts.");
  if ((after.show.comparison || after.show.insights || after.show.projection || after.show.aiSummary) && !after.show.scores) notes.push("Comparison, sentences, projection and the AI paragraph are about scores: turn on “respondents can see their scores” as well.");
  if (after.show.scores && !after.scorecard?.dimensions.length && !o.scoredTest) notes.push("No score is defined yet, so there is nothing to show. Define one in Distribution → Respondent portal → Scores and comparisons → Add a score.");
  if (after.show.aiSummary) notes.push("The AI paragraph is charged to the project's AI budget each time a respondent asks for it.");
  if (after.editing.mode !== "none" && o.scoredTest) notes.push("This is a scored test: answers are final once submitted, whatever is chosen here.");
  return notes;
}

/** the researcher answered "which column is the email / the ID": that column takes the field, the others give it up */
export function answerColumn(mapping: Record<string, string>, q: OpsQuestion, header: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [h, t] of Object.entries(mapping)) next[h] = h === header ? q.field : t === q.field ? "embedded" : t;
  return next;
}

