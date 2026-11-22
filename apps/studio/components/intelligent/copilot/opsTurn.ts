"use client";
import { OPS_CAPABILITIES, describeOpsRequest, enforcePortalTemplate, opsCapability, portalSettingLabel, portalTemplate, type OpsRequest } from "@rescript/engine";
import { PortalSettings, type SurveyDefinition } from "@rescript/schema";
import { ACCEPTED_FILES_WORDS, listNameFromFile } from "@/lib/peopleIntakeCore";
import { answerColumn, settingNotes, settingValue, settingsAfter, type OpsQuestion } from "@/lib/opsCore";

export { answerColumn, type OpsQuestion };

/**
 * A RESEARCH-OPERATIONS TURN IN INTELLIGENT MODE (2026-11-22). The engine read the sentence into a request
 * (`interpretOpsRequest`); this turns it into a CARD built from the platform's own routes, and — only when the
 * researcher confirms — carries it out through the same routes the screens use:
 *
 *   people     POST /respondents (preview → commit)  then  POST /portal create_accounts { everyone: { list } }
 *   access     POST /portal suspend | reactivate | lock | unlock { everyone: { list } }
 *   settings   the survey's own `portal` block, changed in the editor like any other setting (save + publish)
 *   status     GET /portal — the lists, and how many people have an account
 *   guide      the catalogue's steps, for the things that are deliberately not run from a sentence
 *
 * Nothing here decides who is a duplicate, which column is the email, who gets which account or how a credential
 * leaves the system: the routes do, exactly as they do for the manual screens. Sign-in links for people with no
 * email address are NOT kept on the card (cards are remembered); `runOps` returns them separately, to be shown once.
 */
export interface PeopleFile { name: string; size: number; text?: string; xlsxBase64?: string }
export interface OpsStep { key: "portal_on" | "add" | "accounts" | "access" | "settings"; step: string; why: string; state: "todo" | "done" | "skipped" | "failed"; result?: string }
export interface OpsCard {
  request: OpsRequest;
  status: "preview" | "needs" | "running" | "done" | "failed" | "answered";
  title: string;
  lines: string[];
  plan: OpsStep[];
  columns?: { header: string; target: string; why: string }[];
  questions?: OpsQuestion[];
  problems?: string[];
  problemCount?: number;
  notes?: string[];
  changes?: { key: string; label: string; from: string; to: string; note?: string }[];
  guide?: { name: string; what: string; where: string[]; needs: string[]; steps: string[]; whyGuided?: string; then: string };
  capabilities?: { name: string; agent: "does" | "guides"; say: string }[];
  confirm?: string;
  listName?: string | null;
  fileName?: string;
  /** the server's preview, posted back unchanged on confirm (rows as read, the mapping as shown) */
  intake?: { rows: Record<string, unknown>[]; headers: string[]; mapping: Record<string, string> };
  next?: string;
  /** which screen the "open it" button goes to */
  goTo?: "distribution";
  error?: string;
}
export interface HandOver { id: string; respondentId: string; name: string | null; link?: string; password?: string }
export interface OpsContext {
  surveyId: string;
  def: SurveyDefinition;
  file: PeopleFile | null;
  /** change the survey's portal block in the editor (undoable, saved with the survey) */
  updatePortal(f: (p: PortalSettings) => void): void;
}

const MAX_FILE = 15 * 1024 * 1024;
/** a file of people, read in the browser: text as text, a workbook as base64 for the server's reader */
export async function readPeopleFile(f: File): Promise<PeopleFile> {
  if (!/\.(csv|tsv|txt|xlsx|xlsm)$/i.test(f.name)) throw new Error(`“${f.name}” is not a file of people this can read. Attach ${ACCEPTED_FILES_WORDS}.`);
  if (f.size > MAX_FILE) throw new Error("That file is larger than 15 MB. Split it into smaller files.");
  if (/\.xlsx$|\.xlsm$/i.test(f.name)) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { name: f.name, size: f.size, xlsxBase64: btoa(bin) };
  }
  return { name: f.name, size: f.size, text: await f.text() };
}

