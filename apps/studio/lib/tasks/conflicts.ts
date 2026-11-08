/**
 * WHEN AGENTS WORKING SIDE BY SIDE STEP ON EACH OTHER (2026-11-07).
 *
 * Steps of one task can now run at the same time (up to three lanes). The plan keeps them apart — each batch owns
 * its own codes, a logic step waits for the questions it reads — and the task's draft is the completed steps'
 * actions replayed in plan order, so a later step always builds on what earlier ones made. But a model can still
 * reach outside its slot: two batches both create Q21, one step rewrites a question another deleted, two steps set
 * different display logic on the same question. Replayed silently, the later one would simply win.
 *
 * `findConflicts` reads what every COMPLETED step actually did (its actions — never a guess) and names each object
 * two steps both changed in ways that cannot both stand:
 *
 *   same_code       two steps create a question with the same code
 *   edit_deleted    one step deletes a question another creates or edits
 *   same_setting    two steps set the same setting of the same question (text, options, display logic, validation)
 *   same_block      two steps create a block with the same title
 *
 * A conflict pauses the task before anything builds on it, and the researcher chooses which step's version stands;
 * the other step is run again on top of the chosen one (`resolutionPlan`), so its work is redone around it rather
 * than thrown away. Deterministic and offline.
 */
export type ConflictKind = "same_code" | "edit_deleted" | "same_setting" | "same_block";
export interface StepConflict {
  key: string;
  kind: ConflictKind;
  /** the object both steps touched, in words: "Q21", "display logic of Q4", "block “Demographics”" */
  object: string;
  steps: { stepId: string; title: string; did: string }[];
  /** the question the researcher answers */
  question: string;
}

interface StepLike { stepId: string; status: string; title?: string; kind?: string; output?: unknown; ordinal?: number }
type Act = Record<string, unknown> & { op?: string };

const actionsOf = (o: unknown): Act[] => (Array.isArray(o) ? o : o && typeof o === "object" && Array.isArray((o as { actions?: unknown }).actions) ? (o as { actions: Act[] }).actions : []) as Act[];
const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
const SETTING_KEYS = ["text", "options", "addOptions", "removeOptions", "rows", "scale", "type", "validation", "required"] as const;

/** the objects one action touches, each with what it did to it */
function touches(a: Act): { key: string; object: string; did: string; mode: "create" | "edit" | "delete" }[] {
  const out: { key: string; object: string; did: string; mode: "create" | "edit" | "delete" }[] = [];
  switch (a.op) {
    case "create_question": if (a.code) out.push({ key: `q:${norm(a.code)}`, object: String(a.code), did: `creates ${a.code} (“${String(a.text ?? "").slice(0, 60)}”)`, mode: "create" }); break;
    case "delete_question": if (a.target) out.push({ key: `q:${norm(a.target)}`, object: String(a.target), did: `deletes ${a.target}`, mode: "delete" }); break;
    case "update_question": {
      if (!a.target) break;
      out.push({ key: `q:${norm(a.target)}`, object: String(a.target), did: `edits ${a.target}`, mode: "edit" });
      for (const k of SETTING_KEYS) if (a[k] !== undefined) out.push({ key: `set:${norm(a.target)}:${k}`, object: `${k === "text" ? "the wording" : k} of ${a.target}`, did: `sets the ${k === "text" ? "wording" : k} of ${a.target}`, mode: "edit" });
      break;
    }
    case "set_display_logic": case "set_validation": {
      const target = a.target ?? a.question;
      if (target) out.push({ key: `q:${norm(target)}`, object: String(target), did: `${a.op === "set_display_logic" ? "adds display logic to" : "adds validation to"} ${target}`, mode: "edit" });
      if (target) out.push({ key: `set:${norm(target)}:${a.op}`, object: `${a.op === "set_display_logic" ? "the display logic" : "the validation"} of ${target}`, did: `sets ${a.op === "set_display_logic" ? "display logic" : "validation"} on ${target}`, mode: "edit" });
      break;
    }
    case "create_block": if (a.title) out.push({ key: `b:${norm(a.title)}`, object: `block “${a.title}”`, did: `creates block “${a.title}”`, mode: "create" }); break;
    case "delete_block": if (a.target ?? a.block) out.push({ key: `b:${norm(a.target ?? a.block)}`, object: `block “${a.target ?? a.block}”`, did: `deletes block “${a.target ?? a.block}”`, mode: "delete" }); break;
  }
  return out;
}

export function findConflicts(steps: readonly StepLike[]): StepConflict[] {
  const seen = new Map<string, { stepId: string; title: string; did: string; mode: string; object: string }[]>();
  for (const s of steps) {
    if (s.status !== "completed") continue;
    for (const a of actionsOf(s.output)) for (const t of touches(a)) {
      const list = seen.get(t.key) ?? [];
      if (!list.some((x) => x.stepId === s.stepId && x.mode === t.mode)) list.push({ stepId: s.stepId, title: s.title ?? s.kind ?? s.stepId, did: t.did, mode: t.mode, object: t.object });
      seen.set(t.key, list);
    }
  }
  const out: StepConflict[] = [];
  for (const [key, list] of seen) {
    const byStep = new Set(list.map((x) => x.stepId));
    if (byStep.size < 2) continue;
    const creates = list.filter((x) => x.mode === "create");
    const deletes = list.filter((x) => x.mode === "delete");
    let kind: ConflictKind | null = null;
    if (key.startsWith("q:") && new Set(creates.map((x) => x.stepId)).size >= 2) kind = "same_code";
    else if (key.startsWith("b:") && new Set(creates.map((x) => x.stepId)).size >= 2) kind = "same_block";
    else if (deletes.length && list.some((x) => x.mode !== "delete" && !deletes.some((d) => d.stepId === x.stepId))) kind = "edit_deleted";
    else if (key.startsWith("set:")) kind = "same_setting";
    if (!kind) continue;
    const involved = [...byStep].map((id) => list.find((x) => x.stepId === id)!);
    const object = involved[0].object;
    out.push({
      key, kind, object,
      steps: involved.map((x) => ({ stepId: x.stepId, title: x.title, did: x.did })),
      question: kind === "same_code" ? `Two agents both created ${object}. Which version should stand? The other step is redone around it with a new code.`
        : kind === "same_block" ? `Two agents both created ${object}. Keep which one? The other step is redone and puts its questions into the kept block.`
        : kind === "edit_deleted" ? `One agent deleted ${object} while another changed it. Keep it (with the change) or delete it?`
        : `Two agents set ${object} differently. Which should stand?`,
    });
  }
  return out;
}

/** the researcher kept `keep`: the other steps in the conflict are redone on top of it (lib/tasks/service.ts `resolveConflict`) */
export function stepsToRedo(c: StepConflict, keep: string): string[] {
  return c.steps.map((x) => x.stepId).filter((id) => id !== keep);
}

/** the sentence a paused task carries while a conflict waits for the researcher */
export function conflictMessage(cs: StepConflict[]): string {
  return cs.length === 1 ? `Conflict between agents: ${cs[0].question}` : `${cs.length} conflicts between agents need your decision — first: ${cs[0].question}`;
}
