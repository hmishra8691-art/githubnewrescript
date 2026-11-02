# Word corpus (synthetic)

Built by `scripts/word-corpus-build.mjs`; expectations in `packages/import/src/i8Corpus.test.ts`.

- **01-simple.docx** — a short questionnaire: headings, numbered answers, an open end, a scale
- **02-complex-instructions.docx** — readable logic: ASK IF, TERMINATE IF, SKIP TO, RANDOMIZE … EXCEPT, a hidden variable, a programmer note
- **03-tables-nested.docx** — a grid written as a table, a table with a nested table in a cell, an image with alt text
- **04-contradictory.docx** — instructions that contradict each other (ASK IF and SKIP on the same question) and a skip to a question that does not exist
- **05-missing-information.docx** — instructions without a condition or target, a question with no answers, a reference to an unknown question
- **06-poorly-formatted.docx** — no styles, inconsistent numbering, answers on lettered lines, stray blank paragraphs, mixed case instructions
- **07-large.docx** — a long questionnaire (150 questions in 10 sections) with a display rule every fifth question
- **08-carry-forward-masking.docx** — carry forward of selected options, masking (not selected), a list carried from a carried list, the same list as an earlier question, codes kept
- **09-loops-piping.docx** — a loop over the brands selected (two questions), the current brand piped, an answer piped into later text, a numeric answer piped, a carried list piped
- **10-informal-instructions.docx** — the same behaviours written informally: previous question, mask out, use the same list, repeat for every brand, pipe in — and one instruction no rule reads
