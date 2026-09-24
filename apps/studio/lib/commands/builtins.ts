import type { SurveyDefinition, Question, FlowNode } from "@rescript/schema";
import {
  addQuestion, duplicateQuestion, moveQuestionBy, nextQuestionNaming, listPages,
} from "@rescript/engine";
import type { Command, CommandContextBase } from "./core.ts";
import { MODES, type ProgrammingMode } from "../programmingMode.ts";

/**
 * THE BUILT-IN COMMANDS.
 *
 * Each wraps an operation the Studio already performs somewhere, and calls
 * the same engine function that place calls — a palette "Add question" must
 * produce exactly the question the "+ Question" bar produces. Nothing here
 * knows how to mutate a survey; it knows which engine function to call and
 * hands the mutation to the store's `update`, so every command is undoable,
 * labelled, autosaved and refused in read-only, the same as a click.
 *
 * The context is everything a command may need, provided by the Studio
 * shell. Commands that need something the shell has not provided (no
 * `shell.save` in the sandbox, say) simply do not apply.
 */

export interface StudioCommandContext extends CommandContextBase {
  def: SurveyDefinition;
  /** run a labelled edit through the store */
  update(label: string, mutator: (d: SurveyDefinition) => void): void;
  undo(): boolean;
  redo(): boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** select a question (mirrors into the store) or clear */
  selectQuestion(id: string | null): void;
  setTab(tab: string): void;
  setMode(mode: ProgrammingMode): void;
  /** the Studio's id generator, so ids look the way the browser suites expect */
  uid(prefix: string): string;
  /** build a fresh question of the default variant, named for this survey */
  newQuestion(def: SurveyDefinition): Question;
  /** a fresh flow node with the Survey Flow panel's defaults */
  newFlowNode(type: FlowNode["type"]): FlowNode;
  /** the shell's own actions; absent where the shell does not offer them */
  shell?: {
    save?(): void | Promise<void>;
    testSurvey?(): void | Promise<void>;
    preview?(): void;
    openPalette?(): void;
  };
  toast(msg: string, kind?: "ok" | "err"): void;
  /** the tabs the left nav offers, for the Navigate group */
  tabs: { key: string; label: string; group: string }[];
}

type C = Command<StudioCommandContext>;

const selectedQuestion = (ctx: StudioCommandContext): Question | null =>
  ctx.questionId ? ctx.def.questions.find((q) => q.id === ctx.questionId) ?? null : null;

/** the page and position right after the selected question — or the end of the last page */
function insertionPoint(ctx: StudioCommandContext): { pageId?: string; index?: number } {
  const qid = ctx.questionId;
  if (!qid) return {};
  for (const p of listPages(ctx.def.flow as unknown[])) {
    const k = p.node.questionIds.indexOf(qid);
    if (k >= 0) return { pageId: p.node.id, index: k + 1 };
  }
  return {};
}

