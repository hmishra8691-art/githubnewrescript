# Logic compatibility audit — Display, Validation and Masking

Three master test questionnaires arrived together (Display Logic ~137 test
questions, Validation V001–V140, Masking M001–M160) with a brief that made the
documents the source of truth and the implementation the thing under test:
find every scenario that does not work, name the exact reason, and remove the
restriction unless it is genuinely necessary.

The 437 scenarios deduplicate to **152 distinct capabilities** — most scenarios
exercise one capability with different content. Five parallel code sweeps
audited those against source, and everything they marked uncertain (plus
everything they marked *working*) was then driven through the real engine.

**Result: 14 defects found and fixed, 23 gaps left open with a named cause.**

The headline finding is not the count. It is that **nine of the fourteen were
silent wrong answers** rather than missing features — a control the builder
offered, that saved cleanly, appeared in the JSON, and then evaluated to the
wrong thing at runtime with nothing on screen to say so. That is precisely the
failure mode the brief's "do not assume something is supported just because the
UI has an option for it" was pointing at, and it justified the cost of driving
every claim through the engine instead of reading the code.

## The two that were losing data

**A hidden question could screen a respondent out.** `firstTriggeredSkip`
iterated `step.questionIds` — the page's *authored* questions — while
`visibleQuestions` did the filtering fourteen lines above it. A question hidden
by display logic has no answer, so a perfectly ordinary rule
(`Q2 unanswered → terminate`) fired for exactly the respondents for whom Q2 was
correctly hidden. Reproduced against the compiled flow engine before touching
it: `{"endStatus":"screened","skips":["q2"]}` on a question that never
rendered. Fixed by having skip logic iterate `visibleQuestions` — the same
function display logic uses, rather than a second idea of what "on the page"
means.

**Masking every option away produced an unanswerable blocking page.** When a
mask, carry-forward or List Fill resolved to nothing, the question stayed on the
page with an empty list and `required` still enforced. The respondent was told
to answer and given nothing to answer with, and could not proceed. Fixed with
`hasNoAnswerableItems`, which compares the *effective* view against the
*authored* question — so a question that never had items (open text, numeric,
date) keeps its ordinary requiredness, and only one that had items and lost them
all is exempt. That single guard covers M156 (empty source), M157 (zero rows)
and M158 (zero columns). A test asserts the suppression stays narrow: ordinary
required questions on options, text and matrix all still block.

## The one that made the last feature unreachable

Condition-tree validation — the work of the immediately preceding brief — is
implemented in the engine for every question type. It could not be selected in
the UI for any question carrying a variant, which is every new question, because
the properties panel offers exactly the kinds a variant's `validations` array
declares and **no variant declared `condition`**. Switching variants also
*deleted* any such rule already saved.

The per-variant lists are the right idea for characteristic kinds
(`min_selections` belongs to multi-select, `min_length` to text). They are the
wrong shape for kinds that are type-agnostic in the engine. `UNIVERSAL_VALIDATIONS`
(`required`, `condition`, `custom_expression`, `custom_script`) is now declared
once and unioned in by `allowedValidationKinds`, instead of being restated a
hundred times and forgotten once.

