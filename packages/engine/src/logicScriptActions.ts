import { coerceExpect, type ScriptExpect } from "./scriptVerify.js";
import type { CustomScript, Question, SurveyDefinition } from "@rescript/schema";
import { codeGate, gateReason } from "./codeGate.js";
import { applyScriptEdits, type ScriptEdit } from "./uxActions.js";
import { listPages } from "./blocks.js";

/**
 * SCRIPTS-PANEL (LOGIC) SCRIPTS AS ACTIONS (S2b item 4, 2026-10-30; audit IM-17).
 *
 * Intelligent Mode could read a logic script (S2a's dossier) but not write one: the only script it could write was
 * a behaviour script (create_behavior "script"). These four actions write `def.scripts` — the Scripts panel — and
 * nothing else:
 *
 *   create_logic_script     {name, scope survey|page|question, ref, event, code, enabled?, notes?}
 *   update_logic_script     {script, name?, code? | edits?: [{find, replace}], event?, scope?, ref?, notes?}
 *   remove_logic_script     {script}
 *   set_logic_script_enabled {script, enabled}
 *
 * EVERY CODE CHANGE GOES THROUGH `codeGate(code, "logic")` — the gate the runtime applies before a logic script runs
 * (no constructor / __proto__ / globalThis / Function / eval / network / storage, loops bounded). A script the gate
 * refuses is refused here with its reason; it is never stored to be switched off later. `script` is resolved by the
 * script's name or id; `ref` by question code / variable (question scope) or by a page id or a question on the page
 * (page scope). The event must be one the schema has. Writes a logic script asks for (`set`, `setCalc`,
 * `setEmbedded`, `flag`) are requests the engine decides at run time (S1 `applyScriptWrite`: hidden / calculated /
 * embedded targets from any script; any question the respondent is not looking at; never another question on screen).
 */

export type LogicScriptEvent = CustomScript["event"];
export const LOGIC_SCRIPT_EVENTS: readonly LogicScriptEvent[] = ["on_load", "on_change", "on_submit", "on_validate", "on_complete"];
const EVENT_ALIASES: Record<string, LogicScriptEvent> = { load: "on_load", page: "on_load", page_load: "on_load", change: "on_change", answer: "on_change", submit: "on_submit", next: "on_submit", validate: "on_validate", validation: "on_validate", complete: "on_complete", end: "on_complete" };

export type LogicScriptAction =
  | { op: "create_logic_script"; name: string; scope?: "survey" | "page" | "question"; ref?: string; event?: LogicScriptEvent; code: string; enabled?: boolean; notes?: string; /** S2c: checked in the test session, never stored */ expect?: ScriptExpect }
  | { op: "update_logic_script"; script: string; name?: string; scope?: "survey" | "page" | "question"; ref?: string; event?: LogicScriptEvent; code?: string; edits?: ScriptEdit[]; notes?: string; expect?: ScriptExpect }
  | { op: "remove_logic_script"; script: string }
  | { op: "set_logic_script_enabled"; script: string; enabled: boolean };
export const LOGIC_SCRIPT_ACTION_OPS = ["create_logic_script", "update_logic_script", "remove_logic_script", "set_logic_script_enabled"] as const;

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const eventIn = (v: unknown): LogicScriptEvent | undefined | "bad" => {
  const s = str(v, 40)?.toLowerCase();
  if (!s) return undefined;
  if ((LOGIC_SCRIPT_EVENTS as readonly string[]).includes(s)) return s as LogicScriptEvent;
  return EVENT_ALIASES[s.replace(/^on[_ ]?/, "")] ?? "bad";
};
const scopeIn = (v: unknown) => { const s = str(v, 20)?.toLowerCase(); return s === "survey" || s === "page" || s === "question" ? s : s ? "bad" : undefined; };
const editsIn = (v: unknown): ScriptEdit[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => { const o = (x ?? {}) as Record<string, unknown>; const find = typeof o.find === "string" ? o.find : typeof o.old === "string" ? o.old : undefined; const replace = typeof o.replace === "string" ? o.replace : typeof o.new === "string" ? o.new : undefined; return find !== undefined && replace !== undefined ? { find: find.slice(0, 20000), replace: replace.slice(0, 20000) } : null; }).filter((x): x is ScriptEdit => !!x).slice(0, 20);
};