export function builtinCommands(): C[] {
  const cmds: C[] = [];

  /* ------------------------------------------------------------ add */
  cmds.push({
    id: "question.add", title: "Add question", group: "Add", shortcut: "mod+shift+a", edits: true,
    keywords: ["new question", "insert question", "create question"],
    run(ctx) {
      const q = ctx.newQuestion(ctx.def);
      const at = insertionPoint(ctx);
      ctx.update(`add ${q.code}`, (d) => { addQuestion(d, q, at); });
      ctx.selectQuestion(q.id);
      if (ctx.tab !== "questions") ctx.setTab("questions");
    },
  });
  cmds.push({
    id: "block.add", title: "Add block", group: "Add", edits: true,
    keywords: ["new block", "page", "add page"],
    run(ctx) {
      const node = ctx.newFlowNode("page");
      ctx.update("add block", (d) => {
        const flow = d.flow as FlowNode[];
        const at = flow.findIndex((n) => n?.type === "end");
        flow.splice(at < 0 ? flow.length : at, 0, node);
      });
      ctx.toast("Block added");
    },
  });
  for (const [type, title, kw] of [
    ["branch", "Add branch / condition", ["create branch", "condition", "if then", "routing"]],
    ["randomizer", "Add randomizer", ["randomize", "shuffle", "rotation"]],
    ["loop", "Add loop", ["repeat", "iterate", "per item"]],
    ["quota_check", "Add quota check", ["quota"]],
    ["embedded_data", "Add embedded data", ["url parameter", "panel variable", "hidden variable"]],
  ] as const) {
    cmds.push({
      id: `flow.add.${type}`, title, group: "Add", edits: true, keywords: [...kw],
      run(ctx) {
        const node = ctx.newFlowNode(type);
        ctx.update(title.toLowerCase(), (d) => {
          const flow = d.flow as FlowNode[];
          const at = flow.findIndex((n) => n?.type === "end");
          flow.splice(at < 0 ? flow.length : at, 0, node);
        });
        ctx.setTab("flow");
      },
    });
  }
  cmds.push({
    id: "logic.addDisplayRule", title: "Add display rule", group: "Add", edits: true,
    keywords: ["display logic", "show when", "hide when", "create logic", "new rule"],
    run(ctx) {
      const q = selectedQuestion(ctx);
      const id = ctx.uid("rule");
      ctx.update("add display rule", (d) => {
        d.displayRules.push({
          id,
          label: q ? `Show ${q.code}` : "New rule",
          target: { kind: "question", ref: q?.id ?? (d.questions[0]?.id ?? "") },
          action: "show",
          when: { type: "group", op: "and", children: [] },
        } as never);
      });
      ctx.setTab("logic");
    },
  });
  cmds.push({
    id: "calculation.add", title: "Add calculation", group: "Add", edits: true,
    keywords: ["calc", "computed variable", "formula", "score"],
    run(ctx) {
      const n = ctx.def.calculations.length + 1;
      ctx.update("add calculation", (d) => {
        d.calculations.push({ id: ctx.uid("calc"), targetVariable: `CALC_${n}`, expression: "", trigger: "on_page_submit", dataType: "numeric" } as never);
      });
      ctx.setTab("calculations");
    },
  });

  /* ------------------------------------------------------------ edit */
  cmds.push({
    id: "question.duplicate", title: "Duplicate question", group: "Edit", shortcut: "mod+shift+d", edits: true,
    keywords: ["copy question", "clone"],
    when: (ctx) => !!selectedQuestion(ctx),
    run(ctx) {
      const q = selectedQuestion(ctx)!;
      let copyId: string | null = null;
      ctx.update(`duplicate ${q.code}`, (d) => { copyId = duplicateQuestion(d, q.id, ctx.uid)?.id ?? null; });
      if (copyId) ctx.selectQuestion(copyId);
    },
  });
  cmds.push({
    id: "question.moveUp", title: "Move question up", group: "Edit", shortcut: "alt+arrowup", edits: true,
    when: (ctx) => !!selectedQuestion(ctx),
    run(ctx) { const q = selectedQuestion(ctx)!; ctx.update(`move ${q.code} up`, (d) => { moveQuestionBy(d, q.id, -1); }); },
  });
  cmds.push({
    id: "question.moveDown", title: "Move question down", group: "Edit", shortcut: "alt+arrowdown", edits: true,
    when: (ctx) => !!selectedQuestion(ctx),
    run(ctx) { const q = selectedQuestion(ctx)!; ctx.update(`move ${q.code} down`, (d) => { moveQuestionBy(d, q.id, 1); }); },
  });
  cmds.push({
    id: "edit.undo", title: "Undo", group: "Edit", keywords: ["revert", "take back"],
    when: (ctx) => ctx.canUndo, run(ctx) { ctx.undo(); },
  });
  cmds.push({
    id: "edit.redo", title: "Redo", group: "Edit",
    when: (ctx) => ctx.canRedo, run(ctx) { ctx.redo(); },
  });
  cmds.push({
    id: "selection.clear", title: "Deselect", group: "Edit",
    when: (ctx) => !!ctx.primary, run(ctx) { ctx.selectQuestion(null); },
  });

  /* ------------------------------------------------------------ navigate */
  cmds.push({
    id: "palette.open", title: "Command palette", group: "Navigate", shortcut: "mod+k", global: true,
    keywords: ["search", "commands", "find"],
    run(ctx) { ctx.shell?.openPalette?.(); },
  });

  /* ------------------------------------------------------------ mode */
  for (const m of MODES) {
    cmds.push({
      // no digit shortcut: ⌘1–9 switch browser tabs and ⇧/⌥ change what `key` reports
      id: `mode.${m.id}`, title: `Switch to ${m.label}`, group: "Mode",
      keywords: ["mode", "environment", m.tagline],
      when: (ctx) => m.available && ctx.mode !== m.id,
      run(ctx) { ctx.setMode(m.id); },
    });
  }

  /* ------------------------------------------------------------ survey */
  cmds.push({
    id: "survey.save", title: "Save version", group: "Survey", shortcut: "mod+s", global: true,
    keywords: ["snapshot", "cut version", "commit"],
    when: (ctx) => !!ctx.shell?.save && !ctx.readOnly,
    run(ctx) { return ctx.shell!.save!(); },
  });
  cmds.push({
    id: "survey.test", title: "Test survey", group: "Survey",
    keywords: ["run test", "test link", "test build"],
    when: (ctx) => !!ctx.shell?.testSurvey && !ctx.readOnly,
    run(ctx) { return ctx.shell!.testSurvey!(); },
  });
  cmds.push({
    id: "survey.preview", title: "Preview survey", group: "Survey",
    keywords: ["open preview", "respondent view"],
    when: (ctx) => !!ctx.shell?.preview,
    run(ctx) { ctx.shell!.preview!(); },
  });

  return cmds;
}

