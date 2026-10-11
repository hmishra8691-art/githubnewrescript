# The Research Engine

The Research Engine is the part of the Studio that knows what a survey is *for*: the objective, the hypotheses, the constructs they relate, the questions that measure them, the analysis that will test them, the KPIs the study reports, the audience it is written for — and, after fieldwork, the findings and the documents. It lives in `research` on the definition, is edited in Survey Settings and in Intelligent mode, and drives the analysis plan, the review, the workflow and the outputs.

## The research design

```json
"research": {
  "brief": { "client": "Acme Foods", "businessQuestion": "Should we cut the price of Brand A?", "decision": "whether to launch the 500ml pack in Q2",
             "background": "Brand A lost 4 points of share in 2025", "stakeholders": ["the CMO", "the brand team"], "deadline": "30 November 2026", "deliverables": ["a findings report", "a deck"] },
  "objective": "Understand why customers switch from Brand A to Brand B",
  "population": "UK adults who bought a car in the last 12 months",
  "methodology": "Online panel survey", "sampleSize": 400,
  "hypotheses": ["Price perception drives switching", "Women are more satisfied than men"],
  "hypothesisDetails": [{ "type": "causal", "direction": "positive", "independent": "Price perception", "dependent": "Switching" },
                        { "type": "difference", "direction": "positive", "group": "women", "lower": "men", "dependent": "Satisfaction" }],
  "constructs": [{ "name": "Price perception", "role": "independent", "questionIds": ["q6"] }, { "name": "Switching", "role": "dependent", "questionIds": ["q4"] }, { "name": "Satisfaction", "role": "dependent", "questionIds": ["q7"] }],
  "kpis": [{ "name": "Satisfaction", "variable": "SAT", "measure": "top-2-box share", "direction": "higher" }],
  "audience": { "description": "first-time buyers", "literacy": "plain" },
  "researchQuestions": ["What drives switching?"], "assumptions": ["The panel is representative"], "sources": ["Brief v2"],
  "strict": false
}
```

Hypotheses are labelled `H1`, `H2`… by position. Each has a structured reading (`hypothesisDetails`, aligned by index): `type` (causal, association, difference, descriptive), `direction`, the constructs on each side (`independent`, `dependent`, `moderator`, `mediator`; `group` and `lower` for a difference), `expectedEffect`, `status`. The engine parses a reading from the words when none is recorded ("Women are more satisfied than men" → difference, group women, lower men, dependent satisfaction). Constructs have a role (`independent, dependent, mediator, moderator, control, screening, descriptive`) and the questions that measure them; a question can also be tagged (`question.analysis.construct`, `.hypotheses`, `.role`).

**The project brief** (`research.brief`) is the study in the client's terms: who asked (`client`), the `businessQuestion` behind the objective, the `decision` the findings inform, the `background`, the `stakeholders` who read the findings, the `deadline`, the `deliverables`. It opens the proposal, names the client on every document, leads the deck's summary, and is in the outline every model turn reads. With a brief and no objective, the workflow offers the business question as the objective ("Should we cut the price of Brand A?" → "Understand whether to cut the price of Brand A"). The research design editor can copy a brief from another of your projects. By sentence: "the client is Acme Foods", "set the business question to …", "this study informs the decision to …", "the stakeholders are the CMO and the brand team", "add stakeholder: the CFO", "the findings are due by 15 December", "background: …", "the deliverables are a report and a deck", "what is the brief?". Each sentence sets one field (`set_research { brief }` merges field by field); History and Changes name the field.

In Intelligent mode: "set the research objective to …", "add hypothesis: …", "set the reading of H2: type difference, group women, lower men, dependent satisfaction", "set the target audience to first-time smartphone buyers", "which questions measure purchase intent?", "which questions are not connected to any hypothesis?", "what are the key hypotheses we can test?".

## The analysis plan

```json
"analysisPlan": {
  "crosstabs": [{ "id": "x1", "rows": ["SAT"], "columns": ["GENDER"], "priority": 1, "hypotheses": ["H2"], "reason": "satisfaction by gender" }],
  "tests": [{ "id": "t1", "method": "t_test", "outcome": "SAT", "variables": ["SAT"], "groupBy": "GENDER", "priority": 1, "hypotheses": ["H2"] },
            { "id": "t2", "method": "chi_square", "outcome": "SWITCHED", "variables": ["SWITCHED"], "groupBy": "PRICE_PERC", "priority": 1, "hypotheses": ["H1"] }],
  "derived": [{ "name": "PRICE_SCORE", "kind": "mean_score", "from": ["PP1", "PP2", "PP3"] }],
  "segments": [{ "name": "By region", "by": ["REGION"] }],
  "source": "engine", "autoRun": true
}
```

The engine proposes a plan from the design (`buildAnalysisFramework`): each outcome against the segmentation banner, each independent × dependent pair, a test by the pair's measurement levels (scale × scale → correlation and a regression per outcome; groups × scale → t-test or ANOVA; groups × categorical → chi-square; what a type demands — NPS, MaxDiff scores, conjoint utilities, reliability for a multi-item construct), a mean score per multi-item construct, a top-2-box per ordinal outcome, a segment per segmentation variable. Methods: `frequencies, mean, median, top_box, nps, crosstab, chi_square, t_test, anova, mann_whitney, kruskal_wallis, correlation, regression, logistic_regression, factor, reliability, cluster, conjoint_utilities, maxdiff_scores, turf, driver_analysis, text_themes, ranking_scores, allocation_shares, pricing, brand_funnel`.

