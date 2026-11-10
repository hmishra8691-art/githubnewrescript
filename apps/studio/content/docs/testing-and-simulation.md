---
summary: Testing — Preview and the test link, simulated respondents through the real survey logic, coverage and validation probes, and saving a run as test data
related: versions-and-deploy, data-and-downloads, quotas
status: available
example: none
---
# Testing and simulated respondents

Three ways to test, all running the **real runtime** — the same engine, flow, validation, logic, quotas and piping a respondent gets:

- **Preview** — the survey as a respondent sees it, from the editor, with an optional inspector.
- **Test Survey** — the test link: responses are stored as **test data**, kept apart from live data, and never count toward quotas.
- **Research Tools → Tests** — **simulated respondents**: any number of respondents walk the survey with generated answers, through display and skip logic, quotas, randomization, piping, validation, scripts and terminations.

A simulation run shows **endings** (how many completed, were screened or terminated), **coverage** (questions, pages and conditions reached), **validation probes** (deliberately invalid answers the survey must refuse) and each respondent's path — open any one to see what it saw. Describe the run in words (**Intelligent**) or set it yourself (**Manual**). Download it as Excel or CSV, or **save it as test data** to try the Data tab and analysis on it. A run is never live data.

## When to use it

- Before every deployment: does every path end where it should?
- After a logic change: is anything now unreachable, or hidden for everyone?
- Before fieldwork: try the data layout and the analysis on simulated responses.

## Set it up in the builder

::: steps Run a simulation
1. **Open Research Tools → Tests**.
2. **Describe the run** — e.g. "100 respondents, more screen-outs" — or switch to **Manual**.
3. **Run the simulation**.
4. **Read the summary** — endings, coverage, validation probes — and open any respondent.
5. **Save as test data** if you want to try exports and analysis on it.
:::

::: screen tests

## Common mistakes

- **Reading simulated results as findings** — answers are generated; the run checks the survey, not the market.
- **Testing on the live link** — use Preview, the test link or a simulation; live data is for respondents.

## Troubleshooting

- *Coverage shows a question never reached* — its display logic, a skip or a terminate before it excludes every path the simulation tried; check the logic or run more respondents.
- *Validation probes not refused* — a question accepts answers it should not; add or fix its validation.
