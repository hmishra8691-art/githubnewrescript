# Getting started

A ReScript survey is one JSON document — the *survey definition* — that the Studio edits, the runtime renders to respondents, the analytics read and the exporters write out. There are three ways to program it, and they all write the same document.

## Three ways to program

**The editor.** The Studio's *Questions* tab is a visual builder: question types from the picker, options, rows and columns, validation, display and skip logic in a logic tree, randomization, piping, blocks and pages in the flow. Everything the editor does is a change to the definition, saved as a draft and versioned.

**The definition.** The *JSON* tab shows the definition as it is and accepts an edited one back (*validate & apply*). You can write a survey in your editor of choice, paste it in, and the schema tells you what is wrong. Everything on these pages — question types, flow nodes, conditions, calculations — is a field of that document. See [The survey definition](survey-definition).

**Intelligent mode.** The *Intelligent* mode of the Questions tab takes sentences: "make Q5 required", "terminate if Q1 < 18", "add a 5-point satisfaction question after Q7", "randomize the brands in Q3 but keep Other last", "plan a crosstab of satisfaction by gender". The engine reads what it can without a language model (most edits that name their objects), proposes the change as *actions*, shows the diff for approval, applies it as one undoable change and records it in History. A language model is asked only for what needs writing — a questionnaire from a brief, rewording, translations, narrative — and its answer goes through the same actions and the same approval. See [Intelligent mode](intelligent-mode).

## A complete minimal definition

```json
{
  "meta": { "id": "demo", "code": "DEMO", "title": "Demo survey" },
  "questions": [
    { "id": "q_age", "code": "Q1", "variableName": "AGE", "type": "numeric", "text": "How old are you?", "required": true,
      "validation": [{ "kind": "min_value", "value": 16 }, { "kind": "max_value", "value": 99 }],
      "skipLogic": [{ "id": "s1", "when": { "type": "rule", "source": { "kind": "question", "ref": "q_age" }, "operator": "lt", "value": 18 }, "target": { "kind": "terminate", "status": "screened" } }] },
    { "id": "q_gender", "code": "Q2", "variableName": "GENDER", "type": "single_select", "variant": "single_select.radio",
      "text": "What is your gender?", "options": [{ "code": 1, "label": "Male" }, { "code": 2, "label": "Female" }, { "code": 3, "label": "Prefer not to say" }] },
    { "id": "q_brands", "code": "Q3", "variableName": "AWARE", "type": "multi_select", "text": "Which of these brands have you heard of?",
      "options": [{ "code": 1, "label": "Brand A" }, { "code": 2, "label": "Brand B" }, { "code": 3, "label": "Brand C" }, { "code": 99, "label": "None of these", "flags": ["exclusive"] }],
      "randomization": { "enabled": true, "scope": "options", "method": "shuffle" } },
    { "id": "q_pref", "code": "Q4", "variableName": "PREF", "type": "single_select", "text": "Which one do you prefer?",
      "carryForward": { "sourceQuestionId": "q_brands", "filter": "selected", "into": "options" },
      "displayLogic": { "type": "group", "op": "and", "children": [
        { "type": "rule", "source": { "kind": "question", "ref": "q_brands" }, "operator": "answered" },
        { "type": "group", "op": "not", "children": [{ "type": "rule", "source": { "kind": "question", "ref": "q_brands" }, "operator": "selected", "value": "99" }] } ] } },
    { "id": "q_sat", "code": "Q5", "variableName": "SAT", "type": "single_select", "variant": "single_select.nps",
      "text": "How likely are you to recommend {{Q4}} to a friend?" }
  ],
  "flow": [
    { "type": "block", "id": "b_screener", "title": "Screener", "children": [{ "type": "page", "id": "p1", "questionIds": ["q_age", "q_gender"] }] },
    { "type": "block", "id": "b_main", "title": "Brands", "children": [{ "type": "page", "id": "p2", "questionIds": ["q_brands"] }, { "type": "page", "id": "p3", "questionIds": ["q_pref", "q_sat"] }] },
    { "type": "end", "id": "e_complete", "status": "complete", "message": "Thank you." }
  ]
}
```

What this does: Q1 screens out anyone under 18; Q3's brands are shuffled with *None of these* exclusive; Q4 shows the brands chosen at Q3 (carry-forward) and only when something other than *None* was chosen; Q5 pipes the preferred brand into its text and is an NPS scale. The two conditions are stored as JSON `Condition` trees; in the editor and in Intelligent mode you write them in the text logic language — `AGE < 18` and `Q3 answered AND NOT Q3.99` — and the engine compiles them to exactly these trees. See [Logic and expressions](logic).

## Codes, variables and ids

Every question has three names. The **id** (`q_age`) is stable and internal — logic, constructs and translations refer to it, and the Studio never shows it. The **code** (`Q1`) is what the researcher sees and what sentences and logic use. The **variable name** (`AGE`) is the column in the data. Logic accepts either the code or the variable name; the data uses the variable name and derives the rest (`AWARE_1`, `AWARE_2`… for a multi-select; see [Data and exports](data-and-exports)).

## Test and live

A survey has a *draft* (what the Studio edits), *versions* (saved snapshots) and a *deployment*. Respondents reach the live survey at `/s/<client>/<study>` on the runtime and a test version at `/t/<client>/<study>`; test responses are kept apart from live ones in every count, export and analysis. The `/sandbox` project in the Studio is an in-memory playground that saves nothing — the right place to try a definition or a sentence.

## Where to go next

The [survey definition](survey-definition) for the whole document; [question types](question-types) for what each type stores; [logic](logic) for conditions and calculations; [Intelligent mode](intelligent-mode) for programming in sentences.
