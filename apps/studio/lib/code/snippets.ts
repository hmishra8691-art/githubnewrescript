/**
 * S3b item 7 (audit MM-12) — THE SNIPPET LIBRARY: a small built-in list of working starting points, from the
 * capability registry's patterns (the `rs` api for behaviour scripts, the ctx helpers for logic scripts, el / api for a
 * component). Each one passes its own gate as written (snippets.test.ts runs every one through it), and names its
 * questions with placeholders the programmer replaces (Q1, Q2, TOTAL…).
 *
 * Offered two ways in the code editor: as completion entries of type "snippet" (type a word of its name — "highlight",
 * "countdown", "validation") and from the toolbar's "Insert snippet" menu.
 *
 * Built in only: an org-wide shared library needs a backend (storage, permissions, versioning) — not in this step.
 */
import type { CodeCompletion, CodeKind } from "./types.ts";

export interface Snippet { id: string; label: string; kind: "ux" | "logic" | "component"; info: string; body: string }

export const SNIPPETS: Snippet[] = [
  {
    id: "highlight-on-select", kind: "ux", label: "highlight on select",
    info: "Adds a class to this question while an option is selected (style the class in a style item).",
    body: `rs.listen("select", "self", (e) => {\n  rs.addClass("self", "rs-highlight");\n});\nrs.listen("deselect", "self", (e) => {\n  rs.removeClass("self", "rs-highlight");\n});`,
  },
  {
    id: "live-total-warning", kind: "ux", label: "live total with warning",
    info: "Adds up Q1 and Q2 as they are typed, shows the total under this question and warns above 100.",
    body: `function update() {\n  const total = Number(rs.getAnswer("Q1") || 0) + Number(rs.getAnswer("Q2") || 0);\n  if (total > 100) {\n    rs.showMessage("self", "Total: " + total + " — more than 100");\n    rs.addClass("self", "rs-over");\n  } else {\n    rs.showMessage("self", "Total: " + total);\n    rs.removeClass("self", "rs-over");\n  }\n}\nrs.listen("change", "Q1", update);\nrs.listen("change", "Q2", update);\nupdate();`,
  },
  {
    id: "countdown-display", kind: "ux", label: "countdown display",
    info: "Shows a 10-second countdown under this question (each second scheduled once — no self-calling timer).",
    body: `const seconds = 10;\nfor (let i = 0; i <= seconds; i++) {\n  rs.after(i * 1000, () => {\n    rs.showMessage("self", i < seconds ? "Time left: " + (seconds - i) + " s" : "Time is up");\n  });\n}`,
  },
  {
    id: "message-after-answer", kind: "ux", label: "show message after answer",
    info: "Shows a short message under this question once it is answered.",
    body: `rs.listen("answer", "self", (e) => {\n  rs.showMessage("self", "Thank you — noted.");\n});`,
  },
  {
    id: "section-jump-button", kind: "ux", label: "section jump button",
    info: "Adds a button under this question that jumps to a section (block) by its name.",
    body: `const card = document.querySelector('[data-rs-el="question"]');\nif (card) {\n  const button = document.createElement("button");\n  button.type = "button";\n  button.textContent = "Skip to the next section";\n  button.addEventListener("click", () => rs.goToSection("Section 2"));\n  card.appendChild(button);\n}`,
  },
  {
    id: "logic-calc", kind: "logic", label: "logic script calculation",
    info: "Computes a value from answers and stores it as a calculation (run on_change or on_submit).",
    body: `const total = Number(get("Q1") || 0) + Number(get("Q2") || 0);\nsetCalc("TOTAL", total);\nif (total > 100) {\n  flag("over_100");\n}`,
  },
  {
    id: "logic-validation", kind: "logic", label: "logic script validation",
    info: "Stops Next with a message when two answers do not fit together (run on_validate).",
    body: `const age = Number(get("AGE"));\nconst years = Number(get("YEARS_DRIVING"));\nif (years > age - 16) {\n  error("Years driving cannot be more than age minus 16.", "YEARS_DRIVING");\n}`,
  },
  {
    id: "component-skeleton", kind: "component", label: "component skeleton",
    info: "A custom component: draws its control in el, keeps the answer in api (getValue / setValue / onChange).",
    body: `const input = document.createElement("input");\ninput.type = "range";\ninput.min = "0";\ninput.max = "10";\ninput.value = String(api.getValue() ?? 5);\nconst label = document.createElement("span");\nlabel.textContent = input.value;\ninput.addEventListener("input", () => {\n  label.textContent = input.value;\n  api.setValue(Number(input.value));\n});\nel.appendChild(input);\nel.appendChild(label);`,
  },
];

export const snippetsFor = (kind: CodeKind): Snippet[] => SNIPPETS.filter((s) => s.kind === kind);

/** the snippets as completion entries (type "snippet"): the label is "snippet <name>", the body is what is inserted */
export function snippetCompletions(kind: CodeKind): CodeCompletion[] {
  return snippetsFor(kind).map((s) => ({ label: `snippet ${s.label}`, type: "snippet", detail: "snippet", info: s.info, apply: s.body, boost: -5 }));
}