/** One "Open <tab>" command per left-nav tab, so navigation is searchable. */
export function navigationCommands(tabs: { key: string; label: string; group: string }[]): C[] {
  return tabs.map((t) => ({
    id: `nav.${t.key}`,
    title: `Open ${t.label}`,
    group: "Navigate" as const,
    keywords: [t.group, "go to", "show"],
    when: (ctx: StudioCommandContext) => ctx.tab !== t.key,
    run: (ctx: StudioCommandContext) => { ctx.setTab(t.key); },
  }));
}

/**
 * The palette also finds SURVEY OBJECTS, not only commands. Each result is a
 * command built on the fly: pick it and the object is selected and its tab
 * opened. Questions match on code, variable name and text; calculations on
 * their variable; display rules on their label.
 */
export function findCommands(def: SurveyDefinition): C[] {
  const out: C[] = [];
  for (const q of def.questions) {
    const text = String(q.text ?? "").replace(/<[^>]*>/g, "").trim();
    out.push({
      id: `find.question.${q.id}`,
      title: `${q.code} · ${q.variableName}${text ? ` — ${text.slice(0, 80)}` : ""}`,
      group: "Find",
      keywords: [q.code, q.variableName, text, q.type],
      run(ctx) { ctx.selectQuestion(q.id); ctx.setTab("questions"); },
    });
  }
  for (const c of def.calculations) {
    out.push({
      id: `find.calculation.${c.id}`, title: `${c.targetVariable} — calculation`, group: "Find",
      keywords: [c.targetVariable, c.label ?? "", "calc"],
      run(ctx) { ctx.setTab("calculations"); },
    });
  }
  for (const r of def.displayRules) {
    out.push({
      id: `find.rule.${r.id}`, title: `${r.label || r.id} — display rule`, group: "Find",
      keywords: [r.label ?? "", "logic", "rule"],
      run(ctx) { ctx.setTab("logic"); },
    });
  }
  return out;
}
