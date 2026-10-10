# Data and exports

## What a question stores

Each base type has a *response model* that decides the stored answer and the columns it exports. The variable name is the column stem; derived columns take a suffix (configurable per survey under *variable naming*).

| Response model | Types | Stored answer | Columns |
|---|---|---|---|
| `single_choice` | single_select, dropdown, nps, slider… | one code | `VAR` |
| `multiple_choice` | multi_select, multi_dropdown, image_select | the selected codes | `VAR` (list), `VAR_<code>` = 0/1 per option, `VAR_other` for an other-specify text |
| `numeric` | numeric, slider, nps | a number | `VAR` |
| `text` | open_text, long_text, date (`YYYY-MM-DD`), time (`HH:MM`) | a string | `VAR` |
| `fields` | numeric_list, text_list, repeating_group | `{ rowCode: value }` | `VAR_<row>`; a repeating form adds `VAR_N` and `VAR_<i>_<row>` |
| `per_row` | matrix_single, matrix_multi, matrix_numeric, matrix_text, matrix_dropdown | `{ row: code }` (or codes, number, text) | `VAR_<row>`, `VAR_<row>_<code>` for a multi grid |
| `cells` | composite, custom_table | `{ row: { columnId: value } }` | `<variableStem>_<row>` per column |
| `rank_order` | ranking, image_ranking | the codes in rank order | `VAR_<code>` = rank 1..n |
| `allocation` | allocation | `{ code: amount }` | `VAR_<code>`, `VAR_total` |
| `tasks` | conjoint_task, maxdiff_task, acbc_task | per-task choices | `VAR_T<n>` (+ `_VERSION`), `VAR_T<n>_BEST` / `_WORST`, the ACBC set (`_BYO_*`, `_WINNER_*`, `_UNACCEPTABLE`, `_MUSTHAVE`…) |
| `coordinates` | hotspot, annotation, media_timeline | points, pins and strokes, timeline reactions | `VAR_<i>_X` / `_Y`, `_PINS` / `_STROKES` / `_JSON`, `_N` / `_<code>_N` |
| `geo` | geo | `{ lat, lng, accuracy, radiusM, address{…}, source }` | `VAR_LAT`, `_LNG`, `_ACCURACY_M`, `_RADIUS_M`, `_CITY`, `_REGION`, `_COUNTRY`, `_POSTAL`, `_SOURCE` |
| `media` | upload | `{ url, name, size, type }` (or a list) | `VAR_URL`, `_NAME`, `_SIZE` |
| `interview` | video_interview | watch data, audio, transcript | `VAR` (transcript), `_AUDIO_URL`, `_DURATION_S`, `_RETAKES`, `_TRANSCRIPT_SOURCE`, `_WATCHED_S`, `_WATCHED_PCT`, `_REPLAYS` |
| `derived` | hidden, calculated, embedded_data, experiment | a value | `VAR` (an experiment stores the arm code) |
| `none` | html, custom_component (unless its script sets a value) | nothing | — |

Beside the answers: `LOOP_<VAR>_<NAME>` loop aggregates, `LISTFILL_<NAME>_*` allocations, calculations by their target variable, embedded data by name, and the response's own fields (status, start and end time, duration, language, device, quality flags).

The full table of 40 types is on [question types](question-types); the *variable dictionary* (Data → Dictionary, or `GET /api/surveys/{id}/responses?dictionary=1`) lists every column of a specific survey with its label, type, value labels and source.

## Datasets

A survey's responses are read as a **dataset**: `environment` `LIVE`, `TEST` or `ALL`, and `dataset` `all`, `clean` (the responses that pass the survey's quality rules — speeders, straight-liners, duplicates, failed attention checks — as configured under *Quality*) or `custom:<filter>`. Analyses, exports and the findings outputs name the dataset they read; the clean dataset is the default for analysis.

## Formats

`GET /api/surveys/{id}/responses?format=csv|xlsx|sav|sas|dta|json` with `include=live|all`, `test=1`, `dataset=all|clean|custom:…`, `values=code|label|code_label`, `quality=1`, `dictionary=1`. Export presets (`export-presets`) save a format, a value style, a header style (`name`, `label`, `name_label`) and a column selection.

| Format | What you get |
|---|---|
| CSV | one row per response, every column; value labels or codes as asked |
| Excel (`xlsx`) | the responses with quality flags, and the variable dictionary as a workbook |
| SPSS (`sav`) | a `.sav` with variable labels, value labels, measurement levels and missing values; a bundle adds the syntax |
| SAS (`sas`) | a transport file (`.xpt`) and the syntax that labels it |
| Stata (`dta`) | a `.dta` with labels |
| JSON | the response rows as the runtime stored them |
| Survey (`export/survey`) | the definition as JSON, or the questionnaire as a Word document |

Variable names are shortened and de-duplicated per format's rules (SPSS's 64 characters, SAS's 32) with the mapping in the dictionary.

## Quality

Each response carries quality signals — duration against the median, straight-lining in grids, duplicate fingerprints, attention-check results, open-end gibberish — scored by the survey's quality profile. `GET /api/surveys/{id}/quality` lists them; a response can be excluded or restored (`PATCH /quality/{sessionId}`), the scores recomputed, and excluded responses purged.