export function coerceLogicScriptAction(op: string, o: Record<string, unknown>): LogicScriptAction | string {
  const ev = eventIn(o.event ?? o.on);
  if (ev === "bad") return `${op}: the event is one of ${LOGIC_SCRIPT_EVENTS.join(", ")}`;
  const scope = scopeIn(o.scope);
  if (scope === "bad") return `${op}: the scope is survey, page or question`;
  const ref = str(o.ref ?? o.target ?? o.question ?? o.page, 120);
  const code = typeof o.code === "string" ? o.code.slice(0, 20001) : typeof o.script === "string" && op === "create_logic_script" ? o.script.slice(0, 20001) : undefined;
  switch (op) {
    case "create_logic_script": {
      const name = str(o.name ?? o.label, 120);
      if (!name || !code?.trim()) return "create_logic_script needs a name and code";
      return { op, name, code, ...(scope ? { scope } : ref ? { scope: "question" as const } : {}), ...(ref ? { ref } : {}), ...(ev ? { event: ev } : {}), ...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}), ...(str(o.notes, 600) ? { notes: str(o.notes, 600) } : {}), ...(coerceExpect(o.expect) ? { expect: coerceExpect(o.expect) } : {}) };
    }
    case "update_logic_script": {
      const script = str(o.script ?? o.id ?? o.name, 120);
      if (!script) return "update_logic_script needs the script (its name or id)";
      const e = editsIn(o.edits);
      if (Array.isArray(o.edits) && !e?.length) return "update_logic_script edits are [{\"find\":\"text in the script\",\"replace\":\"its replacement\"}]";
      const a: LogicScriptAction = { op, script, ...(str(o.newName ?? (o.script || o.id ? o.name : undefined), 120) ? { name: str(o.newName ?? o.name, 120) } : {}), ...(typeof o.code === "string" ? { code: o.code.slice(0, 20001) } : {}), ...(e?.length ? { edits: e } : {}), ...(ev ? { event: ev } : {}), ...(scope ? { scope } : {}), ...(ref ? { ref } : {}), ...(typeof o.notes === "string" ? { notes: o.notes.slice(0, 600) } : {}), ...(coerceExpect(o.expect) ? { expect: coerceExpect(o.expect) } : {}) };
      if (a.name === script) delete a.name;
      return Object.keys(a).length > 2 ? a : "update_logic_script changes nothing — give code, edits, event, scope/ref, name or notes";
    }
    case "remove_logic_script": { const script = str(o.script ?? o.id ?? o.name, 120); return script ? { op, script } : "remove_logic_script needs the script (its name or id)"; }
    case "set_logic_script_enabled": {
      const script = str(o.script ?? o.id ?? o.name, 120);
      const enabled = typeof o.enabled === "boolean" ? o.enabled : o.enabled === "true" ? true : o.enabled === "false" ? false : undefined;
      return script && enabled !== undefined ? { op, script, enabled } : "set_logic_script_enabled needs the script and enabled true/false";
    }
  }
  return `${op} is not a logic-script action`;
}

class LogicScriptError extends Error {}
const fail = (m: string): never => { throw new LogicScriptError(m); };

export interface LogicScriptEnv { question(ref: string): Question | undefined; ids(prefix: string): string }

function findScript(def: SurveyDefinition, ref: string): CustomScript {
  const list = def.scripts ?? [];
  const r = ref.trim().toLowerCase();
  return list.find((s) => s.id === ref) ?? list.find((s) => s.name.trim().toLowerCase() === r)
    ?? fail(`there is no logic script “${ref}”${list.length ? ` (scripts: ${list.slice(0, 10).map((s) => `“${s.name}”`).join(", ")})` : " — the Scripts panel is empty"}`);
}

/** scope + ref → the stored ref (a question id, a page id) */
function resolveRef(def: SurveyDefinition, env: LogicScriptEnv, scope: CustomScript["scope"], ref: string | undefined): string | undefined {
  if (scope === "survey") return undefined;
  if (!ref) fail(`a ${scope}-scoped script needs "ref" — the ${scope === "question" ? "question (its code)" : "page (its id, or a question on it)"}`);
  if (scope === "question") return (env.question(ref!) ?? fail(`there is no question “${ref}”`)).id;
  const pages = listPages(def.flow as unknown[] as never[]);
  const byId = pages.find((p) => p.node.id === ref);
  if (byId) return byId.node.id;
  const q = env.question(ref!);
  const holding = q ? pages.find((p) => (p.node.questionIds ?? []).includes(q.id)) : undefined;
  return holding?.node.id ?? fail(`there is no page “${ref}” — give the page id or a question on it`);
}

function gate(code: string, name: string): void {
  if (code.length > 20000) fail(`the script “${name}” is longer than 20,000 characters`);
  const v = codeGate(code, "logic");
  if (!v.ok) fail(`the script “${name}” was refused by the logic-script check — ${gateReason(v)}. Logic scripts run in the sandbox with ctx (get, set, getCalc, setCalc, getEmbedded, setEmbedded, expr, pipe, flag, the loop accessors) and nothing else; prefer a punch rule, a calculation or validation where they can say it`);
}

