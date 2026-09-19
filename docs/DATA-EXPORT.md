# Data export — statistical formats and the code/label choice

§44, phase 1. What a response dataset can be downloaded as, and what each
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

## Still to come in §44

Phase 1 is the formats and the code/label choice. The rest of the brief:
a variable management interface (editable name, export name, data type,
missing values), variable naming templates, automatic variable mapping with
rename-impact checking, saved export presets, and the generated data
dictionary alongside the statistical exports.
