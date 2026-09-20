# Data export — statistical formats and the code/label choice

§44, phases 1–3. What a response dataset can be downloaded as, and what each
format does with the difference between a code and its label.

`docs/RESPONSE-DATA.md` covers the dataset filter (all / clean / custom) that
decides *which rows* are exported. This is about *what the file contains*.

---

## The formats

| Format | Parameter | What you get |
|---|---|---|
| CSV | `format=csv` | One row per response, UTF-8, RFC-4180 quoted |
| Excel | `format=xlsx` | Main Data + Response Quality + About sheets |
| JSON | `format=json` | `{ version, columns, rows }`, for code |
| SPSS | `format=sav` | An SPSS system file with the dictionary as metadata |
| SAS | `format=sas` | A zip: transport file, CSV, and a `.sas` program |

All five export **the same columns in the same order**, because they are all
built from one shared matrix (`buildResponseMatrix`, in
`packages/exporters/src/statisticalExport.ts`): the system columns, then every
non-system variable in dictionary order. A client who opens the `.sav` beside
the `.csv` and finds different columns has two datasets and no way to tell
which one is the study, so a unit test asserts the column lists are identical.

## Codes, labels, or both

`values=code` (the default) · `values=label` · `values=code_label`

A survey stores a code. What the recipient wants in the file depends on who
they are: a data processor wants `2`, a client opening the spreadsheet wants
`Male`, and somebody reconciling one against the other wants `2 - Male`.

The parameter applies to **CSV, Excel and JSON only**. Three rules hold in
every mode:

- A value with no label in the dictionary is written unchanged — open text
  stays text, a number stays a number. Label mode does not mean "blank where
  there is no label", and an age of 42 must not become the string "42", or
  Excel stops summing the column.
- The column count and row count never change.
- A multiple response keeps its per-option `VAR_<code>` 0/1 columns, so label
  mode gives `Selected` / `Not selected` rather than bare ones and zeros
  sitting beside labelled columns. Where a column does hold a list of codes,
  CSV and Excel join with `|` and JSON keeps it a list.

Omitting the parameter, or passing something unrecognised, gives codes — the
file every existing client script was written against. A mistyped parameter
must not silently change what somebody receives.

### Why SPSS and SAS ignore it

In a statistical file the code **is** the value and the label is a property of
it. Writing `Male` into a `.sav` cell would turn a nominal variable into a
string one and cost the recipient every frequency, crosstab and recode the
format exists to support. So those two formats always carry codes, with the
labels attached as metadata — which is what makes `FREQUENCIES GENDER.` print

```
    1  Male                412
    2  Female              388
```

from a file that contains only `1` and `2`. The Studio does not offer the
choice on those buttons, because offering it would promise something the
format does not do.

## SPSS (`.sav`)

Hand-written (`packages/exporters/src/spss.ts`) — uncompressed, little-endian,
and it carries:

- variable names, including names past 8 characters via the 7/13 long-name map
- variable labels (the question text)
- value labels
- user-defined missing values
- measurement level (nominal / ordinal / scale)
- string variables of any width, via continuation records

### The two traps in this format

Both were live defects, both produced a file that opened cleanly and was
wrong, and both now have a test that fails if they come back.

**Value labels are attached by dictionary slot, not by variable.** A string
wider than 8 bytes occupies a head record plus one continuation record per
extra 8 bytes, and the 1-based index in the type-4 record counts *every*
record. Count only the variables and a question's labels land on whatever
variable happens to sit at that position.

**The long-name map is tab-separated and must not be sanitised.** The writer
ran it through the ASCII sanitiser that every other string goes through,
which replaced the tab with a space, merged every entry into one, and gave
the first variable a name built out of the second one's mapping.

## SAS (`.xpt` + syntax)

There is no honest way to write a native `.sas7bdat`: the format is
undocumented, and a dataset SAS refuses to open — or worse, opens wrongly — is
more damaging than no dataset. So `format=sas` delivers a zip of what
suppliers actually ship:

```
CODE_responses.csv   the data
CODE.sas             reads the CSV, applies LABEL and PROC FORMAT value labels
CODE.xpt             SAS transport v5 — opens directly in SAS, R, Stata, Python
README.txt
```

