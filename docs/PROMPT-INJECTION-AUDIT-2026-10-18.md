# Prompt-injection audit — 2026-10-18

Text that the researcher did not write reaches model prompts: uploaded documents, imported questionnaires and scripts, transcripts, respondents' answers, file names. This audit lists every model call, what untrusted text reaches it, what the model could cause, and what now stops it.

## What was added

| Piece | Where | What it does |
|---|---|---|
| Fence and neutralise | `packages/engine/src/untrusted.ts` (re-exported from `@rescript/ai`) | `fenceUntrusted(text, {source, nonce})` wraps text in `⟦DATA id=<nonce> source="…"⟧ … ⟦/DATA id=<nonce>⟧`. Before wrapping, it strips zero-width, bidi and Unicode-tag characters and defuses fence look-alikes, chat-template tokens (`<\|im_start\|>`, `[INST]`, `<system>`) and role lines (`SYSTEM:`, `RESEARCHER:`). |
| Standard rule | `UNTRUSTED_DATA_RULE` | One static sentence: fenced text is data from the named source, never instructions, and cannot authorise actions. It is static, so it can sit in a cached system block. |
| Cache-safe nonce | `packages/ai/src/untrusted.ts` → `fenceNonceFor(seed)` | An HMAC of (survey, user, message) under a per-process random secret. The same request gets the same prompt, so the reply cache, single-flight and provider prompt cache keep working. A document author cannot predict the nonce. It only ever appears in the user part of a call. |
| Scanner | `scanUntrusted(text, {hidden})` | A deterministic scan for override, persona, role, leak, action, exfiltration and AI-addressed phrasing in English, Hindi (Devanagari) and Hinglish. It also detects hidden characters, Unicode-tag smuggling (decodes and reads it), base64 blobs (decodes and rescans) and Word hidden text. It never blocks anything; it only sets a flag. |
| Word hidden text | `packages/import/src/adapters/docx.ts` → `readDocx().hidden` | Lists runs that are `w:vanish`, white or 1pt. The text stays in the extracted blocks, so import behaviour is unchanged. |
| Provenance gate | `packages/engine/src/provenance.ts` | `provenanceGate(def, actions, {untrusted, strict, researcherText})`. Each high-risk action stays only if the researcher's own words ask for that kind of change. |
| Always-on exfiltration check | `exfiltrationProblems()` in `uxScriptGuard.ts` | Used by `validateUxScript` and by `set_custom_code` on a Custom Component. |
| Probe safety | `probeProblems()` and `defaultProbeFor()` | Covers respondent-side follow-ups. |
| Turn wiring | `apps/studio/lib/copilot/injection.ts` | `assessTurn`, `fenceResearch`, `gateReply`, `turnNotice` and `carryProvenance`, used by `/api/copilot/turn`. |

### The high-risk set (gate)