export function applyLogicScriptAction(def: SurveyDefinition, a: LogicScriptAction, env: LogicScriptEnv): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  def.scripts ??= [];
  const where = (s: Pick<CustomScript, "scope" | "ref">) => s.scope === "survey" ? "the survey" : s.scope === "question" ? (def.questions.find((q) => q.id === s.ref)?.code ?? s.ref ?? "?") : `page ${s.ref}`;
  switch (a.op) {
    case "create_logic_script": {
      if (def.scripts.some((s) => s.name.trim().toLowerCase() === a.name.trim().toLowerCase())) fail(`there is already a logic script “${a.name}” — update it (update_logic_script {"script":"${a.name}", "edits"|"code"…}) instead of adding a second one`);
      gate(a.code, a.name);
      const scope = a.scope ?? "survey";
      const s: CustomScript = { id: env.ids("scr"), name: a.name, scope, ...(resolveRef(def, env, scope, a.ref) ? { ref: resolveRef(def, env, scope, a.ref) } : {}), event: a.event ?? "on_load", code: a.code, enabled: a.enabled ?? true, ...(a.notes ? { notes: a.notes } : {}) } as CustomScript;
      def.scripts.push(s);
      return { description: `Add logic script “${s.name}” (${s.event} on ${where(s)}) — checked by the logic-script gate, not run yet`, warnings: [], touched: s.scope === "question" && s.ref ? [s.ref] : [] };
    }
    case "update_logic_script": {
      const s = findScript(def, a.script);
      const changed: string[] = [];
      if (a.code !== undefined && a.edits?.length) fail("give the whole code or edits to it, not both");
      let code = s.code;
      if (a.edits?.length) { code = applyScriptEdits({ label: s.name, script: s.code }, a.edits); changed.push(`${a.edits.length} edit${a.edits.length === 1 ? "" : "s"} to its code`); }
      else if (a.code !== undefined) { code = a.code; changed.push("its code replaced"); }
      if (code !== s.code) { gate(code, s.name); s.code = code; }
      if (a.event && a.event !== s.event) { s.event = a.event; changed.push(`event ${a.event}`); }
      if (a.scope || a.ref) {
        const scope = a.scope ?? s.scope;
        const ref = resolveRef(def, env, scope, a.ref ?? (scope === s.scope ? (s.scope === "question" ? def.questions.find((q) => q.id === s.ref)?.code : s.ref) : undefined));
        if (scope !== s.scope || ref !== s.ref) { s.scope = scope; if (ref) s.ref = ref; else delete s.ref; changed.push(`now on ${where(s)}`); }
      }
      if (a.name && a.name !== s.name) {
        if (def.scripts.some((x) => x !== s && x.name.trim().toLowerCase() === a.name!.trim().toLowerCase())) fail(`there is already a logic script “${a.name}”`);
        changed.push(`renamed “${s.name}” → “${a.name}”`); s.name = a.name;
      }
      if (a.notes !== undefined && a.notes !== s.notes) { s.notes = a.notes; changed.push("notes"); }
      if (!changed.length) fail(`the logic script “${s.name}” is already as asked`);
      return { description: `Change logic script “${s.name}”: ${changed.join(", ")}${code !== undefined && (a.edits?.length || a.code !== undefined) ? " — checked by the logic-script gate, not run yet" : ""}`, warnings: [], touched: [] };
    }
    case "remove_logic_script": {
      const s = findScript(def, a.script);
      def.scripts = def.scripts.filter((x) => x !== s);
      return { description: `Remove logic script “${s.name}”`, destructive: `Removes the logic script “${s.name}” (${s.code.length} characters, ${s.event} on ${where(s)})`, warnings: [], touched: [] };
    }
    case "set_logic_script_enabled": {
      const s = findScript(def, a.script);
      if (s.enabled === a.enabled) fail(`the logic script “${s.name}” is already ${a.enabled ? "on" : "off"}`);
      if (a.enabled) gate(s.code, s.name);
      s.enabled = a.enabled;
      return { description: `${a.enabled ? "Switch on" : "Switch off"} logic script “${s.name}”`, ...(a.enabled ? {} : { destructive: `Switches off the logic script “${s.name}” — what it computes stops being computed` }), warnings: [], touched: [] };
    }
  }
}

export function describeLogicScriptAction(a: LogicScriptAction): string {
  switch (a.op) {
    case "create_logic_script": return `Add logic script “${a.name}”`;
    case "update_logic_script": return `Change logic script “${a.script}”`;
    case "remove_logic_script": return `Remove logic script “${a.script}”`;
    case "set_logic_script_enabled": return `${a.enabled ? "Switch on" : "Switch off"} logic script “${a.script}”`;
  }
}