Both data files are there on purpose, because the transport format has hard
limits the script does not: **names truncate to 8 characters, labels to 40,
and there is nowhere to put value labels at all.** Truncated names are made
unique (`Q1_SATISFACTION` and `Q1_SATISFIED` both truncate to `Q1_SATIS`, and
two columns with one name is a corrupt dataset). The `.sas` script carries the
full names, the full labels and a format for every code, so between the two
files nothing about the study is lost.

Transport files also store numbers as **IBM 370 hexadecimal floats**, not
IEEE. This is the one part that cannot be fudged: write IEEE bytes and every
number in the dataset is silently wrong rather than missing. The mantissa
needs 56 bits — past what a JS number holds exactly — so it is assembled as a
BigInt, and the conversion is tested to be exact across the range a survey
produces.

`.xpt` is ASCII-only, so accented characters are transliterated (`Café` →
`Cafe`) and anything without an ASCII equivalent becomes a space. The CSV in
the same zip is UTF-8 and keeps the original text.

## Verifying a change to either writer

Three layers, and the middle one is the one people skip:

```bash
pnpm --filter @rescript/exporters test      # reads the files back with our own decoders
node scripts/verify-statistical-exports.mjs # reads them back with pyreadstat
node scripts/data-export-test.mjs           # the Studio asks for the right file
```

The unit tests decode the output with readers written in the test file, which
catches structural mistakes but shares our assumptions: if we misread the
specification, the writer and the reader are wrong in the same direction and
agree with each other. `verify-statistical-exports.mjs` is the check against
that — pyreadstat is the ReadStat C library, which knows nothing about this
code. It needs Python:

```bash
pip install pyreadstat --break-system-packages
```

and it skips with a message rather than failing when that is not installed,
so it is not part of `pnpm test`. **Run it whenever either writer changes.**
Every real defect found while building these — the eaten tab, the
mis-indexed value labels, an 80-byte transport record written as 72 —
produced a perfectly plausible buffer of roughly the right size. Asserting
that a `.sav` is non-empty and starts with `$FL2` proves only that the first
four bytes were written.

## Deliberate limits

- **No native `.sas7bdat`**, for the reason above.
- **No Stata `.dta`** yet. It is a documented format and the dictionary this
  now builds would feed it directly, so it is a small addition if asked for.
- **The zip is stored, not compressed** (`packages/exporters/src/zip.ts`).
  Pulling a compression library in to archive three text files was not worth
  the dependency; `jszip` is in the tree but only as a transitive dependency
  of exceljs, and reaching for a package we do not declare is how a build
  breaks the day exceljs changes its own dependencies.
- **`values` does not reach the variable dictionary export**, which always
  lists codes and labels side by side — that is what a dictionary is.

---

# Variable management (phase 2)

Three properties describe how a variable should LEAVE the platform, and are
the researcher's to set because nothing in a questionnaire implies them. They
live on `VariableDef`, are stored as overrides in `def.variables`, and are set
on the Variables tab.

| Field | What it does |
|---|---|
| `missingValues` | Codes that mean "no answer" — 99 = Prefer not to say. Declared in the `.sav`, marked in the SAS syntax. |
| `exportName` | The column name in delivered files, when it should differ from the variable name. |
| `measure` | nominal / ordinal / scale — SPSS's measurement level. |

`missingValues` is the one that changes results: declared, a mean over the
variable excludes them instead of averaging the 99s in. The value still
appears in the data and is still readable — what changes is that the package
knows not to treat it as an answer. A code the variable's type cannot hold
(`"n/a"` on a numeric variable) is dropped rather than written, because SPSS
reads such a record back wrong.

`exportName` exists so a house standard can deliver `S1_GENDER` while the
logic keeps referring to `Q1`. It applies in **every** format — CSV, Excel,
SPSS, SAS — since a naming standard that held in four formats out of five
would be worse than not having one. Note the trap it creates: the writers look
up each row's value by the variable's name, so the rows have to be re-keyed to
the delivered name at the same time (`rekey`, in `statisticalExport.ts`).
Renaming for output without re-keying produces a file with the right columns,
the right labels, and no data in it.