Worth recording as a pattern: this is the fourth hand-maintained duplicate list
found in this codebase, and the third that had already drifted. The others this
pass were the auto-punch multi-value list (omitted `image_select`, and named
three types that do not exist — so punching an image question *overwrote the
respondent's whole selection with one code*), the response filter's scalar-type
list (claimed `image_select` was scalar, so a filter on it emitted a containment
test that could never match **and** suppressed the engine pass that would have
got it right), and the expression parser's copy of the function names, which had
fallen behind by the entire date family. All four now derive from one source.

## Capability families opened up

**Date and time arithmetic did not exist.** Thirty-four functions, none that
understood a date, so ten validation requirements (V041–V050) had no expressible
form at all: age on the day of the survey, no future dates, expiry, end-after-start,
and both relative windows. Added `TODAY`, `AGE`, `DATEDIFF`, `DATEADD`, `DATE`,
`YEAR`, `MONTH`, `DAY` to the shared function table, so a calculation, a display
condition, a mask and a validation rule spell them identically. Ages are
calendar-aware (birthday-sensitive, not `/365`) and compared as UTC whole days,
because a survey is answered in every timezone and an age that flickers by hour
of day is a worse bug than the one being fixed.

**Comparing one question against another was silently impossible.** Every
right-hand side was a literal, so the obvious spelling — pick Q5, pick `>`, type
`Q6` — compared Q5 against the two characters "Q6" and was false forever. This
one gap blocked confirm-email (V022, V112), end-after-start (V045), min-vs-max
(V084), subset and empty-intersection (V068, V069), dynamic exact count (V070),
sum-within-budget (V082), and `Q94 != Q90` in the display document. Closed with
`QuestionValueRef` (`{ $question: "Q6" }`), resolved through the *same*
`resolveSourceValue` the left-hand side uses so both sides of a rule agree about
what naming a question means. Wired end to end: schema, evaluator, expression
parser (a bare word that resolves to a question is promoted; a quoted one stays
a literal), expression printer (so `Q5 > Q6` round-trips to itself), the
dependency graph, and a value-mode toggle in the visual builder.

**Every time-of-day comparison was false.** A `time` question stores a bare
clock value and the date parser rejected it outright, so "between 09:00 and
17:00" — the only thing a time question exists to be asked — never matched.
Clock times now parse, and `comparableOperands` puts the operands of the five
ordering operators on one scale, so `>`, `<`, `>=`, `<=` and `between` work on
dates and times as well as numbers. Deliberately all-or-nothing: `Date` reads a
bare "5" as a date, so a partly-numeric comparison stays null rather than making
`someDate > 5` true for every date ever entered. (That one was caught by a test
asserting the *negative* case, which is why it is worth writing those.)

**Matrix cell validation was accepted and discarded**, from both directions. A
matrix answer is an object keyed by row, so a question-level `min_value` was
handed the whole object — `Number({…})` is NaN, rule passes — while the panel
went on offering min/max for `matrix_numeric`. Per-row rules failed the other
way: the canvas wrote `row.validation` for any matrix and only `text_list` /
`numeric_list` ever read it back. Both now run the same `checkScalarRules` per
cell that every other shape uses, over *visible* rows only, which is also what
V099 asks for.

**Matrix column conditions never matched.** Naming a column without a row
indexed a row-keyed map by the column id and always found nothing, while the
builder offered the column picker. A column with no row now means "this column
across every row" — the natural reading, and the one the display document asks
for ("any row rated Often or Always"). The three matrix shapes are handled
distinctly, which matters: a single-response row stores the column it *chose*,
so only rows that chose it count. Treating them uniformly would have made "any
row rated Excellent" true the moment any row was rated at all.

## Deliberately not built

- **A second condition language, anywhere.** Every fix reuses the one
  `Condition` tree, the one evaluator and the one `ConditionEditor`.
- **A dedicated validation kind per requirement.** `exact_length`, `charset`,
  `no_html`, `zip`, `url` and the rest are all reachable through `pattern`
  today. Adding ten kinds would be ten evaluator cases and ten more entries in
  every variant list — the exact shape of the bug described above.
- **Coercion to make mixed comparisons "work".** A date against a number stays
  false. Silently comparing a timestamp to 5 is the kind of helpfulness that
  produces a rule nobody can debug.

## Left open, with cause

Removable restrictions (no new mechanism needed): always-show protection is
coupled to the empty-source fallback, so a protected "Other" survives or not for
a reason the author never chose; `preselect` and `disable` mask actions are
stored, authored and exported but applied by nothing; the masking source picker
hides scalar questions the engine reads fine; the operator allow-list raises
*hard lint errors* on rules the evaluator handles (numeric comparison of a
matrix cell, `contains` on a ranking); nested-loop masking is blocked by one
missing `scope` field that conditions already have; the `when` gate has no
editor; ranking selection bounds are offered by one panel and denied by another;
column masking records no debug trace.

Genuine gaps (these need building): cell-level masking; iteration history
("hide items used in earlier iterations"); aggregates across loop iterations;
**a predicate leaf in the set language** — one schema node that would turn
numeric-band, text-match and expression-driven masking from workarounds into
first-class masks, and the highest-leverage remaining item; rank uniqueness;
recording the randomised-block assignment as a variable; a flow-position source;
live validation clearing (the dependency graph needed for it already exists and
is simply not wired to validation).

One is a decision rather than code: **answers to questions that later become
hidden are retained and exported.** There is no clear-on-hide policy and no
setting for one, so a data file can contain answers the respondent's final path
says they never saw.

## Tests

`packages/engine/src/logicCapabilities.test.ts` (new, 20 cases) pins every fix
as a fast unit test rather than a browser one — each reproduces in the engine
alone, so a regression is caught in seconds instead of in a 36-minute corpus.
It covers both directions throughout: the hidden question's skip rule must not
fire *and* a visible one's must; the emptied mask must not block *and* ordinary
required questions must.

Engine suite 771 → **791, all passing**. Full monorepo typecheck, build and test
clean across all twelve projects. Targeted browser suites over the changed
surfaces (validation conditions, count logic, logic builder, save integrity,
option logic, matrix auto punch, masking) all green, plus the full 61-suite
corpus.

### Environment note, again

The background dev servers and the corpus runner were both reaped mid-run by the
sandbox — the corpus died silently at 24/61 with no failure logged, which reads
exactly like a hang. Check liveness with a `/proc` scan (`ps aux` does not see
these processes here) rather than trusting the log's last line, and do not run a
package build while the corpus is running: the dev servers recompile underneath
it.
