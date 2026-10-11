# Intelligent mode

Intelligent mode is the Questions tab in another mode: a box that takes a sentence, a card that says how the sentence was read, a Changes panel that shows the proposed edit as a diff for approval, and a History that keeps every change with its cost and lets it be rolled back. The researcher directs in plain language and approves step by step; nothing is written until *Apply*.

## Who answers

**The engine first.** The Studio's own engine reads the sentence against the survey — without a language model. An edit that names its objects ("make Q7 required", "if Q7 is No, skip Q8 through Q12", "mask the brands selected in Q5 from Q10", "change Q6 to a 7-point agree–disagree scale") becomes actions, checked by applying them to a copy; a question about the survey ("what will break if I delete Q15?", "which questions are untranslated?", "what analyses are planned for satisfaction?") is answered from its graph; a question about the data ("which groups prefer Brand A?") is answered from the responses; an ambiguity becomes a choice; an impossible request a precise refusal with the fix. The semantic tier reads what the recognisers miss by shape — "the gender question must be answered", "nobody under 18 should continue", "break satisfaction down by gender" — by what it means, writes it as the canonical sentence and reads that; one clear reading is taken (and said: *Read "…" as "Make Q2 required"*), several become one question with the readings as choices, a bare object is asked what should happen to it.

**The model second.** What needs writing goes to a language model: a questionnaire from a brief, hypotheses from an objective, rewording and tone, translations, a narrative of findings, a question for a construct the standard library does not know. Its answer is actions in the same vocabulary, through the same gate, shown for the same approval. Without a model configured, or with the project in internal mode, the engine offers what it can do instead (a standard item for "add a question to measure purchase intent", the objective for "create a research design for …") rather than a dead end.

## Sentences the engine reads

The catalogue below is checked by a test against the engine on every build: each sentence is read as the kind shown without a model. Codes and labels are those of the test survey; use your own.

### Editing questions and options

| Sentence | Read as |
|---|---|
| Make Q7 required | actions |
| Q7 should be required | actions |
| make Q8 through Q10 required | actions |
| the gender question must be answered | actions |
| respondents shouldn't be able to skip the age question | actions |
| delete Q3 | actions |
| get rid of the favourite brand question | actions |
| we don't need Q7 | actions |
| duplicate Q7 | actions |
| move Q4 after Q6 | actions |
| put Q7 before Q3 | actions |
| change Q7 to a dropdown | actions |
| rename AGE to RESP_AGE | actions |
| add a numeric question "How many cars do you own?" after Q7 | actions |
| add a single choice question "Do you rent?" with options Yes, No | actions |
| add an Other option to Q4 | actions |
| add options Red, Green and Blue to Q14 | actions |
| make None exclusive in Q5 | actions |
| reorder Q11 options alphabetically | actions |
| recode option Male in Q3 as 5 | actions |
| Make Q13 a 7-point agree-disagree scale | actions |
| Change Q1 to a 1-10 scale | actions |
| randomize Q7 options | actions |
| randomize the options of Q11 keeping Other last | actions |
| show 3 random options of Q5 | actions |
| shuffle the brands in Q10 | actions |
| page break after Q14 | actions |
| put Q15 on a new page | actions |
| I want the comments question on its own page | actions |
| rename block Usage to Behaviour | actions |
| make everything required | actions |

### Logic

| Sentence | Read as |
|---|---|
| If Q7 is No, skip Q8 through Q12 | actions |
| screen out if Q1 < 18 | actions |
| terminate if Q1 < 18 | actions |
| kick out anyone under 18 | actions |
| nobody under 18 should continue | actions |
| people who are 65 or older shouldn't take part | actions |
| Only allow women into the survey | actions |
| hide Q11 when Q3 = 2 | actions |
| show Q8 only when Q1 > 60 | actions |
| only ask Q13 to women | actions |
| don't show Q10 to anyone under 18 | actions |
| show block Brands only if Q7 = 1 | actions |
| remove the display logic from Q8 | actions |
| Q1 must be between 18 and 99 | actions |
| Q5 needs at least 2 selections | actions |
| limit Q6 to 120 characters | actions |
| Q9 must be a whole number | actions |
| Mask all brands selected in Q5 from Q10 | actions |
| at Q10 show only the brands not selected in Q5 | actions |
| show option Canada in Q11 only when Q3 = 1 | actions |
| create an embedded variable called source from the url | actions |
| add a calculated variable TOTAL = Q1 + Q9 | actions |

### Questions about the survey

| Sentence | Read as |
|---|---|
| What will break if I delete Q15? | answer |
| What questions depend on Q7? | answer |
| can we see what breaks if Q2 goes | answer |
| What does Q9 depend on? | answer |
| Which questions are untranslated? | answer |
| Which questions measure purchase intent? | answer |
| Which questions are not connected to any hypothesis? | answer |
| Which questions could be removed? | answer |
| What analysis can I run on this study? | answer |
| which questions are about price | answer |
| Why are you recommending a t-test? | answer |
| How many completes does the analysis plan need? | answer |
| Review the entire survey and identify problems with the logic. | answer |
| What is wrong with the wording? | answer |

### Research design and analysis

