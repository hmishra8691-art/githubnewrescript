"use client";
/**
 * S2c — THE TEST SESSION: every code item of a proposal is RUN before the proposal is offered as ready.
 *
 * Browser-side, in the Studio's own page, with the respondent's real components — no jsdom, no copy of the runtime:
 *   · the page that hosts the item is drawn off-screen with the real `QuestionRenderer`s inside a survey shell, and
 *     the real `UxLayer` (its sandboxed frames, mirror DOM, write channel and lifecycle) on top;
 *   · a Scripts-panel (logic) script runs in the real `LogicFrameHost` (the same frame and shim the Runner uses);
 *   · writes go through the engine's `applyScriptWrite` with the same scope the Runner gives them, and every accepted
 *     value is checked in the state AND in the save payload the Runner would post (`responseSavePayload`);
 *   · Next runs the page's built-in validation (`validatePage`), the scripts' `validate` handlers (bounded, as the
 *     Runner does) and a logic script's on_validate / on_submit / on_complete.
 *
 * Test mode only: the state is in memory, nothing is posted, no store is touched, and the real draft is never
 * changed — the harness renders the proposal's clone. Limits: 5 s per item, 20 s per proposal.
 *
 * The scenarios and the verdicts are the engine's (`scriptVerify.ts`): this file only runs and records.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SurveyDefinition, UxTarget, Question } from "@rescript/schema";
import {
  createResponseState, setAnswer, applyScriptWrite, validatePage, withComponentBehaviors, prepareLogicScripts, logicSnapshot,
  logicStatics, logicScriptScope, buildScenarios, fillAnswers, hostPage, itemVerdict, savedWriteProblems, codeItemsSignature,
  type ResponseState, type ScriptWrite, type VerifyItem, type ItemRecord, type ScenarioRecord, type ObservedEffect, type VerificationReport,
  type Scenario, type CheckedWrite, type HostPage,
} from "@rescript/engine";
import { QuestionRenderer, UxLayer, LogicFrameHost, brandingVars, widthModeClass, brandingClasses, type UxTrace, type UxAskFrames, type UxScriptIssue } from "@rescript/renderer";

export const ITEM_LIMIT_MS = 5000;
export const PROPOSAL_LIMIT_MS = 20000;
/** how long a frame gets to start, and to react to one step */
const READY_MS = 1500;
const SETTLE_MS = 160;
const LIFECYCLE_MS = 1500;
const LOGIC_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ENDLESS = /so the script was stopped \(is it endless\?\)/;

interface StageApi { set(values: Record<string, unknown>): void; ask: React.MutableRefObject<UxAskFrames | null> }

/** one page of the survey as the Runner draws it, with the UX layer and a controller the harness drives */
function Stage({ def, page, state, pageKey, apiRef, onTrace, onIssue, onWrite, onLog }: {
  def: SurveyDefinition; page: HostPage; state: ResponseState; pageKey: string;
  apiRef: React.MutableRefObject<StageApi | null>;
  onTrace(t: UxTrace): void; onIssue(i: UxScriptIssue): void; onLog(line: string): void;
  onWrite(w: ScriptWrite, script: { id: string; label: string; target: UxTarget }): { ok: boolean; reason?: string };
}) {
  const [values, setValues] = React.useState<Record<string, unknown>>(() => Object.fromEntries(page.questionIds.map((id) => [id, state.answers[id]])));
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const ask = React.useRef<UxAskFrames | null>(null);
  apiRef.current = { set: (v) => setValues((x) => ({ ...x, ...v })), ask };
  const questions = page.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
  const b = def.branding;
  const allValues = { ...(state.answers as Record<string, unknown>), ...values };
  return (
    <div ref={shellRef} className={`rs-shell rs-${b.layout.cardStyle} ${widthModeClass(b)} ${brandingClasses(b)}`} style={{ ...(brandingVars(b) as React.CSSProperties), transform: "translateZ(0)" }}
      data-rs-ux={def.meta.id} data-rs-block={page.blockId} data-rs-page={page.pageId} data-rs-verify="">
      <UxLayer contained def={def} rootRef={shellRef} values={values} allValues={allValues} state={state} shown={page.questionIds} pageKey={pageKey} blockId={page.blockId} pageId={page.pageId} pageIndex={1}
        onTrace={onTrace} onScriptIssue={onIssue} onScriptWrite={onWrite} onLog={onLog} lifecycleRef={ask} onNavigate={(target) => ({ ok: true, reason: `test session: would go to ${target}` })} />
      <div id="rs-questions">
        {questions.map((q) => (
          <QuestionRenderer key={q.id} def={def} q={q} state={state} loop={null} value={values[q.id]} errors={[]}
            onChange={(v) => { setAnswer(def, state, q.id, v); setValues((x) => ({ ...x, [q.id]: v })); }} onOtherChange={() => {}} />
        ))}
      </div>
      <div className="rs-nav">
        <button type="button" className={`rs-btn secondary ${b.buttons.style}`} data-rs-button="back" data-testid="rs-back">{b.buttons.backLabel}</button>
        <button type="button" className={`rs-btn ${b.buttons.style}`} data-rs-button="next" data-testid="rs-next">{b.buttons.nextLabel}</button>
      </div>
    </div>
  );
}