## Renaming a variable

`packages/engine/src/variableUsage.ts`. `variableUsages(def, name)` finds
every mention; `renameImpact` says what would happen; `renameVariable` does it
or refuses with reasons. The Variables tab drives all three, so a rename
through the UI is checked exactly as hard as one through the API.

What gets rewritten automatically: the question's own `variableName`, a
calculation's `targetVariable`, structured condition `ref`s, `$question`
comparisons, `{{PIPE}}` tokens, calc expressions wherever they appear, and the
variable's own override row.

### The trap this mostly exists for

`getQuestionByCodeOrVar` resolves a stored reference against a question's
**id, code or variableName interchangeably** — and a new question gets the
same string for `code` and `variableName`.

So renaming `variableName` from `Q1` to `GENDER` usually breaks nothing *that
day*: every `ref: "Q1"` keeps resolving, through the code. Then somebody edits
the code, or a piped `{{Q1}}` is re-parsed where no question of that code
exists, and rules that have "worked" for weeks stop resolving. A rename tool
reporting "0 references affected" because everything still resolves is worse
than no tool. `renameImpact` reports this as `aliasedByCode` and the panel
offers to carry the code along.

### What it will not do

- **A variable whose name is also a calc function name** (`AGE`, `COUNT`,
  `TEXT`, `DATE` — the full list is `CALC_FUNCTION_NAMES`) is invisible to the
  expression scanner, which skips function names so `upper(X)` does not report
  `upper` as a variable. Renaming *onto* such a name is refused; renaming
  *away* from one is allowed, because that is the cure, but it warns that
  expressions need checking by hand. Found the hard way — the first test
  fixture was called `AGE` and the expression scan silently returned nothing.
- **A wildcard** — `sum(ALLOC_*)` never spells `ALLOC_A`, so renaming
  `ALLOC_A` changes what that sum captures without appearing in its text.
  Reported for review; there is nothing to rewrite.
- **Custom scripts** (`def.scripts[].code`) are arbitrary JavaScript, and a
  variable name can be assembled at runtime. Any substitution would be a
  guess, so a script mentioning the name **blocks** the rename.
- **Saved analyses** live in their own database tables, outside the
  definition. The engine cannot reach them, so the caller passes them in; when
  none are supplied the report says `analysesUnchecked` rather than implying
  it checked. Published report versions are frozen snapshots and are never
  rewritten.
- **Derived columns** cannot be renamed on their own — a matrix row's
  `Q1_R1` follows its parent, so the rename belongs on the parent.

Renaming onto an existing variable, another question's **code** (which would
make rules ambiguous), an embedded field, or a system column is refused.

## Verifying a change here

```bash
pnpm --filter @rescript/engine test        # usage index + rename
pnpm --filter @rescript/exporters test     # the delivery properties in the files
node scripts/verify-statistical-exports.mjs
node scripts/variable-management-test.mjs  # the panel is wired to the engine
```

The engine suite is deliberately **behavioural**: it renames, then re-evaluates
the survey's display logic and re-flattens the response, and asserts the
answers are identical. Counting usages proves the finder found things;
re-evaluating proves the rewriter wrote them correctly. Five deliberate
regressions were confirmed to turn it red — a missed condition `ref`, a missed
pipe, a search-and-replace that clobbers `RESP_AGE_BAND` while renaming
`RESP_AGE`, a dropped alias check, and a script allowed through.

---

# Naming templates (phase 3)

A study's variable naming convention, saved on the survey and applied to the
whole questionnaire. Teams already have these conventions; they keep them in a
Word document and apply them by hand, which is why names drift halfway through
fieldwork. Variables tab → **Naming standard**.

## Tokens

| Token | Gives |
|---|---|
| `{number}` | position in the survey; `{number:2}` pads to `01` |
| `{section}` | the page or block number |
| `{n_in_section}` | position within that section |
| `{code}` / `{question}` | the question code |
| `{variable}` | the name it has now |
| `{shortname}` | first two words of the question text; `{shortname:3}` for three |
| `{type}` | the question type |