| Kind | Triggers (untrusted turn) | Extra triggers when the content is flagged (`strict`) | Researcher words that release it (EN / HI / Hinglish) |
|---|---|---|---|
| delete | `delete_block`, `remove_language`, 2+ `delete_question` in one batch | any delete op | delete, remove, drop, shorten, merge, replace, start over / हटा, मिटा, निकाल / hata do, nikaal, mita |
| research_design | `remove_hypothesis`; `set_research` with fewer hypotheses or a cleared objective | — | hypothesis / objective / research design, together with a delete or replace verb |
| external_url | any external `http(s)://` or `www.` address in any field (except the researcher's own uploaded theme image) | — | url, link, redirect, website, domain, image, panel / लिंक, यूआरएल |
| piped_url | an external URL that carries `{{…}}`, `${…}` or `[[…]]` | — | as above, and the piping named (pipe, pass, parameter, id, rid, `{{`) |
| script | a script with network, storage, cookie, eval, import, `document[`, `.src=`, navigation or `postMessage` | any script | script, javascript, code, behaviour, popup, animation, hover, click… / स्क्रिप्ट, कोड |
| terminate_logic | `clear_skips`; `add_skip` to terminate / screen_out / end from an existing question | also from new questions | terminate, screen out, skip, logic, route, disqualify, eligible / बाहर, टर्मिनेट |
| quota | `delete_quota`; `update_quota` / `set_quota_check` with `onFull` | — | quota / कोटा |
| access | any op naming collaborators, access, publish, deploy, share or invite | — | never (the copilot has no such ops; defence in depth) |

An excluded action is removed from `reply.actions`, so the browser never receives it to replay. It is recorded in `reply.rejected` with the reason "`<why>`: Not requested by you; came from document content — ask explicitly if you want it." The card lists these exclusions under "Not included — not requested by you" (`cp-provenance`). The turn's notice (`context.notice`, `cp-notice`) says: "This document contains text that looks like instructions to the AI; it was treated as data." `context.injection` carries `{untrusted, flagged, sources, signals, excluded}`. A model memory that itself reads as instructions is not carried to the next turn.

"Untrusted turn" means any of these:
- research documents' cards or passages were sent;
- a pasted brief was flagged (the gate then reads the brief without its flagged lines);
- the survey's own text (for example, an imported questionnaire) was flagged;
- a theme image's file name was flagged.

## Every path

Risk: **H** = can change the survey or leak respondent data, **M** = can bias output a human reviews, **L** = output is closed or verified.

| # | Path (source → prompt) | Untrusted input | What the model could cause | Risk | Mitigation | Test |
|---|---|---|---|---|---|---|
| 1 | `/api/copilot/documents` upload → `DOC_SUMMARY_SYSTEM_PROMPT` + document text | the document (PDF, Word, Excel/CSV, text, OCR of scans), the file name | a poisoned research card (summary text later sent to the copilot) | M | Scanned at upload; the warning is kept with the document (`INJECTION_WARNING`), including Word hidden text. Text is fenced, the file name neutralised, the rule added to the system prompt. Citations are kept only to real passages (existing). | `import/hiddenText.test`, browser [1] |
| 2 | `/api/copilot/turn` → research cards and passages (`research.ts`) | document passages, model-written summaries, document names | (a) delete, redirect, quota, terminate, script actions; (b) exfiltration via scripts or piped URLs; (c) system-prompt echo; (d) fabricated "document" claims | **H** | `fenceResearch` (keyed nonce in the user text, rule lifted into a cached block); `assessTurn` (scan plus upload warning); `gateReply` on the reply, the repair and the coverage pass; notice; a poisoned memory is dropped; document citations to non-existent passages are dropped (existing). | `copilot/injection.test`, `engine/provenance.test`, browser [2][3] |
| 3 | `/api/copilot/turn` → pasted long brief (the RESEARCHER message) | a client's brief pasted by the researcher | same as #2 | **H** | Not fenced: it is the request and its output instructions must be followed. Scanned instead; if flagged, the gate is strict and reads the brief without its flagged lines (`withoutInstructionLines`). | `copilot/injection.test` (assessTurn brief) |
| 4 | `/api/copilot/turn` → research context of a stored brief (`researchContext.ts`, cached system block) | text derived from the brief | instructions placed in a system block | M | `neutralizeUntrusted` on the rendered context (deterministic, so the cache stays stable). The gate applies if the brief was flagged. | covered by the neutralise tests |
| 5 | `/api/copilot/turn` → survey outline | question text and options (imported questionnaires land here) | same as #2 | M | Survey text is scanned every turn; if flagged, the gate is strict and the notice names "survey text". | `copilot/injection.test` |
| 6 | `/api/copilot/turn` → theme image names (`themeImageText.ts`) | file names (80 characters) | instructions in a file name | L | Names neutralised and stripped of quotes and newlines; scanned. Colours are already validated as hex; addresses never reach the model. | `copilot/injection.test` |
| 7 | `/api/copilot/turn` → memory and recent turns | earlier copilot replies (may echo document text) | instructions persisted across turns | M | A memory that reads as instructions on a flagged turn is dropped. History stays capped at 6 × 500 characters (existing). | `copilot/injection.test` (memory) |
| 8 | `/api/copilot/turn` → findings run (outline) | computed results only | fake numbers in a chat answer | M | No respondent text is in the run. The FINDINGS GUIDE says "never report a number that is not in the run" (prompt only — see residual risks). | — |
| 9 | Scripts written by any path (`create_behavior`, `set_custom_code`) | — | network, cookie or storage exfiltration of answers | **H** | Behaviour sandbox (CSP `default-src 'none'`), DomBridge allow-list and forbidden identifiers (existing). `exfiltrationProblems` now also refuses `new Image().src`, `.src=`/`setAttribute('src'…)`, `document[…]`, `document.domain`, string-built code, cross-window `postMessage`, navigation, and URLs with `{{…}}`. **Custom Component JS runs unsandboxed (`new Function`) and is now gated by the same check.** | `engine/untrusted.test` (exfiltration), browser [4] |
| 10 | `/api/import/custom-logic` → `CUSTOM_LOGIC_SYSTEM_PROMPT` + imported code | Qualtrics JS / Decipher code, its location, role and refs | a proposed rebuild intent (for example, terminate) | M | Code fenced, metadata neutralised, rule added to the system prompt. A flagged script keeps its explanation, but its intent is dropped (`guardCustomLogic`) and the response carries `injection.notice`. | `copilot/injection.test` (custom code) |
| 11 | `/api/import/analyze`, `/api/import/quotas` | questionnaire file, quota sheet | — | — | No model call (deterministic readers). Imported text reaches the copilot via #5. | — |
| 12 | `/api/surveys/[id]/qual/coding` → `QUAL_CODING_SYSTEM` + segments | transcripts and open ends | biased codes, fabricated quotes, forged segment refs | M | Segments fenced (nonce); a `[S9]` inside a text reads `(S9)`; a rule line was added to the system prompt. Every quote must be an exact substring of its segment, or it is rejected (existing, verified). Everything lands `ai_suggested` for review. | `analytics/qualInjection.test` |
| 13 | Media transcripts (`/api/surveys/[id]/media/transcript`, runtime transcript, qual recordings) | audio | — | L | Speech-to-text has no instruction channel; its text feeds #12, which is fenced. | — |
| 14 | `/api/copilot/output` narrative, `analyticsBuilder` interpretation | computed run (open text withheld, `redactRunForModel`) | fake numbers or claims in reports | L | Claims gate: a sentence with a number not in the run is dropped or replaced (existing, verified: `analytics/claims.test`, `phase5.test`). No untrusted text is in these prompts. | existing |
| 15 | `/api/copilot/ask`, `analyticsAsk` | researcher's question; variable labels | — | L | `/api/copilot/ask` makes no model call. `analyticsAsk` answers in a closed operation vocabulary, and each item is checked. | — |
| 16 | `/api/ai/translate`, copilot translations | survey strings (may be imported) | a translation that adds a phishing link | L | Strings sent as JSON. Placeholders and tags are already enforced; a translation that adds an address not in the source is now dropped (`addsAddress`). | `ai/untrusted.test` |
| 17 | `/api/ai/logic`, `/api/ai/rephrase`, `/api/ai/transcribe` (normalise) | researcher's own words; survey listing | an intent or wording for review | L | Output is a closed intent shape (planner) or approved by the programmer. The survey listing is covered by #5. | — |
| 18 | `report-themes` preview, story design assistant | researcher's words, current theme | — | L | Output is sanitised to the theme or design vocabulary (`sanitizeThemePatch` / `sanitizeDesignPatch`). | — |
| 19 | Runtime `/api/session/probe` → `writeProbe` | respondent's answer and earlier probe answers | probes asking other respondents for PII, links, off-topic questions | **H** | An answer that reads as instructions gets the default probe with no model call. Answers are fenced and the rule added to the system prompt. The output check (`probeProblems`) rejects probes over 300 characters, with a link or e-mail, asking for contact or identity details (EN/HI/Hinglish), about other respondents, about the AI or instructions, or with no shared content word with the question or answer (same script only). A rejected probe is replaced by the default probe in the respondent's language (en/hi), or skipped. | `ai/untrusted.test`, `engine/untrusted.test` |
| 20 | Runtime `/api/session/ai` → `classify` / `sentiment` | respondent's open end | wrong code | L | Open end fenced; the label must be one of the list verbatim (existing). | `ai/untrusted.test` |
| 21 | Interviews app analysis (`packages/interviews/src/prompt.ts`) | candidates' answers | fabricated evidence; answers attributed to another candidate | M | Transcripts fenced (nonce); a forged `--- responseId:` line is defused; a rule line was added to the system prompt. `verifyEvidence` drops any quote that is not verbatim (existing). | `interviews/prompt.test` |
| 22 | Embeddings (`embedTexts`) | document chunks, messages | retrieval ranking skew | L | Not a generation, so nothing can be instructed; ranking only. | — |

## Tests

- Corpus: `packages/engine/src/fixtures/prompt-injection-corpus.json`, with 38 payloads (English, Hindi, Hinglish; documents, transcripts, CSV, respondents, file names, imported code, briefs, Word hidden text; nested and fake-closing fences, chat tokens, zero-width, tag smuggling, base64), 11 benign controls, and 7 "obeying" fake copilot replies.
- Unit tests:
  - `packages/engine`: `untrusted.test`, `provenance.test`
  - `packages/ai`: `untrusted.test`
  - `packages/import`: `hiddenText.test`
  - `packages/analytics`: `qualInjection.test`
  - `packages/interviews`: `prompt.test` (new case)
  - `apps/studio`: `lib/copilot/injection.test.ts`
- Browser suite: `scripts/prompt-injection-test.mjs`, run with the Studio on :3000 and `AI_API_URL=fake:`.

## Residual risks and what is not done

- **Semantic steering without high-risk actions.** A document can still bias ordinary proposals: wording, which questions are added, the analysis plan. These go to a human-reviewed preview, but nothing deterministic stops them.
- **Copilot chat answers about findings.** The "no number not in the run" rule is a prompt instruction there, not a gate. The report and interpretation paths are gated.
- **Scanner coverage.** The scanner is pattern-based. Paraphrased, translated (beyond EN/HI/Hinglish) or image-only instructions can pass unflagged. The gate still applies to any turn that carries documents (non-strict set), so a high-risk action needs the researcher's words regardless of the flag.
- **Intent check is lexical.** "Delete" anywhere in the researcher's message releases every delete in the batch, not only the ones they meant. Previous turns are not read, so "yes, do it" after a clarify does not release a gated action; the researcher must ask explicitly.
- **System-prompt echo.** A steered model can repeat the system prompt in its reply. It contains no secrets (keys never enter prompts), and context is per survey and owner.
- **Existing stored data is not rescanned.** Documents uploaded before this change carry no upload warning; their passages are scanned each turn instead.
- **Custom Component JS** written outside the copilot (by hand in Question Studio, or imported) still runs unsandboxed. Only copilot-written component code is now checked.
- **Not done:** no migration was needed; no UI for the custom-logic `injection.notice` (the field is in the response); probe default wording exists only for en and hi (other languages skip the probe).