/** the definition one item runs in: its own script is the only script on the page (others would blur what it did) */
function stageDef(def: SurveyDefinition, item: VerifyItem): SurveyDefinition {
  const base = item.kind === "component" ? withComponentBehaviors(def) : def;
  const ux = base.ux ?? { styles: [], animations: [], behaviors: [] };
  const keep = (id: string, script?: string) => !script || (item.kind === "behaviour" && id === item.id) || (item.kind === "component" && id.endsWith(item.id.replace(/[^\w-]/g, "_")) && id.startsWith("uxb_component_"));
  return { ...base, ux: { ...ux, behaviors: ux.behaviors.filter((x) => keep(x.id, x.script)) } };
}

const codeOf = (def: SurveyDefinition, id: string | undefined | null) => (id ? String(def.questions.find((q) => q.id === id)?.code ?? id) : "");
function targetLabel(def: SurveyDefinition, t: UxTarget): string {
  if (t.questionId) return codeOf(def, t.questionId) + (t.code != null ? ` ${t.kind} ${t.code}` : "");
  if (t.kind === "page" && t.pageId) return `page ${t.pageId}`;
  return t.kind;
}
function elementLabel(def: SurveyDefinition, el: Element | null): string {
  if (!el) return "the page";
  const q = el.closest("[data-qid]");
  if (q) return codeOf(def, q.getAttribute("data-qid"));
  if (el.closest('[data-rs-button="next"]')) return "Next";
  if (el.closest('[data-rs-button="back"]')) return "Back";
  return "the page";
}
const EFFECT_KIND: Record<string, string> = { show_message: "message", show_popup: "popup", set_style: "style" };

/** a value typed into a box the way a browser does it (React's own setter, then input + change), so DOM listeners hear it */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
/**
 * PLAY AN ANSWER AS A RESPONDENT GIVES IT: a click on the option, typing into the box — so a script that listens to
 * the page's own DOM events (forwarded to its mirror) hears exactly what it would hear in the survey. Returns false
 * when the page has no such control (a clear of a single choice, a widget without a plain input): the caller sets it.
 */
function drive(holder: HTMLElement, qid: string, value: unknown): boolean {
  const card = holder.querySelector<HTMLElement>(`[data-qid="${CSS.escape(qid)}"]`);
  if (!card) return false;
  const choices = card.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
  const box = card.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])');
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) {
    if (box && !choices.length) { typeInto(box, ""); return true; }
    return false;
  }
  if (choices.length) {
    const codes = Array.isArray(value) ? value : [value];
    let n = 0;
    for (const c of codes) { const i = card.querySelector<HTMLInputElement>(`input[value="${CSS.escape(String(c))}"]`); if (i && !i.disabled) { if (!i.checked) i.click(); n++; } }
    return n === codes.length;
  }
  if (box && (typeof value === "string" || typeof value === "number")) { typeInto(box, String(value)); return true; }
  return false;
}

