/**
 * RESEARCH OPERATIONS IN WORDS (2026-11-22) — the sentences a researcher says about the PEOPLE of a study and
 * their portal, not about the questionnaire: "upload this file and use it for account creation and email
 * invitations", "create accounts for the Wave 1 list", "let respondents see their scores", "pause access for the
 * night shift", "how many people still have no account?", "where do I answer a privacy request?".
 *
 * Two things live here, both pure:
 *
 *   OPS_CAPABILITIES   what the six phases of the Respondent Intelligence Engine (and the people work after them)
 *                      added: what each function does, where it is on screen, what it needs first, and whether
 *                      Intelligent Mode DOES it (after a preview and a confirmation) or GUIDES to it, step by
 *                      step, with the reason each step exists.
 *   interpretOpsRequest  the sentence → a request. It only classifies. The Studio turns the request into a preview
 *                      card built from the platform's own routes, and nothing is written until the researcher
 *                      confirms (the same preview → Apply gate as every other Intelligent Mode change).
 *
 * A sentence about the questionnaire ("add a question about email", "rename the block") is never matched.
 */

/* ------------------------------------------------------------------ what exists */

export interface OpsCapability {
  id: string;
  /** 0 = the people and upload work; 1–6 = the phase of the Respondent Intelligence Engine */
  phase: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  what: string;
  /** the clicks that lead there by hand */
  where: string[];
  /** what must be true first */
  needs: string[];
  /** "does": the agent runs it after a preview and a confirmation; "guides": it says exactly where and why */
  agent: "does" | "guides";
  /** why the agent only guides, when it does */
  whyGuided?: string;
  /** a sentence that asks for it */
  say: string;
  /** by hand, in order, each with its reason after the dash */
  steps: string[];
  then: string;
  /** words that point at it in a question */
  match: RegExp;
}

const DIST = "Distribution";
const PORTAL = "Respondent portal";