type Res = { ok: boolean; status: number; data: any };
async function call(url: string, body?: Record<string, unknown>): Promise<Res> {
  try {
    const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, status: 0, data: { error: (e as Error).message || "the network request failed" } }; }
}
const why = (r: Res, fallback: string) => (r.status === 401 ? "You are not signed in to this project." : r.status === 403 ? "You do not have permission for this on this project. Managing the respondent list needs the deployment permission." : String(r.data?.error ?? `${fallback} (HTTP ${r.status}).`).replace(/^./, (c: string) => c.toUpperCase()));
const ppl = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const FIELD: Record<string, string> = { email: "Email", external_id: "Their ID", name: "Name", embedded: "Extra information" };
const base = (req: OpsRequest): OpsCard => ({ request: req, status: "preview", title: describeOpsRequest(req), lines: [], plan: [] });
const failed = (req: OpsRequest, error: string): { card: OpsCard; said: string } => ({ card: { ...base(req), status: "failed", error }, said: error });

interface PortalState { available: boolean; mail: boolean; canManage: boolean; lists: { name: string | null; people: number; withAccount: number }[] }
async function portalState(surveyId: string): Promise<PortalState | { error: string }> {
  const r = await call(`/api/surveys/${surveyId}/portal?limit=1`);
  if (!r.ok) return { error: why(r, "The respondent list could not be read") };
  return { available: !!r.data?.available, mail: !!r.data?.mail, canManage: !!r.data?.canManage, lists: r.data?.lists ?? [] };
}
const inScope = (st: PortalState, list: string | null | undefined) => (list ? st.lists.filter((l) => l.name === list) : st.lists);
const count = (ls: PortalState["lists"]) => ({ people: ls.reduce((n, l) => n + l.people, 0), withAccount: ls.reduce((n, l) => n + l.withAccount, 0) });

/* ------------------------------------------------------------------ the preview */

export async function opsTurn(req: OpsRequest, ctx: OpsContext, mapping?: Record<string, string>): Promise<{ card: OpsCard; said: string }> {
  switch (req.op) {
    case "guide": return guideCard(req);
    case "capabilities": {
      const card: OpsCard = { ...base(req), status: "answered", capabilities: OPS_CAPABILITIES.map((c) => ({ name: c.name, agent: c.agent, say: c.say })), lines: ["Say what you want in a sentence. What I can carry out, I preview first and do only when you confirm. For the rest I tell you exactly where to go and why."] };
      return { card, said: card.lines[0]! };
    }
    case "status": return statusCard(req, ctx);
    case "settings": return settingsCard(req, ctx);
    case "access": return accessCard(req, ctx);
    case "people": return peopleCard(req, ctx, mapping);
  }
}

function guideCard(req: Extract<OpsRequest, { op: "guide" }>): { card: OpsCard; said: string } {
  const c = opsCapability(req.capability);
  if (!c) return failed(req, "I do not know that function.");
  const card: OpsCard = { ...base(req), status: "answered", title: c.name, lines: [c.what], guide: { name: c.name, what: c.what, where: c.where, needs: c.needs, steps: c.steps, whyGuided: c.whyGuided, then: c.then }, ...(c.where[0] === "Distribution" ? { goTo: "distribution" as const } : {}) };
  return { card, said: `${c.name}: ${c.where.join(" → ")}.` };
}