/** run one logic script once (the Runner's runLogicEvent, for exactly this script) */
async function runLogicOnce(def: SurveyDefinition, state: ResponseState, item: VerifyItem, host: LogicFrameHost, page: HostPage, rec: ScenarioRecord, writes: CheckedWrite[], ir: ItemRecord, value?: unknown): Promise<{ errors: { message: string; questionRef?: string }[] }> {
  const prep = prepareLogicScripts(def, state, (item.event ?? "on_load") as never, { ids: [item.id] });
  if (prep.refused.length) { ir.gateRefusal = prep.refused[0]!.reason; return { errors: [] }; }
  if (!prep.scripts.length) return { errors: [] };
  const snap = logicSnapshot(def, state, null, prep.scripts.map((s) => s.body), value);
  let res: Awaited<ReturnType<LogicFrameHost["run"]>>;
  try { res = await host.run({ scripts: prep.scripts, snap }, LOGIC_MS); } catch { res = null; }
  if (res === "closed") return { errors: [] };
  if (!res) { ir.watchdog.push(`${item.event}: no answer within ${LOGIC_MS} ms — not run, nothing written`); return { errors: [] }; }
  ir.ran = true;
  const r = res[0];
  if (!r) return { errors: [] };
  rec.logs.push(...(r.logs ?? []).map((l) => String(l).slice(0, 300)));
  if (r.failed) { if (ENDLESS.test(r.failed)) ir.watchdog.push(r.failed); else rec.errors.push({ message: r.failed }); }
  const script = prep.scripts[0]!;
  for (const w of r.writes ?? []) {
    const res2 = applyScriptWrite(def, state, w, { scriptId: script.id, scope: logicScriptScope(script), shown: page.questionIds, loop: null, pageQuestions: page.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q), quotaCounts: {} });
    noteWrite(def, state, w, res2, rec, writes);
  }
  for (const e of r.errors ?? []) rec.effects.push({ kind: "validation", target: e.questionRef ? codeOf(def, def.questions.find((q) => q.id === e.questionRef || String(q.code) === e.questionRef || q.variableName === e.questionRef)?.id ?? e.questionRef) : "the page", detail: e.message });
  return { errors: r.errors ?? [] };
}

const callOf = (w: ScriptWrite) => w.kind === "answer" ? `setAnswer("${w.ref}")` : w.kind === "calculated" ? `setCalc("${w.name}")` : w.kind === "embedded" ? `setEmbedded("${w.name}")` : `flag("${w.name}")`;
function noteWrite(def: SurveyDefinition, state: ResponseState, w: ScriptWrite, r: { ok: boolean; reason?: string; target?: string }, rec: ScenarioRecord, writes: CheckedWrite[]) {
  if (!r.ok) { rec.writes.push({ call: callOf(w), ok: false, reason: r.reason ?? "not allowed" }); return; }
  const target = r.target ?? (w.kind === "answer" ? w.ref : w.name);
  const value = w.kind === "answer" ? state.answers[target] : w.kind === "embedded" ? state.embedded[target] : w.kind === "calculated" ? state.calculated[target] : true;
  rec.writes.push({ call: callOf(w), target, ok: true, value });
  writes.push({ kind: w.kind, target, value });
  const label = w.kind === "answer" ? codeOf(def, target.split("@")[0]) : target;
  rec.effects.push({ kind: "write", target: label, detail: JSON.stringify(value ?? null).slice(0, 40) });
}

export interface HarnessOptions { seed?: number; itemMs?: number; totalMs?: number; onItem?: (done: number, total: number) => void }

/**
 * RUN EVERY CODE ITEM of a proposal in a test session. Never throws: whatever goes wrong in the harness itself is the
 * item's `notRun` reason, so the card can say "could not be run here: …".
 */
export async function runVerification(def: SurveyDefinition, items: VerifyItem[], opts: HarnessOptions = {}): Promise<VerificationReport> {
  const t0 = Date.now();
  const itemMs = opts.itemMs ?? ITEM_LIMIT_MS, totalMs = opts.totalMs ?? PROPOSAL_LIMIT_MS;
  const records: ItemRecord[] = [];
  let truncated = false;
  const box = document.createElement("div");
  box.setAttribute("data-testid", "cp-verify-stage");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position:fixed;left:-12000px;top:0;width:820px;height:900px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(box);
  try {
    for (const item of items) {
      if (Date.now() - t0 > totalMs) { truncated = true; records.push({ key: item.key, kind: item.kind, label: item.label, ran: false, notRun: `the test session's limit for one proposal (${totalMs / 1000} s) was reached before it`, hostRefusals: [], watchdog: [], timedOut: false, scenarios: [], durationMs: 0 }); continue; }
      try { records.push(await runItem(def, item, box, Math.min(itemMs, totalMs - (Date.now() - t0)), opts.seed ?? 1)); }
      catch (e) { records.push({ key: item.key, kind: item.kind, label: item.label, ran: false, notRun: `the test session failed: ${e instanceof Error ? e.message : String(e)}`, hostRefusals: [], watchdog: [], timedOut: false, scenarios: [], durationMs: 0 }); }
      opts.onItem?.(records.length, items.length);
    }
  } finally { box.remove(); }
  return { signature: codeItemsSignature(items), at: new Date().toISOString(), durationMs: Date.now() - t0, items: records, verdicts: records.map((r) => itemVerdict(r, items.find((i) => i.key === r.key)?.expect)), ...(truncated ? { truncated } : {}) };
}