export const OPS_CAPABILITIES: readonly OpsCapability[] = [
  { id: "people.add", phase: 0, name: "Add people to a list", agent: "does",
    what: "Puts people on this survey's respondent list from a file (Excel, CSV), from pasted cells or typed in. Columns are read from the file itself; nothing is added until the check has been seen.",
    where: [DIST, "Add people"], needs: ["A file or some names; each person needs an email address or an ID"],
    say: "Upload this file to a new list called Wave 1",
    steps: ["Open Distribution — the respondent list lives there", "Press Add people — one box for typing, uploading or pasting", "Choose the list — a list is a group you invite together", "Press Check the list — nothing is written yet; problems are named by row", "Confirm — the people are added, and anyone already listed is left out"],
    then: "Create their portal accounts, or download their links.", match: /\b(?:add|upload|import)\b.*\b(?:people|respondents?|participants?|list|file)\b/i },
  { id: "people.template", phase: 0, name: "Download the list template", agent: "guides", whyGuided: "A download is something your browser does; the agent gives you the link.",
    what: "An Excel or CSV file with the columns name, email, id, ready to fill in.", where: [DIST, "Add people", "Upload a file", "Download template"], needs: [],
    say: "Where is the template for the respondent file?",
    steps: ["Open Distribution and press Add people", "Choose Upload a file — the template buttons are there", "Download template (Excel) or (CSV), fill one person per row, delete the example row", "Upload the file and press Check the list"],
    then: "Upload the filled-in file, here or there.", match: /\btemplates?\b.*\b(?:file|list|upload|respondents?|people|excel|csv)\b|\b(?:file|list|upload|respondents?|people)\b.*\btemplates?\b/i },
  { id: "links.send", phase: 0, name: "Personal survey links: download or email them", agent: "guides", whyGuided: "A personal survey link is a different invitation from the portal's, and sending it is not connected to the agent yet. It is two clicks on the list, where you see how many will go before they do.",
    what: "Each person on a list has their own link to the survey. Download them as Excel or CSV to send yourself, or email them from the list when email is set up.", where: [DIST, "Your lists"], needs: ["People on a list", "The access mode set to unique links or invitation, for the list to decide who may take the survey"],
    say: "How do I email each person their survey link?",
    steps: ["Open Distribution — Your lists shows every list with how many links were sent", "Press Download links (Excel) to send them yourself, or Email N invitations when email is set up", "Press I sent these myself after sending a downloaded file — so “still waiting” counts correctly"],
    then: "The list shows who has started and who has completed.", match: /\b(?:survey|personal|unique) links?\b|\bdownload\b.*\blinks?\b/i },
  { id: "accounts.create", phase: 1, name: "Create portal accounts and send invitations", agent: "does",
    what: "Gives each person on a list a portal account. A person with an email address is emailed a link to set their own password; a person with none gets a link shown once to hand over.",
    where: [DIST, PORTAL, "People and accounts"], needs: ["The respondent portal switched on for the survey", "People on the live list", "Email set up on the installation, for invitations to be emailed"],
    say: "Create accounts for the Wave 1 list and send the invitations",
    steps: ["Open Distribution, Respondent portal — accounts belong to the portal", "Choose the list under List to work with — the button acts on that list", "Press Create accounts for the people without one — one account per person, joined by email address", "Note any links shown — they are for people with no email address and are shown once"],
    then: "People set their password from the invitation and see the assessment on their page.", match: /\baccounts?\b|\binvitations?\b|\blog-?ins?\b|\bcredentials\b/i },
  { id: "portal.settings", phase: 1, name: "Portal settings", agent: "does",
    what: "Whether the portal is on, what respondents may see (answers, earlier attempts, scores, comparison, change over time, sentences, projection, AI paragraph, achievements), whether they may change answers and for how long, attempts, messages, the template.",
    where: [DIST, PORTAL], needs: ["Saving and publishing the survey: settings are part of the survey and take effect once published"],
    say: "Turn on the portal and let respondents see their scores and how they changed over time",
    steps: ["Open Distribution, Respondent portal", "Tick On for this survey — nothing below applies until it is on", "Set the switches — each is off until you turn it on", "Save and publish — respondents get the settings of the published version"],
    then: "Publish the survey so the settings take effect.", match: /\bportal\b.*\bsettings?\b|\bswitch(?:es)?\b.*\bportal\b/i },
  { id: "access.control", phase: 1, name: "Pause, restore, lock and reopen", agent: "does",
    what: "Pauses or restores a person's access to this survey, and locks or unlocks their answers. Applies at once, to ticked people or a whole list.",
    where: [DIST, PORTAL, "More actions for the ticked people"], needs: ["People with a portal account"],
    say: "Pause access for the Night shift list",
    steps: ["Open Distribution, Respondent portal", "Choose the list, tick the people", "Open More actions and press Pause, Restore, Lock answers or Unlock — it applies immediately"],
    then: "The person's row shows Paused or Locked.", match: /\b(?:pause|suspend|restore|lock|unlock|reopen)\b/i },
  { id: "access.window", phase: 1, name: "Dates and attempts for some people", agent: "guides", whyGuided: "Dates are easy to get wrong in a sentence (which day, which time zone), so they are set on the screen where you can see them.",
    what: "An opening and closing time and a number of attempts for the ticked people.", where: [DIST, PORTAL, "More actions for the ticked people", "Set dates and attempts"], needs: ["People with a portal account"],
    say: "How do I give the night shift until Friday?",
    steps: ["Open Distribution, Respondent portal and choose the list", "Tick the people — the dates apply to them only", "Open More actions, set Opens, Closes and Attempts, press Set dates and attempts"],
    then: "Their row shows the window. Outside it the assessment is closed for them.", match: /\b(?:access )?(?:window|dates?|deadline|until (?:mon|tues|wednes|thurs|fri|satur|sun)day|closing (?:time|date))\b/i },
  { id: "accounts.password", phase: 1, name: "First password, sign out, remove from portal", agent: "guides", whyGuided: "A password is shown once on your screen and must not pass through a chat; signing out and removing act on one named person.",
    what: "Issues a first password for a person with no email address, ends a person's sessions, or removes this survey from their portal.", where: [DIST, PORTAL, "More actions for the ticked people", "One person"], needs: ["Exactly one person ticked"],
    say: "How do I give someone a first password?",
    steps: ["Open Distribution, Respondent portal", "Tick one person — these act on one person at a time", "Open More actions: Issue a first password (only for a person with no email address), Sign them out, or Remove from portal", "Hand over the password shown — it is displayed once and not stored readable"],
    then: "The person signs in with their Respondent ID and must choose a new password.", match: /\bpasswords?\b|\bsign(?:ed|ing)? (?:them |him |her )?out\b|\bremove\b.*\b(?:person|people|someone|somebody|him|her|them|respondents?)\b.*\bfrom (?:the )?portal\b/i },
  { id: "scores.define", phase: 2, name: "Scores and the scorecard", agent: "guides", whyGuided: "A score maps your own questions to a scale. Which questions, which are reverse-keyed and what the ranges are called is a research decision made on the scorecard editor.",
    what: "Defines the scores respondents see: from questions, a test total, a topic or a variable, with ranges such as Low and High.", where: [DIST, PORTAL, "Scores and comparisons", "Add a score"], needs: ["The questions the score is built from"],
    say: "How do I define a score for respondents?",
    steps: ["Open Distribution, Respondent portal, Scores and comparisons", "Press Add a score — choose what it is built from", "Name the ranges — respondents read these words", "Tick Respondents can see their scores, then save and publish", "Press Score the existing responses — so people who already answered are scored the same way"],
    then: "Each respondent sees their own scores, worked out from their own answers.", match: /\bscore ?cards?\b|\b(?:define|add|build|create)\b.*\bscores?\b|\bre-?scor|\bscore the existing\b|\bbands?\b|\branges?\b/i },
  { id: "scores.comparison", phase: 2, name: "Comparison with others", agent: "does",
    what: "Shows a respondent how they compare with everyone, never with a group smaller than 10 (more for some templates). The groups to compare by are chosen on screen.",
    where: [DIST, PORTAL, "Scores and comparisons"], needs: ["A score", "At least 10 scored people"],
    say: "Let respondents see how they compare with others",
    steps: ["Open Distribution, Respondent portal, Scores and comparisons", "Tick …and how they compare with others", "Choose the groups to compare by, if any — up to six", "Save and publish"],
    then: "A comparison appears once a group has enough people.", match: /\bcompar(?:e|ison)\b|\bbenchmarks?\b|\bminimum group\b/i },
  { id: "scores.report", phase: 2, name: "The respondent's PDF report", agent: "guides", whyGuided: "The report is the respondent's own download in their portal; there is nothing to switch on beyond their scores.",
    what: "A respondent downloads their latest results as a PDF from their results page.", where: ["The respondent's portal", "My results", "Download"], needs: ["Scores visible to respondents"],
    say: "Can respondents download their results?",
    steps: ["Make scores visible (Distribution, Respondent portal, Scores and comparisons)", "Publish", "The respondent opens My results and downloads the PDF — it is produced from their own answers"],
    then: "The PDF carries the template's heading and note.", match: /\bpdf\b|\breport\b.*\brespondents?\b|\bdownload\b.*\bresults\b/i },
  { id: "series", phase: 3, name: "Results over time and series", agent: "does",
    what: "Shows a respondent how their results changed, between attempts of one survey or across surveys that share a series key. The series key and period are typed on screen.",
    where: [DIST, PORTAL, "Scores and comparisons"], needs: ["Scores", "Respondents can see their earlier attempts"],
    say: "Show respondents how their scores changed over time",
    steps: ["Open Distribution, Respondent portal, Scores and comparisons", "Tick …and how they have changed over time", "For a series across surveys, tick the series box and type the SAME key in every survey of it — the key is what joins them", "Save and publish"],
    then: "My progress appears in the portal once a person has two like-for-like results.", match: /\bseries\b|\bover time\b|\bprogress\b|\btrends?\b|\bwaves?\b/i },
  { id: "individual", phase: 3, name: "One respondent's results, for a named professional", agent: "guides", whyGuided: "Opening a named person's results is recorded in the audit log against you, so it is done deliberately on the screen, one person at a time.",
    what: "A member with the individual-results permission opens one respondent's scores and history.", where: [DIST, PORTAL, "Open this person's results"], needs: ["The permission “Open one respondent's portal results and history”"],
    say: "How do I see one person's results?",
    steps: ["Ask the project owner for the individual-results permission, if the button is missing", "Open Distribution, Respondent portal and tick one person", "Press Open this person's results — each opening is recorded and shown to the respondent"],
    then: "You see scores only, never answers.", match: /\b(?:one|a|this|each) (?:person|respondent|patient|student|employee)(?:'s|’s)? (?:results|scores|history)\b|\bindividual results\b/i },
  { id: "template", phase: 4, name: "Portal template", agent: "does",
    what: "One of twenty kinds of portal (employee engagement, student assessment, patient-reported outcomes…): the words respondents read, a colour, starting settings, and a few rules that kind of study must not loosen.",
    where: [DIST, PORTAL, "Template"], needs: [],
    say: "Use the employee engagement template",
    steps: ["Open Distribution, Respondent portal, Template", "Choose a template and read what it always applies", "Press Use this template — it sets the switches and keeps your scores and groups", "Save and publish"],
    then: "Adjust the switches the template left open.", match: /\btemplates?\b/i },
  { id: "insights", phase: 5, name: "Sentences, projection and the AI paragraph", agent: "does",
    what: "Rule-written sentences about a person's results, a projection of their next result, and an optional paragraph written by the AI provider when the person asks. Health templates and candidate assessments never project or use the AI provider.",
    where: [DIST, PORTAL, "Scores and comparisons"], needs: ["Scores visible to respondents", "The project's AI budget, for the AI paragraph"],
    say: "Give respondents a few sentences about their results",
    steps: ["Open Distribution, Respondent portal, Scores and comparisons", "Tick A few sentences about their results; optionally the range for their next result and the AI paragraph", "Save and publish"],
    then: "Respondents see the sentences under their results.", match: /\binsights?\b|\bsentences\b|\bprojections?\b|\bforecast\b|\bai (?:summary|paragraph)\b/i },
  { id: "privacy", phase: 5, name: "Privacy requests and consent", agent: "guides", whyGuided: "A request is a person asking for a copy, a correction or deletion of their data. You carry it out first with the project's own tools; the answer is then recorded against your name.",
    what: "Respondents agree to a notice before using the portal, and can ask the organiser for a copy, a correction or deletion. You answer each request: done, or declined with a reason.",
    where: [DIST, PORTAL, "Privacy requests"], needs: ["Migration 0105 applied", "Permission to see contact details (to list) and to manage responses (to answer)"],
    say: "Where do I answer a privacy request?",
    steps: ["Open Distribution, Respondent portal, Privacy requests — open requests are listed there", "Do what was asked first, with the export, edit or erase tools — answering records the outcome, it does not change data", "Press Done, or Decline and give the reason — the respondent sees your answer and is notified"],
    then: "The answer is in the audit log and on the respondent's account page.", match: /\bprivacy\b|\bconsent\b|\b(?:data|deletion|erasure|access|correction) requests?\b|\bgdpr\b/i },
  { id: "achievements", phase: 6, name: "Achievements", agent: "does",
    what: "Shows respondents the points, level and badges the survey's gamification already awards, and their run of on-time completions. Recognition only, never money.",
    where: [DIST, PORTAL], needs: ["Gamification defined on the survey, for points and badges"],
    say: "Show respondents what they have earned",
    steps: ["Open Distribution, Respondent portal", "Tick Respondents can see what they have earned", "Save and publish"],
    then: "Achievements appear on the respondent's page.", match: /\bachievements?\b|\bbadges?\b|\bpoints\b|\brewards?\b|\bstreaks?\b/i },
  { id: "messages", phase: 6, name: "Messages with respondents", agent: "does",
    what: "Lets respondents write to your team about this survey. Switching it on is a setting; reading and replying is done on the Messages card, because a reply is a message sent in your name.",
    where: [DIST, PORTAL, "Messages"], needs: ["Migration 0106 applied"],
    say: "Let respondents write to our team",
    steps: ["Open Distribution, Respondent portal and tick Respondents can write to your team", "Save and publish", "Read and reply on the Messages card — the respondent is notified of a reply, never of its text by email"],
    then: "New messages appear on the Messages card.", match: /\bmessages?\b|\breply\b|\bwrite to (?:us|our team|the team)\b/i },
  { id: "reminders", phase: 6, name: "Notifications and reminders", agent: "guides", whyGuided: "Reminders are sent by a scheduled job on the installation, not by a request in a chat. An administrator switches it on once.",
    what: "An hourly job tells respondents that a repeated assessment is due or that one closes within two days, in the portal and by email. Nobody is reminded about a paused or closed assessment.",
    where: ["The installation: CRON_SECRET and the cron entry in apps/studio/vercel.json"], needs: ["Migration 0106 applied", "CRON_SECRET set", "A repeat interval on the survey, for due reminders"],
    say: "How do reminders work?",
    steps: ["Ask an administrator to set CRON_SECRET and deploy with the cron entry — the job runs hourly from then on", "For a repeated assessment, set the repeat interval in Scores and comparisons — the due date comes from it", "Set a closing time for people (More actions, Set dates and attempts) — closing-soon reminders come from it"],
    then: "Each reminder is sent once. There is not yet a way for a respondent to switch reminder emails off.", match: /\breminders?\b|\bnotif(?:y|ications?)\b|\bdue dates?\b/i },
];

export const opsCapability = (id: string): OpsCapability | null => OPS_CAPABILITIES.find((c) => c.id === id) ?? null;

/* ------------------------------------------------------------------ the request */

export type PortalSettingKey =
  | "enabled" | "show.answers" | "show.history" | "show.scores" | "show.bands" | "show.comparison" | "show.trends"
  | "show.insights" | "show.projection" | "show.aiSummary" | "show.rewards" | "messages"
  | "editing" | "maxAttempts" | "template" | "identity";

export interface PortalChange {
  key: PortalSettingKey;
  /** boolean switches; editing: "none" | "until_locked" | "window"; maxAttempts: a number or null; template: an id or null; identity */
  value: boolean | number | string | null;
  /** editing "window": for how many hours */
  hours?: number;
}

export type OpsRequest =
  | { op: "people"; text: string; add: boolean; accounts: boolean; invite: boolean;
      /** an existing list the sentence names, or the name for a new one */
      list: string | null; listIsNew: boolean; environment: "LIVE" | "TEST";
      /** "file": the attached file; "list": people already on a list; "everyone": the whole live list */
      source: "file" | "list" | "everyone"; missingFile: boolean }
  | { op: "settings"; text: string; changes: PortalChange[] }
  | { op: "access"; text: string; action: "suspend" | "reactivate" | "lock" | "unlock"; list: string | null }
  | { op: "status"; text: string }
  | { op: "guide"; text: string; capability: string }
  | { op: "capabilities"; text: string };

export interface OpsContext {
  /** a people file is attached to this turn */
  hasFile: boolean;
  /** the names of the survey's existing lists */
  lists: string[];
  templates: { id: string; name: string }[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const NUM: Record<string, number> = { one: 1, a: 1, an: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const num = (w: string | undefined): number | null => (w == null ? null : /^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? null);

/** the questionnaire's own vocabulary: such a sentence is somebody else's */
const SURVEY_EDIT = /\b(?:add|insert|create|delete|remove|rename|move|edit|change|reword)\s+(?:a\s+|an\s+|the\s+|this\s+)?(?:new\s+)?(?:\w+\s+)?(?:question|block|option|page|quota|skip|logic|variable|scale|matrix|choice|row|column heading)s?\b|\bQ\d+\b/i;
/** inviting a colleague is not inviting a respondent */
const TEAM = /\b(?:colleague|collaborator|co-?author|team ?mate|reviewer|editor|client|stakeholder|my (?:boss|manager))\b/i;
const PEOPLE = /\b(?:someone|somebody|person|respondents?|participants?|people|panel(?:ists)?|employees?|staff|students?|learners?|patients?|members?|customers?|candidates?|invitees?|contacts?|everyone|everybody|them|they|their)\b/i;
const PEOPLE_NOUN = /\b(?:respondents?|participants?|people|panel(?:ists)?|employees?|staff|students?|learners?|patients?|members?|customers?|candidates?|everyone|everybody)\b/i;
const FILEISH = /\b(?:file|sheet|spreadsheet|excel|csv|xlsx|upload(?:ed)?|attach(?:ed|ment)?|list|emails?)\b/i;
const NEGATIVE = /\b(?:disable|turn(?:ing)? off|switch(?:ing)? off|hide|stop|don[’']?t|do not|cannot|can[’']?t|never|no longer|not allowed|without|remove|block|prevent)\b/i;
const POSITIVE = /\b(?:enable|turn(?:ing)? on|switch(?:ing)? on|show|allow|let|can|may|should|give|make|display|start)\b/i;
const ASKING = /^(?:how|where|what|which|can i|could i|is there|do i|does|who|why|when)\b|\?$/i;

function namedList(text: string, lists: string[]): { list: string | null; isNew: boolean } {
  /* an existing list, by its own name, the longest first so "Wave 10" is not read as "Wave 1" */
  const low = text.toLowerCase();
  const known = [...lists].sort((a, b) => b.length - a.length).find((l) => l && new RegExp(`(?:^|[^\\p{L}\\p{N}])${l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "u").test(low));
  if (known) return { list: known, isNew: false };
  const quoted = /[“"']([^“”"']{1,120})[”"']/.exec(text)?.[1];
  const called = /\b(?:called|named|call it|name it|as)\s+(?:the\s+)?([A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*){0,5})/.exec(text)?.[1];
  const name = clean(quoted ?? called ?? "");
  return name ? { list: name, isNew: true } : { list: null, isNew: false };
}

function settingChanges(text: string, ctx: OpsContext): PortalChange[] {
  const out = new Map<PortalSettingKey, PortalChange>();
  const put = (c: PortalChange) => { if (!out.has(c.key)) out.set(c.key, c); };
  /* each clause carries its own yes or no; a clause that has neither inherits the one before it */
  let positive = true;
  for (const clause of text.split(/\s*(?:,|;|\band\b|\bbut\b|\bthen\b)\s*/i).filter(Boolean)) {
    if (NEGATIVE.test(clause)) positive = false; else if (POSITIVE.test(clause)) positive = true;
    const c = clause.toLowerCase();
    if (/\bportal\b/.test(c) && /\b(?:turn|switch|enable|disable|start|stop|set up|activate|open|close)\b/.test(c) && !/\bsettings?\b/.test(c)) put({ key: "enabled", value: positive });
    if (/\b(?:earlier|previous|past|prior) (?:attempts?|answers?|versions?)\b|\b(?:answer )?history\b/.test(c)) put({ key: "show.history", value: positive });
    else if (/\b(?:change|edit|correct|update|revise|amend)\b.*\b(?:answers?|responses?)\b/.test(c)) {
      const hours = /\bfor\s+(\d+|one|two|three|four|five|six|seven|ten|twelve|twenty)\s+(hours?|days?)\b/.exec(c);
      const h = hours ? (num(hours[1]) ?? 0) * (/day/.test(hours[2]!) ? 24 : 1) : 0;
      put(!positive ? { key: "editing", value: "none" } : h ? { key: "editing", value: "window", hours: h } : { key: "editing", value: "until_locked" });
      if (positive) put({ key: "show.answers", value: true });
    } else if (/\b(?:see|view|read|review|look at|show)\b.*\b(?:answers?|responses?)\b|\b(?:answers?|responses?)\b.*\b(?:visible|shown)\b/.test(c)) put({ key: "show.answers", value: positive });
    if (/\bcompar(?:e|ison|isons)\b|\bbenchmarks?\b|\bagainst (?:others|the group|everyone)\b/.test(c)) put({ key: "show.comparison", value: positive });
    if (/\bover time\b|\btrends?\b|\bprogress\b|\bchanged?\b.*\b(?:since|between|time)\b/.test(c)) put({ key: "show.trends", value: positive });
    else if (/\b(?:scores?|results)\b/.test(c) && /\b(?:see|view|show|read|display|visible|hide)\b/.test(c)) put({ key: "show.scores", value: positive });
    if (/\b(?:range names?|bands?|low and high|low, high)\b/.test(c)) put({ key: "show.bands", value: positive });
    if (/\binsights?\b|\b(?:a few )?sentences\b/.test(c)) put({ key: "show.insights", value: positive });
    if (/\bprojections?\b|\bforecasts?\b|\bnext result\b/.test(c)) put({ key: "show.projection", value: positive });
    if (/\bai\b.*\b(?:summary|paragraph|write-?up)\b|\b(?:summary|paragraph)\b.*\bai\b/.test(c)) put({ key: "show.aiSummary", value: positive });
    if (/\bachievements?\b|\bbadges?\b|\bpoints\b|\brewards?\b|\bearned\b|\bstreaks?\b/.test(c)) put({ key: "show.rewards", value: positive });
    if (/\bmessages?\b|\bwrite to (?:us|our team|the team|me)\b|\bcontact (?:us|the team)\b/.test(c) && !/\bsend\b.*\bmessage\b/.test(c)) put({ key: "messages", value: positive });
    const attempts = /\b(\d+|one|two|three|four|five|six|ten|single|a|an)\s+(?:attempts?|tries|try|retakes?)\b/.exec(c);
    if (attempts && num(attempts[1])) put({ key: "maxAttempts", value: num(attempts[1])! });
    else if (/\b(?:no|unlimited)\s+(?:limit on )?(?:attempts|retakes)\b|\bthe survey'?s own rule\b/.test(c)) put({ key: "maxAttempts", value: null });
    if (/\b(?:this|one) (?:assessment|survey) only\b|\bassessment-only\b/.test(c) && /\baccounts?\b/.test(c)) put({ key: "identity", value: "assessment" });
    if (/\btemplates?\b/.test(c)) {
      if (/\b(?:remove|no|without|clear|standard)\b/.test(c)) put({ key: "template", value: null });
      else {
        /* the template whose name shares the most words with the clause; a tie or nothing in common is no match */
        const words = new Set(c.replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 2 && !["the", "use", "apply", "template", "portal", "and", "for"].includes(w)));
        const scored = ctx.templates.map((t) => ({ t, n: t.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => words.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
        if (scored.length && (scored.length === 1 || scored[0]!.n > scored[1]!.n)) put({ key: "template", value: scored[0]!.t.id });
      }
    }
  }
  return [...out.values()];
}

export function interpretOpsRequest(raw: string, ctx: OpsContext): OpsRequest | null {
  const text = clean(String(raw ?? ""));
  if (!text || text.length > 600) return null;
  if (SURVEY_EDIT.test(text) || TEAM.test(text)) return null;
  const t = text.toLowerCase().replace(/[.!]+$/, "");
  const about = PEOPLE.test(t) || /\bportal\b|\baccounts?\b|\binvitations?\b|\blists?\b|\bprivacy requests?\b|\bconsent notice\b|\breminders?\b|\bfirst passwords?\b/.test(t);
  const { list, isNew } = namedList(text, ctx.lists);
  /* naming one of the survey's own lists is talking about its people */
  if (!about && !(list && !isNew) && !(ctx.hasFile && FILEISH.test(t))) return null;

  /* ---- "what can you do with the portal?" */
  if (/\bwhat can (?:you|the agent|i ask you to) (?:do|help)\b/.test(t) && /\bportal\b|\brespondents?\b|\baccounts?\b|\bpeople\b|\binvit/.test(t)) return { op: "capabilities", text };

  /* ---- a question about where or how: the function whose words it uses, the most specific first */
  const asking = ASKING.test(t);
  const guideOnly = OPS_CAPABILITIES.filter((c) => c.agent === "guides").find((c) => c.match.test(t));
  if (guideOnly && asking) return { op: "guide", text, capability: guideOnly.id };
  /* told, not asked — but these are never run from a sentence, so the answer is where to do them */
  const never = ["accounts.password", "privacy", "individual", "reminders", "links.send"].map((id) => opsCapability(id)!).find((c) => c.match.test(t));
  if (never) return { op: "guide", text, capability: never.id };

  /* ---- "how many people have an account?", "which lists do I have?" */
  if (/\bhow many\b|\bwho (?:has|hasn[’']?t|does not|doesn[’']?t|is|isn[’']?t|still)\b|\b(?:which|what) lists?\b|\bshow (?:me )?(?:the|my) lists?\b|\bstatus of\b/.test(t)
    && /\baccounts?\b|\blists?\b|\binvit|\bon the list\b|\bportal\b/.test(t)) return { op: "status", text };

  /* ---- pause, restore, lock, unlock — for a list or everyone */
  const action = /\b(?:un-?pause|restore|resume|reactivate|re-?enable)\b/.test(t) && /\baccess\b|\bportal\b|\blist\b|\bpeople\b|\beveryone\b|\brespondents?\b/.test(t) ? "reactivate"
    : /\b(?:pause|suspend)\b/.test(t) ? "suspend"
    : /\bunlock\b/.test(t) && /\banswers?\b|\bresponses?\b/.test(t) ? "unlock"
    : /\block\b/.test(t) && /\banswers?\b|\bresponses?\b/.test(t) && !/\buntil i lock\b/.test(t) ? "lock" : null;
  if (action && !asking) return { op: "access", text, action, list: isNew ? null : list };

  /* ---- people: add them, give them accounts, invite them */
  const accounts = /\baccounts?\b|\bportal access\b|\blog-?ins?\b|\bcredentials\b|\bregister\b|\benrol/.test(t) && !/\b(?:this|one) (?:assessment|survey) only\b/.test(t);
  const invite = /\binvit(?:e|es|ed|ing|ation|ations)\b|\bsend\b.*\b(?:emails?|links?|credentials|log-?ins?|access)\b|\bemail (?:them|everyone|everybody|the list|these|those)\b/.test(t);
  const add = /\b(?:upload|import|add|load|bring in|use|take|read|process)\b/.test(t) && (FILEISH.test(t) || /\bthese\b|\bthis\b/.test(t)) && (ctx.hasFile || /\b(?:file|sheet|spreadsheet|excel|csv|xlsx|upload)\b/.test(t));
  if ((accounts || invite || add) && !asking) {
    const source = add ? "file" : list && !isNew ? "list" : "everyone";
    return { op: "people", text, add, accounts: accounts || invite, invite, list, listIsNew: add ? isNew || (!!list && !ctx.lists.includes(list)) : false,
      environment: /\btest (?:list|respondents|people|run)\b/.test(t) ? "TEST" : "LIVE", source, missingFile: add && !ctx.hasFile };
  }

  /* ---- settings: what respondents may see and do. Only a sentence that names the portal or the people, and is not
     about a screen of the questionnaire ("show a progress bar", "show their score at the end of the survey") */
  const inSurvey = /\bprogress bar\b|\bend (?:of (?:the )?survey|screen|page)\b|\bin the (?:survey|questionnaire)\b|\bthank-?you (?:page|screen)\b|\bquestions?\b/.test(t);
  const changes = (/\bportal\b/.test(t) || PEOPLE_NOUN.test(t)) && !inSurvey ? settingChanges(text, ctx) : [];
  if (changes.length && !asking) return { op: "settings", text, changes };

  /* ---- anything else that names a function: say where it is and how it works */
  const any = guideOnly ?? OPS_CAPABILITIES.find((c) => c.match.test(t));
  if (any && (asking || any.agent === "guides")) return { op: "guide", text, capability: any.id };
  return null;
}

const SETTING_WORDS: Record<PortalSettingKey, string> = {
  enabled: "The respondent portal", "show.answers": "Respondents can see the answers they submitted", "show.history": "Respondents can see their earlier attempts",
  "show.scores": "Respondents can see their scores", "show.bands": "Scores are shown with the name of their range", "show.comparison": "Respondents can see how they compare with others",
  "show.trends": "Respondents can see how their results changed over time", "show.insights": "A few sentences about their results", "show.projection": "A range for their next result",
  "show.aiSummary": "A paragraph written by the AI provider, when they ask", "show.rewards": "Respondents can see what they have earned", messages: "Respondents can write to your team",
  editing: "After submitting, answers can be changed", maxAttempts: "Attempts per person", template: "Template", identity: "Identity",
};
export const portalSettingLabel = (k: PortalSettingKey): string => SETTING_WORDS[k];

/** the request in a sentence, for the card's first line and the operations log */
export function describeOpsRequest(r: OpsRequest): string {
  switch (r.op) {
    case "people": {
      const steps = [r.add ? `add the people in the attached file${r.list ? ` to ${r.listIsNew ? "a new list, " : ""}“${r.list}”` : ""}` : "", r.accounts ? `create portal accounts${!r.add ? (r.list ? ` for “${r.list}”` : " for everyone on the live list") : ""}` : "", r.invite ? "send the invitations" : ""].filter(Boolean);
      return `${steps.join(", then ")}.`.replace(/^./, (c) => c.toUpperCase());
    }
    case "settings": return `Change ${r.changes.length} portal setting${r.changes.length === 1 ? "" : "s"}.`;
    case "access": return `${{ suspend: "Pause access", reactivate: "Restore access", lock: "Lock the answers", unlock: "Unlock the answers" }[r.action]} for ${r.list ? `“${r.list}”` : "everyone on the live list"}.`;
    case "status": return "Where the lists and accounts stand.";
    case "guide": return `How to: ${opsCapability(r.capability)?.name ?? r.capability}.`;
    case "capabilities": return "What Intelligent Mode can do with respondents and the portal.";
  }
}