async function statusCard(req: OpsRequest, ctx: OpsContext): Promise<{ card: OpsCard; said: string }> {
  const st = await portalState(ctx.surveyId);
  if ("error" in st) return failed(req, st.error);
  if (!st.available) return failed(req, "The portal's tables are not on this database yet (migration 0103), so accounts cannot be counted.");
  const all = count(st.lists);
  const lines = st.lists.length
    ? [`${ppl(all.people)} on the live list: ${all.withAccount} with a portal account, ${all.people - all.withAccount} without.`, ...st.lists.map((l) => `${l.name ?? "Added without a list name"}: ${ppl(l.people)}, ${l.withAccount} with an account, ${l.people - l.withAccount} without.`)]
    : ["Nobody is on the live list yet. Attach a file of people (paperclip → People list) and say what to do with it."];
  const waiting = all.people - all.withAccount;
  const card: OpsCard = { ...base(req), status: "answered", lines, notes: [ctx.def.portal?.enabled ? "" : "The respondent portal is off for this survey.", st.mail ? "" : "Email is not set up on this installation, so invitations cannot be emailed."].filter(Boolean), next: waiting ? `Say “create accounts for ${st.lists.length === 1 && st.lists[0]!.name ? st.lists[0]!.name : "everyone"}” to give the ${waiting} without one an account.` : undefined, goTo: "distribution" };
  return { card, said: lines[0]! };
}

/* ---- settings */

async function settingsCard(req: Extract<OpsRequest, { op: "settings" }>, ctx: OpsContext): Promise<{ card: OpsCard; said: string }> {
  const before = ctx.def.portal ?? PortalSettings.parse({ enabled: false });
  const changes = [...req.changes];
  const notes: string[] = [];
  /* the portal must be on for any other setting to mean anything: said, and added to what will change */
  if (!before.enabled && !changes.some((c) => c.key === "enabled")) { changes.unshift({ key: "enabled", value: true }); notes.push("The portal is off for this survey, so turning it on is included: nothing else applies while it is off."); }
  const after = settingsAfter(before, changes);
  const enforced = enforcePortalTemplate(after);
  const rows = changes.map((c) => {
    const from = settingValue(before, c.key), to = settingValue(after, c.key), real = settingValue(enforced, c.key);
    return { key: c.key, label: portalSettingLabel(c.key), from, to, ...(real !== to ? { note: `The ${portalTemplate(after.template)?.name ?? "current"} template always keeps this ${real}, whatever is set here.` } : {}) };
  });
  notes.push(...settingNotes(after, { scoredTest: !!ctx.def.assessment?.enabled }));
  const same = rows.every((r) => r.from === r.to);
  const card: OpsCard = { ...base(req), status: same ? "answered" : "preview", title: same ? "Already set that way" : describeOpsRequest({ ...req, changes }), lines: same ? ["Nothing would change: the portal is already set this way."] : ["Nothing is changed until you confirm. These are settings of the survey: they take effect for respondents once you save and publish."],
    changes: rows, notes, plan: same ? [] : [{ key: "settings", step: "Change the portal settings in the survey", why: "they are part of the survey, so they are versioned and can be undone like any other edit", state: "todo" }],
    confirm: same ? undefined : `Apply ${rows.length} setting${rows.length === 1 ? "" : "s"}`, goTo: "distribution" };
  (card.request as Extract<OpsRequest, { op: "settings" }>).changes = changes;
  return { card, said: same ? card.lines[0]! : `${rows.map((r) => `${r.label}: ${r.from} → ${r.to}`).join("; ")}.` };
}

/* ---- pause / restore / lock / unlock */

async function accessCard(req: Extract<OpsRequest, { op: "access" }>, ctx: OpsContext): Promise<{ card: OpsCard; said: string }> {
  const st = await portalState(ctx.surveyId);
  if ("error" in st) return failed(req, st.error);
  if (!st.available) return failed(req, "The portal's tables are not on this database yet (migration 0103).");
  if (!st.canManage) return failed(req, "You can see this list but not change it. Changing access needs the deployment permission on this project.");
  const n = count(inScope(st, req.list)).people;
  if (!n) return failed(req, req.list ? `There is nobody on “${req.list}”.` : "Nobody is on the live list yet.");
  const verb = { suspend: "Pause access to this survey", reactivate: "Restore access to this survey", lock: "Lock the submitted answers", unlock: "Unlock the submitted answers" }[req.action];
  const reason = { suspend: "a paused person cannot open this assessment in their portal until restored; their account and answers stay", reactivate: "they can open the assessment again at once", lock: "a locked person can no longer change what they submitted", unlock: "answers follow the survey's editing rule again" }[req.action];
  const card: OpsCard = { ...base(req), lines: [`${verb} for ${ppl(n)} ${req.list ? `on “${req.list}”` : "on the live list"}. It applies immediately and can be reversed.`], plan: [{ key: "access", step: `${verb} for ${ppl(n)}`, why: reason, state: "todo" }], confirm: `${verb.split(" ")[0]} for ${ppl(n)}`, listName: req.list, goTo: "distribution" };
  return { card, said: card.lines[0]! };
}

