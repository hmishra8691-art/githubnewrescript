/**
 * S3b item 6 (audit MM-15) — "RUN IN A TEST SESSION" FROM THE EDITOR, the pure half. The S2c harness
 * (`lib/copilot/verify/harness.tsx`: the real QuestionRenderer, UxLayer sandbox, logic frame, write channel) runs the
 * CURRENT editor text — not what is saved: `editorRunInput` puts that text into a clone of the survey and builds the
 * harness's item from it. A switched-off behaviour is switched on in the clone (the runtime does not start a disabled
 * script, and the point is to see what it would do). Nothing is saved; the real draft is never touched.
 *
 * `runLog` flattens the harness's record into the panel's lines (logs, errors with their line, effects, writes, Next);
 * `runMarkers` turns errors that name a line into lint markers on that line.
 */
import type { SurveyDefinition } from "@rescript/schema";
import { questionByRef, type VerifyItem, type VerificationReport, type ItemVerdict } from "@rescript/engine";
import type { CodeDiagnostic } from "@/lib/code/types.ts";

export type RunTarget = { kind: "behaviour"; id: string } | { kind: "logic"; id: string } | { kind: "component"; questionId: string };

export function editorRunInput(def0: SurveyDefinition, target: RunTarget, code: string): { def: SurveyDefinition; item: VerifyItem } | { error: string } {
  if (!code.trim()) return { error: "there is no code to run" };
  const def = structuredClone(def0);
  if (target.kind === "behaviour") {
    const b = def.ux?.behaviors.find((x) => x.id === target.id);
    if (!b) return { error: "save the script once before running it (it is not in the survey yet)" };
    b.script = code;
    delete b.enabled;
    return { def, item: { key: `behaviour:${b.id}`, kind: "behaviour", id: b.id, label: b.label, code, ...(b.target.questionId ? { questionId: b.target.questionId } : {}), ...(b.target.pageId ? { pageId: b.target.pageId } : {}), ...(b.target.blockId ? { blockId: b.target.blockId } : {}) } };
  }
  if (target.kind === "logic") {
    const s = def.scripts.find((x) => x.id === target.id);
    if (!s) return { error: "the script is not in the survey" };
    s.code = code;
    s.enabled = true;
    const q = s.scope === "question" ? questionByRef(def, s.ref) : undefined;
    return { def, item: { key: `logic:${s.id}`, kind: "logic", id: s.id, label: s.name, code, event: s.event, scope: s.scope, ...(s.ref ? { ref: s.ref } : {}), ...(q ? { questionId: q.id } : {}), ...(s.scope === "page" && s.ref ? { pageId: s.ref } : {}) } };
  }
  const q = def.questions.find((x) => x.id === target.questionId);
  if (!q || q.type !== "custom_component") return { error: "the component question is not in the survey" };
  q.customJs = code;
  return { def, item: { key: `component:${q.id}`, kind: "component", id: q.id, label: `${q.code} component`, code, questionId: q.id } };
}

/** run the harness on the editor's text (the runner is injected: the browser passes `runVerification`) */
export async function runEditorTest(def: SurveyDefinition, target: RunTarget, code: string,
  run: (def: SurveyDefinition, items: VerifyItem[]) => Promise<VerificationReport>): Promise<{ report: VerificationReport; verdict: ItemVerdict; code: string } | { error: string }> {
  const input = editorRunInput(def, target, code);
  if ("error" in input) return input;
  const report = await run(input.def, [input.item]);
  const verdict = report.verdicts[0];
  if (!verdict) return { error: "the test session returned nothing" };
  return { report, verdict, code };
}

export interface RunLine { kind: "log" | "error" | "effect" | "write" | "next" | "note"; text: string; line?: number; scenario?: string }

export function runLog(report: VerificationReport): RunLine[] {
  const out: RunLine[] = [];
  for (const rec of report.items) {
    if (rec.notRun) out.push({ kind: "note", text: `not run: ${rec.notRun}` });
    if (rec.gateRefusal) out.push({ kind: "error", text: `refused by the check: ${rec.gateRefusal}` });
    for (const w of rec.watchdog) out.push({ kind: "error", text: w });
    for (const h of rec.hostRefusals) out.push({ kind: "note", text: `refused by the page: ${h}` });
    for (const sc of rec.scenarios) {
      for (const l of sc.logs) out.push({ kind: "log", text: l, scenario: sc.label });
      for (const e of sc.errors) out.push({ kind: "error", text: e.message, ...(e.line ? { line: e.line } : {}), scenario: sc.label });
      for (const e of sc.effects) out.push({ kind: "effect", text: `${e.kind} on ${e.target}${e.detail ? ` (${e.detail})` : ""}`, scenario: sc.label });
      for (const w of sc.writes) out.push({ kind: "write", text: `${w.call}${w.ok ? ` → ${JSON.stringify(w.value ?? null).slice(0, 60)}` : ` refused: ${w.reason ?? "not allowed"}`}`, scenario: sc.label });
      if (sc.next) out.push({ kind: "next", text: sc.next.blocked ? `Next stopped: ${sc.next.errors.join("; ") || "(no message)"}` : "Next went on", scenario: sc.label });
    }
    if (rec.unplayed) out.push({ kind: "note", text: `${rec.unplayed} scenario(s) not played (time limit)` });
  }
  return out;
}

/** errors that name a line → error markers on that line of `code` (each line once) */
export function runMarkers(report: VerificationReport, code: string): CodeDiagnostic[] {
  const lines = code.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const seen = new Set<number>();
  const out: CodeDiagnostic[] = [];
  for (const rec of report.items) for (const sc of rec.scenarios) for (const e of sc.errors) {
    if (!e.line || e.line < 1 || e.line > lines.length || seen.has(e.line)) continue;
    seen.add(e.line);
    const from = starts[e.line - 1]!;
    out.push({ from, to: from + lines[e.line - 1]!.length, severity: "error", message: `Test session (“${sc.label}”): ${e.message}`, located: true });
  }
  return out;
}