| Sentence | Read as |
|---|---|
| Set the research objective to understand churn | actions |
| the objective of the study is to understand brand switching | actions |
| add hypothesis: women are more satisfied than men | actions |
| we expect women to be more satisfied than men | actions |
| Set the target audience to first-time smartphone buyers | actions |
| Create an analysis framework for this research. | actions |
| plan the analysis | actions |
| Create a cross-tab between age and brand preference. | actions |
| break purchase intent down by gender | actions |
| add a chi-square of brand preference by region | actions |
| run a t-test of purchase intent by gender | actions |
| is purchase intent related to gender | actions |
| Create the most important crosstabs for this research | actions |
| Remove questions not related to the hypotheses | actions |
| enforce the research design | actions |
| the client is Acme Foods | actions |
| set the business question to Should we cut the price of Brand A? | actions |
| this study informs the decision to launch the 500ml pack in Q2 | actions |
| the stakeholders are the CMO and the brand team | actions |
| the findings are due by 15 December | actions |
| what is the brief? | answer |
| add French as a language | actions |
| rename the survey to Brand Health 2026 | actions |

### Data, documents, the workflow

| Sentence | Read as |
|---|---|
| Which groups prefer Brand A? | query |
| Which demographic groups are most likely to prefer Brand A? | query |
| Does purchase intent differ by region? | query |
| what is the average car age by gender | query |
| create the client-ready research proposal | output |
| create the final findings presentation | output |
| write the findings report as a Word document | output |
| Create a report showing the key findings. | output |
| start the research workflow for understanding brand switching | workflow |
| what's next? | workflow |

### What the model is asked

| Sentence | Why |
|---|---|
| rewrite Q7 in a friendlier tone | rewording is writing |
| Translate this survey into French | the French text is written |
| Make this survey more suitable for first-time smartphone buyers | adaptation needs judgement |
| Create a survey for this research: we want to understand how younger respondents choose between brands of soft drinks and what makes them switch from one brand to another | a brief |
| change the theme to dark blue | look and feel is composed as theme actions |

## Actions, approval, history

Every change is a batch of **actions** from a closed vocabulary (the [actions reference](actions-reference)): `create_question`, `update_question`, `set_display_logic`, `add_skip`, `set_validation`, `add_crosstab`, `set_research`, `create_style`… The engine coerces what it is given, applies it to a copy, validates each action against the survey as the batch leaves it (a forward reference, an operator the source cannot answer, a missing option), lists what the batch newly breaks elsewhere, and shows the diff in *Changes*. The researcher can untick individual changes, must confirm destructive ones, and applies the rest as one undoable change. *History* records every operation — the prompt, how it was read, the actions proposed and applied, the model calls and their cost, before and after — and offers restore, compare and reapply; ⌘Z undoes the last apply.

**The language corpus.** History is also the record of what researchers say. The *History* tab's "This project's language" line counts the project's sentences, how many the engine reads by itself and how many it hands to the model — the lexicon's backlog, most said first — and *Export the language corpus* writes them, with the survey and the reading each got, to a file (`POST /api/copilot/corpus`). `scripts/corpus-replay.mjs` reads every sentence again with the engine as it is now and says which are the same, better (the model's, now the engine's), worse or changed; the corpora kept in `packages/engine/corpus` are replayed by the engine's tests, so a change to the recognisers or the lexicon is checked against what researchers actually typed, not only against our examples.

A review asked for in a sentence ("review the entire survey and identify problems with the logic", "what is wrong with the wording?") is the engine's own review — logic and reachability, wording, options and scales, duplicates, length, screening, sequencing, hypotheses and the analysis plan, localization, quotas — grouped by severity and narrowed to the area named, in the card and in the *Review* tab with a one-click fix wherever the fix is mechanical; with a model in cloud mode, its reading of the same survey follows.

A long request can be planned first (*Plan first*): the model proposes a change plan — "modify Q5 wording · remove Q12 · add a purchase-experience question · update Q18's options · update the related logic" — the researcher ticks the items, and each approved item is built with its own call so nothing is cut off.

## The research workflow

"Start the research workflow for <objective>" opens the Workflow tab: twelve steps from objective to deck (assumptions, structured hypotheses, research framework, questionnaire, variables, analysis plan, crosstab and test recommendations, reporting framework, design document, survey structure, the deck after fieldwork). Each step is done, ready (the engine's own actions — one click opens them in Changes), yours to answer (with an example sentence that records it), the model's (priced before it is called), or waiting on an earlier step. See [The Research Engine](research-engine).

## Internal and cloud execution, tiers, cost

A project runs **internal** (nothing is sent to a language model: the engine's reading, the standard items, your answers) or **cloud** (model steps go to the model). The choice is a project setting switched in the Workflow tab; one request can be let through once. In internal mode a model turn is refused on its card with the cause and the switch named — never a silent fallback.

Two model **tiers** are configured on the server: the large model (`AI_MODEL`) drafts; the small one (`AI_MODEL_SMALL`, optional) structures a short answer. Every model step shows its tier and, before it is called, its estimated cost in credits; the wallet holds the expected size of the call and is settled with what the provider reported. Intelligent mode does not ration an answer: it asks the provider for its full output ceiling (`AI_MAX_OUTPUT_TOKENS`, 32 000 by default), lowers it only when the provider says it must, and continues a cut-off answer up to eight times.

## Failure, said plainly

A model turn that fails says why on its card and in History — no model configured, the wallet refused, a timeout, the provider refused, the answer was cut off, the answer was words not changes, the answer was empty, internal mode — with what to do next. A sentence the engine cannot read and no model is there to read says what the engine detected and the forms it does read.