Padding matters more than it looks: `Q1…Q10` sorts as Q1, Q10, Q2 in every
spreadsheet a client opens, and `Q{number:2}` fixes that.

Numbering follows the **flow**, not `def.questions` — that is the order a
respondent meets them and the order a researcher counts them in. An unknown
token is left visible (`Q{numbr}` stays `Q{numbr}`) rather than blanked, so a
typo fails loudly instead of naming every question `Q`.

## What a template controls

The pattern names each question's **base** variable. The engine composes the
derived columns from it — `Q3_1`, `Q3_R2`, `Q3_LAT` — and those suffixes are
fixed. They are spelled out inline at about sixty places in `variables.ts` and
mirrored, separately, in `flatten.ts`; a template that changed one spelling
and not the other would declare columns the runtime never fills, which is data
loss that looks like a clean export.

So the brief's `GRID{question}_{row}_{column}` is written as `GRID{number}` on
the grid question: the template supplies `GRID5`, the engine supplies
`_R1_C2`.

## Bulk rename is not a loop over single renames

Validation is on the **final state**. `Q1→Q2` while `Q2→Q3` is perfectly valid
as a whole and would be rejected by any per-step "that name is taken" check —
which is exactly what `renameVariable` applies. Hence `planTemplateRename`.

Order then matters: `orderRenames` puts the steps in a sequence where nothing
is ever renamed onto a name still in use, and breaks cycles (a straight swap
`A→B, B→A` has no safe order) by parking one variable on a temporary name —
the same trick a register allocator uses. Each step still goes through
`applyRename`, so the template chooses names and does not reimplement renaming.

## The everyday rename fields

`VariableNameInput` now backs both the question editor's **Variable name** and
the calculation editor's **target**. Both previously wrote straight into the
definition on every keystroke, so renaming there left every rule and pipe
naming the old variable — and mostly still resolving, through the question
code, until the code was edited weeks later. The safe rename existed after
phase 2 but only the Variables tab used it, which is the worst arrangement
available: the careful path present, and the path people take going round it.

Two details that were bugs first:

- it holds a **local draft** and commits on blur or Enter, because a rename
  per keystroke rewrites the survey once per character and `GENDE` is a rename
  as far as the engine is concerned;
- `commit` re-reads the value from the field and recomputes the impact rather
  than using the memo, because `onBlur` fires with the previous render's
  closure. Type a name and tab straight out and the handler could still be
  holding `dirty: false`, in which case it reset the box and reported nothing.

## A collision check that looked right and was not

`renameImpact` originally checked the new name against
`buildDerivedVariables`. That misses a whole class of name: **a question's
`variableName` is not always a column.** A multi-select called `BRANDS`
produces `BRANDS_1`, `BRANDS_2` and no bare `BRANDS`, so renaming another
variable onto `BRANDS` passed, applied, and left two questions owning one
name. The browser suite caught it as a definition reading
`["V2", "V2", "V3"]`.

There are now two guards, and both are needed:

1. the namespace check covers everything that **owns** a name — dictionary
   columns, every question's `variableName`, every calculation target,
   embedded fields, system columns;
2. the result is rebuilt and checked for **duplicate column names**, which
   catches collisions no comparison of base names can see. `FOO_1` is a text
   question's column; `BAR` is a multi-select producing `BAR_1`. Nothing is
   called `FOO`, so renaming `BAR → FOO` passes every name-level check and
   produces a second `FOO_1`.

## Verifying a change here

```bash
pnpm --filter @rescript/engine test        # templates, ordering, rename
node scripts/naming-templates-test.mjs     # the panel, and the two rename fields
```

Every guard above has a test that was confirmed to fail when the guard was
removed — including the two that were originally decorative: the expression
boundary test passed with a naive search-and-replace until the fixture put
`RESP_AGE` and `RESP_AGE_BAND` in the same expression, and the result-duplicate
check passed with the check deleted until a case was written that the
namespace check could not already catch.

## Still to come in §44

Saved data-export presets, and the generated data dictionary shipped alongside
the statistical exports.
