---
summary: Data and downloads — test, live or all responses, the dataset filter, CSV and XLSX, SPSS, SAS and Stata, timing and choice files, coded answers as codes or labels, export presets and the data dictionary
related: data-and-exports, testing-and-simulation, analytics, maxdiff
status: available
example: none
---
# Data and downloads

**Results → Data** holds the responses, flattened into the survey's variables — the same shape the CSV produces. Choose **test data**, **live data** or **all**; the **dataset** filter decides which responses the table and downloads use (all, a clean dataset, or a custom selection that excludes chosen quality classifications). **Manage** edits, removes or restores responses; **Quality** shows the response-quality review.

## Download formats

| Download | What it is |
|---|---|
| CSV | One row per respondent, one column per variable |
| XLSX (data + quality) | The data sheet and the response-quality sheet |
| SPSS (.sav) | Variable labels, value labels and missing values as metadata |
| SAS (.xpt + syntax) | A zip: the SAS transport file, a CSV, and a .sas program with PROC FORMAT and LABEL |
| Stata (.dta) | Stata 14+, UTF-8, value labels as metadata |
| Timing, long format (.csv) | One row per respondent × page and per respondent × question: visits, seconds, changes, idle time, scroll depth |
| MaxDiff choice file (.csv) | One row per respondent × task × item shown, with best / worst flags — for HB and logit tools (MaxDiff surveys) |
| Conjoint choice file (.csv) | One row per respondent × task × alternative shown, every attribute level, chosen 0/1 (conjoint surveys) |

In CSV and Excel, coded answers can be written as **codes only** (the default), **labels only**, **codes + labels**, or **export values**. In SPSS, SAS and Stata, codes stay codes and the labels travel as metadata. Options: include the **data dictionary**, add **per-page / per-question timing columns**, and save the choices as an **export preset** shared across the workspace.

## When to use it

- Handing data to a data-processing team: SPSS or Stata with labels.
- Choice modelling outside the platform: the MaxDiff or conjoint choice file.
- Quick reading: XLSX with the quality sheet.

## Set it up in the builder

::: steps Download the data for analysis
1. **Open Results → Data**.
2. **Choose live data** and the **dataset** (e.g. the clean dataset).
3. **More formats** — choose SPSS, SAS or Stata, or a choice file.
4. **Coded answers** — codes, labels or both, for CSV and Excel.
5. **Save as a preset** if you will download the same way again.
:::

::: screen data-formats

## Common mistakes

- **Mixing test and live data** — check the switch before downloading.
- **Labels-only data for processing** — tables and syntax expect codes; use labels for reading.

## Troubleshooting

- *The choice file is missing* — it appears for surveys with a MaxDiff or conjoint design.
- *Download is not allowed* — downloading data is its own capability (see [roles](projects-and-roles)).
