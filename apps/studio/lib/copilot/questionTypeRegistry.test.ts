import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, questionTypeRegistry, responseModelOf } from "@rescript/schema";
import { DESIGN_TASK_TYPES, QUESTION_NODE_TAGS } from "@rescript/engine";
import { defaultAnswer } from "@rescript/templates";
import { CANONICAL_KIND_TYPES } from "@rescript/import/map";
import { typeName, hasTypeWord } from "./review.ts";

/*
 * METHOD-13 — THE QUESTION-TYPE REGISTRY-COMPLETENESS TEST.
 *
 * `acbc_task` was added to the registry and wired into design generation,
 * the renderer and the export, and forgotten in five shared touch points:
 * the design-reference lint, the logic graph, the simulated respondent, the
 * import map and the copilot's change review. Nothing said so, because each
 * keeps its own list.
 *
 * This test walks EVERY registered question type (the built-ins
 * `questionTypes.ts` registers, plus any plugin registered by import time)
 * through every one of those surfaces. A type is either known to the surface
 * or exempted here WITH A REASON — and an exemption that has become stale
 * (the surface now knows the type) fails too, so the list stays true. Adding
 * a question type therefore means deciding, here, what each surface does
 * with it.
 */

const humanised = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ");
const isTask = (t: string) => responseModelOf(t) === "tasks";

/** a question of type `t` with something on every axis, and the design it would render from */
const surveyFor = (t: string) => SurveyDefinition.parse({
  meta: { id: "r", code: "R", title: "Registry", version: "1" },
  questions: [{
    id: "q", code: "Q1", variableName: "Q1", type: t, text: "Question",
    options: [{ code: "1", label: "One" }, { code: "2", label: "Two" }],
    rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }],
    columns: [{ id: "c1", label: "Col", responseType: "numeric", variableStem: "C1", options: [], validation: [], readOnly: false }],
    settings: isTask(t) ? { designRef: "d1" } : {},
  }],
  flow: [{ type: "page", id: "p", questionIds: ["q"] }],
  designs: isTask(t) ? [{
    id: "d1", name: "D", kind: t.replace(/_task$/, ""),
    config: { attributes: [{ name: "Brand", levels: ["A", "B", "C"] }, { name: "Price", levels: ["$1", "$2"] }], screeningTasks: 2 },
  }] : [],
});

interface Surface {
  name: string;
  knows(t: string): boolean;
  /** why a type is deliberately not handled — null when it must be */
  exempt(t: string): string | null;
}

const NO_ANSWER: Record<string, string> = {
  html: "displays text and takes no answer",
  hidden: "derived — the survey writes it, never the respondent",
  calculated: "derived — the survey writes it, never the respondent",
  embedded_data: "derived — the survey writes it, never the respondent",
  upload: "a file cannot be fabricated headlessly; the walk leaves it empty",
  video_interview: "a recording cannot be fabricated headlessly; the walk leaves it empty",
  custom_component: "the answer shape belongs to the plugin; a test path supplies it",
};

const NOT_IMPORTED: Record<string, string> = {
  matrix_numeric: "a source numeric grid imports as numeric_list (one number per row)",
  text_list: "no supported source format has a text-list question",
  image_select: "source image choices import as single/multi select with their labels",
  image_ranking: "source image rankings import as ranking",
  custom_table: "a source mixed grid imports as composite",
  custom_component: "plugin-defined; no source format carries one",
  embedded_data: "source embedded data imports into flow Embedded Data nodes, not questions",
  annotation: "no supported source format has an image-annotation question",
  media_timeline: "no supported source format has a media-timeline question",
  repeating_group: "no supported source format has a repeating group",
  experiment: "source randomizers import as flow randomizers, not experiment questions",
  geo: "no supported source format has a location question",
  video_interview: "no supported source format has a video interview",
};

const HUMANISED_NAME_READS_RIGHT = new Set([
  "image_ranking", "hotspot", "composite", "custom_table", "custom_component", "embedded_data",
  "annotation", "media_timeline", "repeating_group", "experiment", "video_interview",
]);

const SURFACES: Surface[] = [
  {
    name: "design-reference lint (engine lintLogic DESIGN_TASK_TYPES)",
    knows: (t) => (DESIGN_TASK_TYPES as readonly string[]).includes(t),
    exempt: (t) => (isTask(t) ? null : "does not render from a design"),
  },
  {
    name: "logic graph node badge (engine logicGraph QUESTION_NODE_TAGS)",
    knows: (t) => !!QUESTION_NODE_TAGS[t],
    exempt: (t) => (isTask(t) || t === "hidden" || t === "calculated" ? null : "an ordinary question node, no badge"),
  },
  {
    name: "simulated respondent (templates defaultAnswer)",
    knows: (t) => {
      const def = surveyFor(t);
      const state = { seed: 3, answers: {} } as Parameters<typeof defaultAnswer>[2]["state"];
      return defaultAnswer(def, def.questions[0], { state, loop: null }) != null;
    },
    exempt: (t) => NO_ANSWER[t] ?? null,
  },
  {
    name: "import map (import CANONICAL_KIND_TYPES)",
    knows: (t) => Object.values(CANONICAL_KIND_TYPES).some((k) => k.type === t),
    exempt: (t) => NOT_IMPORTED[t] ?? null,
  },
  {
    name: "copilot change review (typeName)",
    knows: (t) => hasTypeWord(t),
    exempt: (t) => (HUMANISED_NAME_READS_RIGHT.has(t) ? `“${humanised(t)}” already reads as a researcher says it` : null),
  },
];

test("METHOD-13: every registered question type is known to every shared surface, or exempted with a reason", () => {
  const types = questionTypeRegistry.all().map((p) => p.type);
  assert.ok(types.includes("acbc_task") && types.length >= 40, `the registry is populated (${types.length})`);
  const problems: string[] = [];
  for (const s of SURFACES) {
    for (const t of types) {
      const knows = s.knows(t);
      const why = s.exempt(t);
      if (!knows && !why) problems.push(`${s.name} does not know ${t} — wire it, or exempt it here with a reason`);
      if (knows && why) problems.push(`${s.name} now knows ${t} — drop its stale exemption (“${why}”)`);
    }
  }
  assert.deepEqual(problems, []);
});

test("METHOD-13: acbc_task specifically — the reported gap", () => {
  assert.ok((DESIGN_TASK_TYPES as readonly string[]).includes("acbc_task"));
  assert.equal(QUESTION_NODE_TAGS.acbc_task, "acbc");
  assert.equal(typeName({ type: "acbc_task" }), "Adaptive conjoint (ACBC)");
  assert.deepEqual(CANONICAL_KIND_TYPES.acbc, { type: "acbc_task", variant: "conjoint.acbc" });
});