/* ---- people: file → list → accounts → invitations */

async function peopleCard(req: Extract<OpsRequest, { op: "people" }>, ctx: OpsContext, mapping?: Record<string, string>): Promise<{ card: OpsCard; said: string }> {
  const card = base(req);
  card.goTo = "distribution";
  if (req.missingFile || (req.add && !ctx.file)) {
    return { card: { ...card, status: "needs", lines: ["I understood, but there is no file of people attached. Press the paperclip, choose People list, pick your Excel or CSV file, then say this again.", `It reads ${ACCEPTED_FILES_WORDS}. The columns can be called anything: I read which is the email, the name and the ID from the file itself and show you before anything is added.`] }, said: "Attach the file of people first (paperclip → People list)." };
  }
  if (req.accounts && req.environment === "TEST") return failed(req, "Portal accounts are for the live list. People on the test list are for rehearsing links; say it without “test” to use the live list.");
  const st = await portalState(ctx.surveyId);
  if ("error" in st) return failed(req, st.error);
  if (!st.canManage) return failed(req, "You can see this project's respondents but not change them. Adding people and creating accounts needs the deployment permission.");
  if (req.accounts && !st.available) return failed(req, "The portal's tables are not on this database yet (migration 0103), so accounts cannot be created. An administrator applies the migration once.");

  const notes: string[] = [];
  const plan: OpsStep[] = [];
  let toAdd = 0;
  let listName: string | null = req.list;

  if (req.add && ctx.file) {
    listName = req.list ?? listNameFromFile(ctx.file.name);
    const r = await call(`/api/surveys/${ctx.surveyId}/respondents`, { stage: "preview", environment: req.environment, listName, ...(ctx.file.xlsxBase64 ? { xlsxBase64: ctx.file.xlsxBase64 } : { text: ctx.file.text ?? "" }), ...(mapping ? { mapping } : {}) });
    if (!r.ok) return failed(req, why(r, "The file could not be read"));
    const p = r.data;
    const onList = Number(p.alreadyOnList?.count ?? 0);
    toAdd = Math.max(0, Number(p.summary?.people ?? 0) - onList);
    const map = p.mapping as Record<string, string>;
    const reading: { header: string; target: string; why: string }[] = p.reading?.columns ?? [];
    card.fileName = ctx.file.name;
    card.intake = { rows: p.rows, headers: p.headers, mapping: map };
    /* each column as it will be used; the reason comes from the reader unless the researcher re-mapped it */
    card.columns = (p.headers as string[]).filter(Boolean).map((h) => ({ header: h, target: FIELD[map[h] ?? "embedded"]!, why: reading.find((c) => c.header === h && c.target === (map[h] ?? "embedded"))?.why ?? "as you set it" }));
    /* a question stays open until its answer is the mapping; once the researcher chose, it shows the choice */
    card.questions = ((p.reading?.questions ?? []) as OpsQuestion[]).map((q) => ({ ...q, chosen: Object.keys(map).find((h) => map[h] === q.field && q.options.includes(h)) ?? null }));
    card.problems = ((p.problems ?? []) as { message: string }[]).slice(0, 8).map((x) => x.message);
    card.problemCount = (p.problems ?? []).length;
    card.lines.push(`I read ${p.summary.read} row${p.summary.read === 1 ? "" : "s"} from ${ctx.file.name}${p.sheetName && (p.sheetNames?.length ?? 0) > 1 ? ` (sheet “${p.sheetName}” of ${p.sheetNames.length})` : ""}: ${ppl(toAdd)} to add to ${req.environment === "TEST" ? "the test list" : "the live list"}, as “${listName}”${st.lists.some((l) => l.name === listName) ? " (an existing list)" : " (a new list)"}.`);
    const left = [p.summary.duplicatesInFile ? `${p.summary.duplicatesInFile} repeated in the file` : "", onList ? `${onList} already on this survey's list` : "", p.summary.dropped ? `${p.summary.dropped} row${p.summary.dropped === 1 ? "" : "s"} with nobody in` : ""].filter(Boolean);
    if (left.length) card.lines.push(`Left out: ${left.join(", ")}.`);
    if (p.summary.invalidEmails) notes.push(`${p.summary.invalidEmails} email address${p.summary.invalidEmails === 1 ? " looks" : "es look"} wrong. Those people are still added; an invitation cannot be emailed to them. Fix the file and attach it again to avoid that.`);
    if (p.blocking) return { card: { ...card, status: "failed", notes, error: String(p.blocking).replace(/^./, (c: string) => c.toUpperCase()) + "." }, said: "There is nobody to add in that file." };
    if (!Object.values(map).some((t) => t === "email" || t === "external_id")) notes.push("No column is an email address or an ID, so these people could not be told apart or emailed. Answer the question below first.");
    const access = ctx.def.deployment?.access?.mode;
    if (access && access !== "unique_links" && access !== "invitation" && !req.accounts) notes.push("This survey's access mode is open, so anyone with the survey link can take it and this list is not consulted. Set the access mode to unique links or invitation in Survey Settings to use personal links.");
    plan.push({ key: "add", step: `Add ${ppl(toAdd)} to “${listName}”`, why: "the list is who you can give accounts and links to; people already on it are left out so nobody gets a second link", state: "todo" });
  }

  if (req.accounts) {
    if (!ctx.def.portal?.enabled) {
      plan.unshift({ key: "portal_on", step: "Turn the respondent portal on for this survey", why: "accounts belong to the portal; the switch is part of the survey, so respondents see it once you save and publish", state: "todo" });
      notes.push("The respondent portal is off for this survey. I will turn it on as the first step; you still need to save and publish.");
    }
    const scope = count(inScope(st, req.add ? listName : req.list));
    const waiting = (req.add ? toAdd : 0) + (scope.people - scope.withAccount);
    if (!req.add) {
      if (req.list && !st.lists.some((l) => l.name === req.list)) return failed(req, `There is no list called “${req.list}”. Your lists: ${st.lists.map((l) => l.name ?? "(no name)").join(", ") || "none yet"}.`);
      if (!scope.people) return failed(req, "Nobody is on the live list yet. Attach a file of people (paperclip → People list) and say what to do with it.");
      card.lines.push(`${req.list ? `“${req.list}”` : "The live list"} has ${ppl(scope.people)}: ${scope.withAccount} with a portal account, ${scope.people - scope.withAccount} without.`);
      if (!waiting) return { card: { ...card, status: "answered", lines: [...card.lines, "Everyone there already has an account, so there is nothing to create. To send an invitation again, tick the people in Distribution → Respondent portal and press Send the invitation again."], notes }, said: "Everyone there already has an account." };
    }
    plan.push({ key: "accounts", step: `Create portal accounts for ${ppl(waiting)}${req.invite ? " and send their invitations" : ""}`, why: "one account per person, joined by email address; a person who already has an account from another survey keeps it and gains this one", state: "todo" });
    if (req.invite) {
      notes.push(st.mail
        ? "A person with an email address is emailed a link to set their own password; you never see it. A person with no address gets a link shown to you once, to hand over."
        : "Email is not set up on this installation: accounts will be created, but nobody with an email address can be sent an invitation yet. A person with no address gets a link shown to you once, to hand over.");
    } else notes.push("No invitation is sent. Say “send the invitations” when you want them to go.");
  }

  if (!plan.length) return failed(req, "There is nothing to do in that request.");
  const open = (card.questions ?? []).filter((q) => q.chosen === null);
  const verbs = [req.add ? `add ${ppl(toAdd)}` : "", req.accounts ? "create accounts" : "", req.invite ? "send invitations" : ""].filter(Boolean).join(", ");
  const out: OpsCard = { ...card, status: open.length ? "needs" : "preview", plan, notes, listName, confirm: open.length || (req.add && !toAdd && !req.accounts) ? undefined : `Confirm: ${verbs}` };
  if (req.add && !toAdd) out.lines.push("Nobody in the file is new to this list.");
  return { card: out, said: out.lines[0] ?? out.title };
}

