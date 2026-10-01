import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * THE SURVEY'S UX CONFIGURATION — styles, animations and behaviours that
 * belong to the survey, not to one editing session.
 *
 *   Survey
 *    ├── Theme            branding (colours, fonts, buttons, layout)
 *    ├── UX configuration this: scoped styles, animations, behaviours
 *    └── Structure        questions, flow, logic
 *
 * Everything here is DATA. Nothing is a stylesheet or a script the browser
 * runs as written:
 *
 *   styles      target + rules (state, breakpoint, declarations), or scoped
 *               CSS text; compiled by the engine (`compileUxCss`) into CSS
 *               that can only reach this survey's elements
 *   animations  a named preset on a target, played on a trigger
 *   behaviours  when <event> on <target> → effects (add a class, animate,
 *               show a message, set a style…), interpreted by the renderer's
 *               UX layer; or a script, run in a sandboxed frame that can only
 *               talk to the survey through the `rs` api
 *
 * Targets name survey objects by their stable ids (question id, block id,
 * page id, option code), never by a generated CSS path, so a question keeps
 * its styling when it is renamed, moved or recoded. Because it lives in the
 * definition, the UX travels with every version: preview, test, publish,
 * export and duplicate all carry it. Absent on every survey that never had
 * one, and then nothing in the runtime changes.
 */

export const UX_TARGET_KINDS = ["survey", "block", "page", "question", "option", "row", "column", "button", "progress", "navigation", "component"] as const;
/** parts of a question (and of the progress indicator) a rule can address */
export const UX_PARTS = ["card", "title", "instruction", "options", "input", "other_text", "media", "error", "fill", "label"] as const;
export const UX_STATES = ["hover", "focus", "selected", "answered", "disabled"] as const;
export const UX_MEDIA = ["mobile", "tablet", "desktop", "reduced_motion"] as const;
export const UX_BUTTONS = ["next", "back", "submit", "any"] as const;
export const UX_PRESETS = ["fade-in", "fade-up", "fade-down", "slide-left", "slide-right", "scale-in", "pop", "pulse", "shake", "bounce", "wiggle", "highlight", "glow", "expand"] as const;
/** when an animation plays */
export const UX_ANIMATION_TRIGGERS = ["appear", "page_enter", "hover", "focus", "select", "answer"] as const;
/** what a behaviour listens for */
export const UX_EVENTS = ["answer", "change", "select_option", "deselect_option", "page_complete", "block_complete", "appear", "page_enter", "click", "hover"] as const;
export const UX_EFFECTS = ["add_class", "remove_class", "toggle_class", "animate", "set_style", "show", "hide", "show_message", "hide_message", "scroll_into_view", "focus"] as const;

export const UxTarget = z.object({
  kind: z.enum(UX_TARGET_KINDS),
  /** question / option / row / column / component: the question it belongs to (absent: every question) */
  questionId: z.string().optional(),
  /** narrows any target to a block ("every question in Block 4") */
  blockId: z.string().optional(),
  /** narrows any target to a page */
  pageId: z.string().optional(),
  /** an option or row code, or a column id; absent: all of them */
  code: z.string().optional(),
  button: z.enum(UX_BUTTONS).optional(),
  part: z.enum(UX_PARTS).optional(),
  /** a custom component's own element, by a simple relative selector (`.gauge`, `[data-step]`) */
  selector: z.string().max(200).optional(),
});
export type UxTarget = z.infer<typeof UxTarget>;

export const UxRule = z.object({
  state: z.enum(UX_STATES).optional(),
  media: z.enum(UX_MEDIA).optional(),
  /** applies while a behaviour's class is on the target (`add_class` "chosen" → whenClass "chosen") */
  whenClass: z.string().max(40).optional(),
  /** a simple relative selector inside the target (`input[type=radio]`, `.rs-option-label`) */
  selector: z.string().max(200).optional(),
  declarations: z.record(z.string().max(400)).default({}),
});
export type UxRule = z.infer<typeof UxRule>;

export const UxStyle = z.object({
  id: z.string(),
  label: z.string().max(160),
  target: UxTarget,
  rules: z.array(UxRule).default([]),
  /** scoped CSS text: selectors are relative to the target, `&` is the target itself */
  css: z.string().max(20000).optional(),
  /** applies only while this holds on the answers so far — "highlight Q8 for heavy users" (any nesting) */
  when: Condition.optional(),
  createdAt: z.string().optional(),
});
export type UxStyle = z.infer<typeof UxStyle>;

export const UxAnimation = z.object({
  id: z.string(),
  label: z.string().max(160),
  target: UxTarget,
  preset: z.enum(UX_PRESETS),
  trigger: z.enum(UX_ANIMATION_TRIGGERS).default("appear"),
  durationMs: z.number().int().min(50).max(10000).default(400),
  delayMs: z.number().int().min(0).max(10000).default(0),
  easing: z.string().max(60).default("ease-out"),
  /** "one at a time": each matching element starts this much after the previous one */
  staggerMs: z.number().int().min(0).max(3000).default(0),
  iterations: z.union([z.number().int().min(1).max(20), z.literal("infinite")]).default(1),
  media: z.enum(UX_MEDIA).optional(),
  /** plays only while this holds on the answers so far (any nesting) */
  when: Condition.optional(),
  createdAt: z.string().optional(),
});
export type UxAnimation = z.infer<typeof UxAnimation>;

export const UxEffect = z.object({
  do: z.enum(UX_EFFECTS),
  /** where the effect lands; absent: the behaviour's own target */
  target: UxTarget.optional(),
  className: z.string().max(40).optional(),
  preset: z.enum(UX_PRESETS).optional(),
  durationMs: z.number().int().min(50).max(10000).optional(),
  style: z.record(z.string().max(400)).optional(),
  /** show_message: plain text, never HTML */
  text: z.string().max(600).optional(),
});
export type UxEffect = z.infer<typeof UxEffect>;

export const UxBehavior = z.object({
  id: z.string(),
  label: z.string().max(160),
  /** what it is attached to: the source of its events and the default target of its effects */
  target: UxTarget,
  /** declarative: when… */
  on: z.enum(UX_EVENTS).optional(),
  /** select_option / deselect_option: which options (codes); absent: any */
  options: z.array(z.string()).max(50).optional(),
  /** …then these */
  effects: z.array(UxEffect).max(20).default([]),
  /** or a script, run sandboxed against the `rs` api only */
  script: z.string().max(8000).optional(),
  once: z.boolean().optional(),
  /**
   * …and only while this holds. A behaviour used to be one event and a list of
   * options — "when Q3 option 2 is selected" — with no way to say "when Q3 is
   * 2 AND Q1 is at least 18". This is the ordinary survey Condition, nested as
   * deep as any other, evaluated against the answers at the moment the event
   * fires.
   */
  when: Condition.optional(),
  createdAt: z.string().optional(),
});
export type UxBehavior = z.infer<typeof UxBehavior>;

export const UxConfig = z.object({
  styles: z.array(UxStyle).default([]),
  animations: z.array(UxAnimation).default([]),
  behaviors: z.array(UxBehavior).default([]),
});
export type UxConfig = z.infer<typeof UxConfig>;
