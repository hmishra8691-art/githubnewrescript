"use client";
import React from "react";
import type { FlowNode, SurveyDefinition, Question } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import { nextQuestionNaming, type ObjectKey } from "@rescript/engine";
import { useStudio, uid } from "./store";
import { useMode } from "./ModeContext";
import { useSelection } from "./SelectionContext";
import { createFromVariant } from "./VariantPicker";
import { newFlowNode } from "./blockModel";
import { applicable, commandForKey, type Command } from "../../lib/commands/core";
import {
  builtinCommands, navigationCommands, findCommands, type StudioCommandContext,
} from "../../lib/commands/builtins";

/**
 * THE COMMAND PROVIDER — one registry, one keyboard handler, one palette state.
 *
 * It assembles the context every command runs against from the pieces the
 * Studio already has (the store, the mode, the selection, the shell's own
 * actions) and exposes three things: the applicable commands, `run(id)`, and
 * the palette's open/close. The shell registers its `save`/`test`/`preview`
 * closures here rather than the other way round, so this file depends on
 * nothing in `Studio.tsx`.
 *
 * Keyboard: one `keydown` listener on `window`. A chord fires only when its
 * command applies right now, and — unless the command is `global` — never
 * while the programmer is typing in a field, for the same reason the store's
 * ⌘Z handler stands back: a text field's own shortcuts must keep meaning
 * what they mean.
 */

export interface ShellActions {
  save?(): void | Promise<void>;
  testSurvey?(): void | Promise<void>;
  preview?(): void;
}

interface CommandApi {
  /** every command that applies right now, in registry order */
  commands: Command<StudioCommandContext>[];
  /** the object-finding commands (questions, calcs, rules) — searched, never listed whole */
  finders: Command<StudioCommandContext>[];
  /**
   * `override` lets a renderer act on an object that is not the current
   * selection — a hover action on a grid row runs "duplicate" for THAT row
   * without first changing what is selected.
   */
  run(id: string, override?: Partial<StudioCommandContext>): void;
  runCommand(cmd: Command<StudioCommandContext>, override?: Partial<StudioCommandContext>): void;
  paletteOpen: boolean;
  openPalette(): void;
  closePalette(): void;
  /** the shell hands over its actions once it has them */
  setShell(actions: ShellActions): void;
  /** the current context, for renderers that want `when()` themselves */
  context: StudioCommandContext;
}

const Ctx = React.createContext<CommandApi | null>(null);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function CommandProvider({
  tab, setTab, tabs, children,
}: {
  tab: string;
  setTab(tab: string): void;
  tabs: { key: string; label: string; group: string }[];
  children: React.ReactNode;
}) {
  const s = useStudio();
  const mode = useMode();
  const selection = useSelection();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const shellRef = React.useRef<ShellActions>({});
  const [shellVersion, bumpShell] = React.useState(0);

  const openPalette = React.useCallback(() => setPaletteOpen(true), []);
  const closePalette = React.useCallback(() => setPaletteOpen(false), []);

  const context = React.useMemo<StudioCommandContext>(() => {
    const primary = selection?.primary ?? (s.selectedQuestionId ? `question:${s.selectedQuestionId}` : null);
    return {
      tab,
      mode: mode?.mode ?? "studio",
      primary,
      questionId: s.selectedQuestionId,
      readOnly: s.readOnly,
      def: s.def,
      update(label, mutator) { s.labelNextEdit(label); s.update(mutator); },
      undo: () => s.undo(),
      redo: () => s.redo(),
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      selectQuestion(id) {
        if (selection) selection.dispatch(id ? { type: "select", key: `question:${id}` } : { type: "clear" });
        else s.select(id);
      },
      selectKey(key) { selection?.dispatch({ type: "select", key: key as ObjectKey }); },
      setTab,
      setMode(m) { mode?.setMode(m); },
      focus: mode?.focus ?? false,
      setFocus(on) { mode?.setFocus(on); },
      uid,
      newQuestion(def: SurveyDefinition): Question {
        const v = variantRegistry.get("single_select.radio")!;
        return createFromVariant(v, nextQuestionNaming(def));
      },
      newFlowNode: (type: FlowNode["type"]) => newFlowNode(type),
      shell: { ...shellRef.current, openPalette },
      toast: (m, k) => s.toast(m, k),
      tabs,
    };
    // shellVersion is read so a late-registered shell action is picked up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, setTab, tabs, s, mode, selection, openPalette, shellVersion]);

  const registry = React.useMemo(() => [...builtinCommands(), ...navigationCommands(tabs)], [tabs]);
  const commands = React.useMemo(() => applicable(registry, context), [registry, context]);
  const finders = React.useMemo(() => findCommands(s.def), [s.def]);

  const contextRef = React.useRef(context);
  contextRef.current = context;

  const runCommand = React.useCallback((cmd: Command<StudioCommandContext>, override?: Partial<StudioCommandContext>) => {
    const ctx = override ? { ...contextRef.current, ...override } : contextRef.current;
    if (cmd.when && !cmd.when(ctx)) return;
    if (cmd.edits && ctx.readOnly) { ctx.toast("This project is read-only right now.", "err"); return; }
    void cmd.run(ctx);
  }, []);
  const run = React.useCallback((id: string, override?: Partial<StudioCommandContext>) => {
    const cmd = registry.find((c) => c.id === id) ?? finders.find((c) => c.id === id);
    if (cmd) runCommand(cmd, override);
  }, [registry, finders, runCommand]);

  // the one keyboard handler
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const cmd = commandForKey(registry, e, contextRef.current, isTyping(e.target));
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      if (cmd.id === "palette.open") { setPaletteOpen((o) => !o); return; }
      runCommand(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [registry, runCommand]);

  // stable identity: the shell registers in an effect keyed on this function,
  // so a new function per render would re-register per render, forever
  const setShell = React.useCallback((actions: ShellActions) => {
    shellRef.current = actions;
    bumpShell((v) => v + 1);
  }, []);

  const value = React.useMemo<CommandApi>(() => ({
    commands, finders, run, runCommand, paletteOpen, openPalette, closePalette, context, setShell,
  }), [commands, finders, run, runCommand, paletteOpen, openPalette, closePalette, context, setShell]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCommands(): CommandApi | null {
  return React.useContext(Ctx);
}