/* ------------------------------------------------------------------ carrying it out */

export async function runOps(card: OpsCard, ctx: OpsContext): Promise<{ card: OpsCard; said: string; handOver: HandOver[] }> {
  const req = card.request;
  const plan = card.plan.map((p) => ({ ...p }));
  const handOver: HandOver[] = [];
  const set = (key: OpsStep["key"], state: OpsStep["state"], result?: string) => { const p = plan.find((x) => x.key === key); if (p) { p.state = state; if (result) p.result = result; } };
  const stop = (key: OpsStep["key"], error: string) => { set(key, "failed", error); for (const p of plan) if (p.state === "todo") p.state = "skipped"; return { card: { ...card, status: "failed" as const, plan, error, confirm: undefined }, said: error, handOver }; };
  const lines: string[] = [];

  if (req.op === "settings") {
      const next = settingsAfter(ctx.def.portal, req.changes);
    ctx.updatePortal((p) => { Object.assign(p, next); if (!next.template) delete p.template; if (!next.maxAttempts) delete p.maxAttempts; });
    set("settings", "done", `${req.changes.length} setting${req.changes.length === 1 ? "" : "s"} changed in the survey`);
    return { card: { ...card, status: "done", plan, confirm: undefined, lines: [`Changed: ${(card.changes ?? []).map((c) => `${c.label} (${c.to})`).join("; ")}.`], next: "Save and publish the survey: respondents get the settings of the published version. Undo reverses this like any other edit." }, said: "The portal settings are changed in the survey. Save and publish for them to take effect.", handOver };
  }

  if (req.op === "access") {
    /* one request covers up to 2,000 people; this action marks nobody as done, so a second page would be the same people */
    const r = await call(`/api/surveys/${ctx.surveyId}/portal`, { action: req.action, everyone: { ...(req.list ? { list: req.list } : {}), noAccount: false } });
    if (!r.ok) return stop("access", why(r, "That did not work"));
    const changed = Number(r.data?.changed ?? 0);
    if (Number(r.data?.more ?? 0) > 0) lines.push(`${r.data.more} more people are on this list than one request covers (2,000). Use Distribution → Respondent portal for the rest.`);
    set("access", "done", `${ppl(changed)} updated`);
    const word = { suspend: "paused", reactivate: "restored", lock: "locked", unlock: "unlocked" }[req.action];
    return { card: { ...card, status: "done", plan, confirm: undefined, lines: [`Done: ${ppl(changed)} ${word}.`, ...lines], next: req.action === "suspend" ? `Say “restore access for ${req.list ?? "everyone"}” to undo it.` : req.action === "lock" ? `Say “unlock the answers for ${req.list ?? "everyone"}” to undo it.` : undefined }, said: `${ppl(changed)} ${word}.`, handOver };
  }

  if (req.op !== "people") return { card, said: "", handOver };
  const listName = card.listName ?? null;

  if (plan.some((p) => p.key === "portal_on")) {
    ctx.updatePortal((p) => { p.enabled = true; });
    set("portal_on", "done", "on in the survey; save and publish for respondents to see it");
  }

  let inserted = 0;
  if (plan.some((p) => p.key === "add")) {
    if (!card.intake) return stop("add", "The file's preview is no longer here. Attach the file and ask again.");
    const r = await call(`/api/surveys/${ctx.surveyId}/respondents`, { stage: "commit", environment: req.environment, listName, rows: card.intake.rows, headers: card.intake.headers, mapping: card.intake.mapping, skipExisting: true });
    if (!r.ok) return stop("add", `${why(r, "The people could not be added")} Nothing was added.`);
    inserted = Number(r.data?.inserted ?? 0);
    const leftOut = Number(r.data?.alreadyOnTheListCount ?? 0);
    set("add", "done", `${ppl(inserted)} added to “${r.data?.listName ?? listName}”${leftOut ? `; ${leftOut} already on the list left as ${leftOut === 1 ? "it was" : "they were"}` : ""}`);
    lines.push(`Added ${ppl(inserted)} to “${r.data?.listName ?? listName}”.${leftOut ? ` ${leftOut} already on the list ${leftOut === 1 ? "was" : "were"} left out.` : ""}`);
  }

  if (plan.some((p) => p.key === "accounts")) {
    let created = 0, linked = 0, emailed = 0, more = 0;
    const skipped = new Map<string, number>();
    for (let i = 0; i < 25; i++) {
      const scopeList = req.add ? listName : req.list;
      const r = await call(`/api/surveys/${ctx.surveyId}/portal`, { action: "create_accounts", identity: ctx.def.portal?.identity ?? "persistent", sendEmail: req.invite, everyone: { ...(scopeList ? { list: scopeList } : {}), noAccount: true } });
      /* nobody left without an account is the end of the work, not a failure */
      if (r.status === 404) break;
      if (!r.ok) return stop("accounts", `${why(r, "The accounts could not be created")}${inserted ? ` The ${ppl(inserted)} added above are on the list.` : ""}`);
      const made = Number(r.data?.created ?? 0) + Number(r.data?.linked ?? 0);
      created += Number(r.data?.created ?? 0); linked += Number(r.data?.linked ?? 0); emailed += Number(r.data?.emailed ?? 0);
      for (const s of (r.data?.skipped ?? []) as { why: string }[]) skipped.set(s.why, (skipped.get(s.why) ?? 0) + 1);
      for (const h of (r.data?.handOver ?? []) as HandOver[]) handOver.push(h);
      more = Number(r.data?.more ?? 0);
      /* stop when everyone is done, or when a pass made no progress (the rest are being skipped for a stated reason) */
      if (!more || !made) break;
    }
    const total = created + linked;
    const rejected = [...skipped.entries()].map(([w, n]) => `${n}: ${w.replace(/[.\s]+$/, "")}`);
    set("accounts", "done", `${total} account${total === 1 ? "" : "s"}${linked ? ` (${linked} joined an account the person already had)` : ""}${req.invite ? `; ${emailed} invitation${emailed === 1 ? "" : "s"} emailed${handOver.length ? `, ${handOver.length} link${handOver.length === 1 ? "" : "s"} to hand over` : ""}` : ""}`);
    lines.push(`Created ${created} account${created === 1 ? "" : "s"}${linked ? `, and ${linked} ${linked === 1 ? "person" : "people"} joined an account they already had` : ""}.`);
    if (req.invite) lines.push(`${emailed} invitation${emailed === 1 ? "" : "s"} emailed${handOver.length ? `; ${handOver.length} ${handOver.length === 1 ? "person has" : "people have"} no email address, and ${handOver.length === 1 ? "their link is" : "their links are"} below, shown once` : ""}.`);
    if (rejected.length) lines.push(`Not done — ${rejected.join("; ")}.`);
    if (more) lines.push(`${more} more people are still without an account. Say it again to continue.`);
  }

  const portalOn = plan.some((p) => p.key === "portal_on");
  const next = portalOn ? "Save and publish the survey, so the portal is on for respondents when they sign in."
    : req.accounts && !req.invite ? "Say “send the invitations” when you want people to be told."
    : req.accounts ? "People set their password from the invitation. Watch who has signed in under Distribution → Respondent portal."
    : `Say “create accounts for ${listName ?? "everyone"} and send the invitations”, or download their links in Distribution → Your lists.`;
  /* what was said about the future is now in the steps' results */
  const notes = (card.notes ?? []).filter((n) => !/^The respondent portal is off|^No invitation is sent/.test(n));
  return { card: { ...card, status: "done", plan, confirm: undefined, intake: undefined, questions: undefined, lines, notes, next }, said: lines.join(" "), handOver };
}