async function runItem(def0: SurveyDefinition, item: VerifyItem, box: HTMLElement, limitMs: number, seed: number): Promise<ItemRecord> {
  const t0 = Date.now();
  const ir: ItemRecord = { key: item.key, kind: item.kind, label: item.label, ran: false, hostRefusals: [], watchdog: [], timedOut: false, scenarios: [], durationMs: 0 };
  const page = hostPage(def0, item);
  if (!page) { ir.notRun = "no page of the survey shows it"; return ir; }
  const def = stageDef(def0, item);
  const scenarios: Scenario[] = buildScenarios(def0, item, { seed });
  const scriptId = item.kind === "component" ? `uxb_component_${item.id.replace(/[^\w-]/g, "_")}` : item.id;
  const over = () => Date.now() - t0 > limitMs;
  /* a pause that took far longer than asked: the page's thread was blocked (a frame sharing it, looping) — the script did not finish */
  const settle = async (ms = SETTLE_MS) => { const t = Date.now(); await sleep(ms); if (Date.now() - t > ms + 2000) ir.timedOut = true; };
  const allWrites: { state: ResponseState; writes: CheckedWrite[] }[] = [];
  for (const [si, sc] of scenarios.entries()) {
    /* the item's budget ran out between scenarios: what was played stands; the rest is said, not blamed on the script */
    if (over()) { ir.unplayed = scenarios.length - si; break; }
    const rec: ScenarioRecord = { id: sc.id, label: sc.label, errors: [], effects: [], writes: [], logs: [] };
    ir.scenarios.push(rec);
    const state = createResponseState(def, { seed: 1, sessionId: "verify" });
    const writes: CheckedWrite[] = [];
    allWrites.push({ state, writes });
    const apiRef: React.MutableRefObject<StageApi | null> = { current: null };
    let ready = item.kind === "logic";
    const onTrace = (t: UxTrace) => {
      if (t.script !== scriptId) return;
      if (t.kind === "ready") { ready = true; ir.ran = true; return; }
      if (t.kind === "effect") { if (t.count > 0) rec.effects.push({ kind: EFFECT_KIND[t.op] ?? t.op, target: targetLabel(def, t.target), ...(t.detail ? { detail: t.detail.slice(0, 60) } : {}) }); return; }
      if (t.kind === "dom") { rec.effects.push({ kind: t.op === "create" ? "create" : `dom_${t.op}`, target: elementLabel(def, t.el) }); return; }
      if (t.kind === "refused") { ir.hostRefusals.push(`${t.text} (on “${sc.label}”)`.slice(0, 300)); return; }
      if (t.kind === "error") { if (ENDLESS.test(t.text)) ir.watchdog.push(t.text); else rec.errors.push({ message: t.text.slice(0, 300), ...(t.line ? { line: t.line } : {}) }); return; }
      if (t.kind === "log") rec.logs.push(t.text.slice(0, 300));
    };
    const onIssue = (i: UxScriptIssue) => {
      if (i.script !== scriptId) return;
      if (i.kind === "gate_refused" || i.kind === "component_not_run") ir.gateRefusal = i.message.replace(/^not run: /, "");
      else if (i.kind === "watchdog") ir.watchdog.push(i.message);
    };
    const onWrite = (w: ScriptWrite, script: { id: string; target: UxTarget }) => {
      const t = script.target;
      const scope = t.questionId ? { kind: "question" as const, questionId: t.questionId } : t.pageId ? { kind: "page" as const, pageId: t.pageId } : t.blockId ? { kind: "block" as const, blockId: t.blockId } : { kind: "survey" as const };
      const r = applyScriptWrite(def, state, w, { scriptId: script.id, scope, shown: page.questionIds, loop: null, pageQuestions: page.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q), quotaCounts: {} });
      if (script.id === scriptId) noteWrite(def, state, w, r, rec, writes);
      if (r.ok && w.kind === "answer") apiRef.current?.set(Object.fromEntries(page.questionIds.map((id) => [id, state.answers[id]])));
      return r;
    };
    const holder = document.createElement("div");
    box.appendChild(holder);
    const root: Root = createRoot(holder);
    const logicHost = item.kind === "logic" ? new LogicFrameHost(holder, logicStatics(def)) : null;
    try {
      root.render(<Stage def={def} page={page} state={state} pageKey={`verify-${item.key}-${sc.id}`} apiRef={apiRef} onTrace={onTrace} onIssue={onIssue} onWrite={onWrite} onLog={() => {}} />);
      // the frame starts (or is refused by the gate)
      for (let w = 0; !ready && !ir.gateRefusal && w < READY_MS && !over(); w += 25) await sleep(25);
      if (ir.gateRefusal) break;
      if (!ready && item.kind !== "logic") { ir.notRun = "its script frame did not start in this browser"; break; }
      if (logicHost && (item.event === "on_load" || !item.event)) await runLogicOnce(def, state, item, logicHost, page, rec, writes, ir);
      await settle();
      for (const st of sc.steps) {
        if (over()) break;
        if (st.do === "answer" || st.do === "clear") {
          const v = st.do === "clear" ? undefined : st.value;
          if (!drive(holder, st.questionId, v)) { setAnswer(def, state, st.questionId, v); apiRef.current?.set({ [st.questionId]: v }); }
          await settle();
          if (logicHost && item.event === "on_change" && (item.scope !== "question" || item.questionId === st.questionId)) await runLogicOnce(def, state, item, logicHost, page, rec, writes, ir);
        } else if (st.do === "fill") {
          const v = fillAnswers(def, page.questionIds, st.valid, seed);
          for (const [id, x] of Object.entries(v)) if (!drive(holder, id, x)) { setAnswer(def, state, id, x ?? undefined); apiRef.current?.set({ [id]: x ?? undefined }); }
          await settle();
        } else if (st.do === "next") {
          const questions = page.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
          let builtIn: string[] = [];
          try { builtIn = validatePage(def, questions, { def, state, loop: null }).filter((e) => (e as { severity?: string }).severity !== "warning").map((e) => String((e as { message?: unknown }).message ?? "")); } catch { builtIn = []; }
          const byScript: string[] = [];
          const ask = apiRef.current?.ask.current;
          if (ask) {
            const answers = await Promise.race([ask("validate", LIFECYCLE_MS), sleep(LIFECYCLE_MS + 300).then(() => [])]);
            for (const a of answers) if (a.id === scriptId || a.script === item.label) for (const e of a.errors ?? []) { byScript.push(e.message); rec.effects.push({ kind: "validation", target: e.ref ? codeOf(def, def.questions.find((q) => q.id === e.ref || String(q.code) === e.ref)?.id ?? e.ref) : "the page", detail: e.message }); }
          }
          if (logicHost && /^on_(?:validate|submit|complete)$/.test(item.event ?? "")) { const o = await runLogicOnce(def, state, item, logicHost, page, rec, writes, ir); byScript.push(...o.errors.map((e) => e.message)); }
          const blocked = builtIn.length > 0 || byScript.length > 0;
          if (!blocked && ask) await Promise.race([ask("submit", LIFECYCLE_MS), sleep(LIFECYCLE_MS + 300)]);
          rec.next = { blocked, errors: [...builtIn, ...byScript].slice(0, 10), byScript: byScript.length };
          await sleep(60);
        }
      }
      await sleep(80);
    } finally {
      logicHost?.dispose();
      root.unmount();
      holder.remove();
    }
  }
  // the save payload: every accepted write of every scenario, in that scenario's state and in what the Runner would post
  const checked = allWrites.reduce((n, x) => n + x.writes.length, 0);
  if (checked) ir.payload = { checked, problems: allWrites.flatMap((x) => savedWriteProblems(x.state, x.writes)) };
  ir.durationMs = Date.now() - t0;
  if (!ir.ran && !ir.gateRefusal && !ir.notRun && !ir.timedOut && item.kind === "logic") ir.notRun = `its event (${item.event}) does not happen in the scenarios the test session can play`;
  return ir;
}