The plan explains itself ("why are you recommending a t-test?"), says the base it needs ("how many completes does the plan need?") and reviews itself against the survey (a test on the wrong level, a dead reference, an untested hypothesis). In Intelligent mode: "plan the analysis", "create a cross-tab between age and brand preference", "add a chi-square of brand preference by region", "test whether NPS differs by region", "correlate satisfaction with NPS", "remove the crosstab of satisfaction by gender", "what analyses are planned for satisfaction?", "create the most important crosstabs for this research".

## Coverage and enforcement

**Hypothesis coverage** says, for every hypothesis, whether each construct it names is measured and what the plan runs for it: `testable`, `partly` (measured, nothing planned), `unmeasured` (a construct has no question), `unlinked` (no construct names it, no question is tagged). The review lists the gaps; "which questions could be removed?" ranks questions by what they serve (a hypothesis, a construct, the plan, a KPI, a quota, logic, screening).

**Enforcement** (`research.strict`). When the researcher asks ("enforce the research design", "treat research gaps as blockers"), the research-level gaps become blockers: a change that would open one — a construct left with no question, a planned analysis reading a variable the change removes, a KPI pointing at nothing, a hypothesis nothing tests — is refused at the change, with the gap named and the way to close it; the gaps the design already has are listed as blockers in Review until closed. "Stop enforcing the research design" makes them warnings again. The Survey Settings editor has the same switch.

## Runs, findings, data questions

An analysis **run** executes the plan on the responses (at the fieldwork milestones — first 30 completes, halfway, target, end of field — or on request: "run the plan now"). It returns a verdict per hypothesis (`supported, not_supported, mixed, inconclusive, untested`) with the reason, findings strongest first (test, p, effect size, base), post-hoc corrections across the planned tests (Holm, Bonferroni, BH), data-driven advice (a non-parametric alternative when the distribution asks for it, thin cells), and what was found beyond the plan (segments that differ, anomalies, wave trends). The Findings tab shows it; "what did we find?" narrates it; a data question — "which groups prefer Brand A?", "does satisfaction differ by region?", "what is the average satisfaction by gender?" — is answered on the data, with the test and the base.

**KPIs and waves across runs.** Every run measures each KPI of the design on its own data, as the design says — `top-2-box share`, `mean`, `NPS`, `share <option>` — and stores the snapshot (`run.kpis`). When a run has a previous comparable one (same environment, same dataset kind — the milestone runs on `clean`, a manual run on what it asked for), the comparison is attached as `run.since`: each KPI's last and current value, the change in its own unit and whether the move is significant on the two samples (a two-proportion test for shares, Welch's t from the two means for a mean), better or worse by the KPI's direction; the planned findings matched by what they test (the plan item and its variables, never the run's hash) as new, stronger, weaker, reversed or the same, and those no longer found; the verdicts that changed. The Findings tab shows the KPI table and "Since the last wave"; the brief the model reads prints it; the findings deck gets a slide right after the summary and the report a section after the hypotheses — a tracker's reader asks "what moved?" before "what did we find?". A narrative may cite the deltas; the gate knows them.

## Documents

Three documents are produced from the design and the runs, by sentence or from the Findings tab: the **research proposal** (Word: the brief — background, business question, decision, stakeholders — and the objective, research questions and KPIs, hypotheses with their readings and the questions that measure them, constructs, the questionnaire by section, sample and the base the plan needs, the analysis plan with its reasons, deliverables, assumptions, sources — "create the client-ready research proposal"); the **findings report** (Word: executive summary, verdicts, each finding with its so-what, who differs, beyond the plan, the method, caveats — "write the findings report as a Word document"); the **findings deck** (PowerPoint: title, summary, a key finding per slide with the chart chosen for the audience and its significance badge, who differs, statistical highlights, beyond the plan, implications, recommendations, method, caveats — "create the final findings presentation", "create the findings deck for the board" for the executive edition). Chart types are chosen by analytical purpose and audience (executive, client, researcher). A model-written narrative, when a model is there, passes a gate sentence by sentence: every number must be one the run printed, every hypothesis must keep its verdict.

## The workflow

"Start the research workflow for <objective>" runs the whole sequence as twelve approvable steps: objective → assumptions (the population read from the objective, the methodology from its goal, the sample size asked) → structured hypotheses (recorded from the words, or drafted by the model) → research framework (a construct per hypothesis side, with the questions that already measure it) → questionnaire (a standard item for an unmeasured construct the library knows — purchase intent, satisfaction, likelihood to recommend, awareness, importance, loyalty, trust, usage frequency, price perception; bespoke wording from the model) → variables (a mean score per multi-item construct) → analysis plan → crosstab and test recommendations (what a measured hypothesis still lacks) → reporting framework (KPIs from the dependent constructs) → design document → survey structure (screener first, demographics last) → the deck after fieldwork. Every engine step is a proposal in Changes; every model step is priced before it is called; History keeps each with its step.
