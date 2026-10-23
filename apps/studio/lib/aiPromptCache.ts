import { COPILOT_ANALYSIS_GUIDE, COPILOT_FINDINGS_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_SYSTEM_PROMPT, COPILOT_TRANSLATION_GUIDE, COPILOT_UX_GUIDE } from "./copilot/prompt.ts";
import { COPILOT_LIST_FILL_GUIDE } from "./copilot/listFillGuide.ts";
import { COPILOT_METHODS_GUIDE } from "./copilot/methodsGuide.ts";
import { COPILOT_QUAL_GUIDE, COPILOT_RESEARCH_GUIDE } from "./copilot/researchGuide.ts";
import { COPILOT_AI_INTERVIEW_GUIDE } from "./copilot/aiInterviewGuide.ts";
import { COPILOT_INTEGRATIONS_GUIDE } from "./copilot/integrationsGuide.ts";
import { REPORTING_GUIDE } from "./copilot/reportingGuide.ts";

/**
 * THE STABLE PREFIX OF A COPILOT CALL (AI cost audit, 2026-10-17).
 *
 * `copilotUserPrompt` puts the guides a request needs (the UX guide for a
 * behaviour or JavaScript request, ~20k characters; the analysis, translation,
 * quota, List Fill, methods and findings guides) AFTER the survey outline, the memory
 * and the recent turns — so the only text a provider's prompt cache could
 * reuse between two calls was the system prompt. Moved in front, as system
 * blocks, the guides are the same bytes on every call that needs them and are
 * read from the cache at ~10 % of the input price (Anthropic) or ~50 %
 * (OpenAI), instead of paid in full every time.
 *
 * Nothing is rewritten: each guide is lifted out of the text whole (with the
 * blank line that separated it) and sent, unchanged, as the second system
 * block; the rest of the text keeps its order. A guide that is not in the
 * text is not sent. If the prompt's wording ever changes so that a guide is
 * no longer found verbatim, the call simply carries it in the user text, as
 * before — correct, only not cached (`aiPromptCache.test.ts` watches for it).
 */

/** the guides, in the order `copilotUserPrompt` adds them */
export const COPILOT_STABLE_GUIDES: readonly string[] = [COPILOT_UX_GUIDE, COPILOT_ANALYSIS_GUIDE, COPILOT_TRANSLATION_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_LIST_FILL_GUIDE, COPILOT_METHODS_GUIDE, COPILOT_FINDINGS_GUIDE, COPILOT_RESEARCH_GUIDE, COPILOT_QUAL_GUIDE, COPILOT_AI_INTERVIEW_GUIDE, COPILOT_INTEGRATIONS_GUIDE, REPORTING_GUIDE];

/** Lift each of `guides` found verbatim in `text` out of it: the guides found (in the list's order) and what is left. */
export function splitStable(text: string, guides: readonly string[]): { stable: string[]; variable: string } {
  let variable = text;
  const stable: string[] = [];
  for (const g of guides) {
    if (!g) continue;
    const i = variable.indexOf(g);
    if (i < 0) continue;
    const before = variable.slice(0, i), after = variable.slice(i + g.length);
    variable = before.endsWith("\n\n") ? before.slice(0, -2) + after : after.startsWith("\n\n") ? before + after.slice(2) : before + after;
    stable.push(g);
  }
  return { stable, variable };
}

/**
 * The system blocks and the user text of one copilot model call:
 * `[[COPILOT_SYSTEM_PROMPT, the extra stable blocks, the guides it carries], the rest]` — spread as the
 * first two arguments of the model call (`...copilotCall(text)`).
 *
 * ORDER (2026-10-22, engine weakness #11): the blocks run from the most to the least stable, because a provider's
 * cache is a PREFIX cache (Anthropic writes and reads at each block boundary; OpenAI caches the longest common
 * prefix). The research context of a stored brief and the installation's availability note are the same bytes on
 * every call of a build and every turn of a session; the guides change with what a request (or a plan item) needs.
 * So: the system prompt, then the extra blocks, then the guides — a change of guides re-writes only the guides.
 * With `core` (a staged item): the guides every item of the build carries are one block and this item's own
 * guides another, so items that need different guides still read [system, context, core] from the cache.
 */
export function copilotCall(userText: string, extraStable: readonly (string | undefined)[] = [], opts: { core?: readonly string[] } = {}): [readonly string[], string] {
  const { stable, variable } = splitStable(userText, COPILOT_STABLE_GUIDES);
  /*
   * §3 (2026-10-18): the research context of a stored brief (and the installation's availability note) are the
   * same bytes on every item of a build — a cached block of their own (Anthropic caches up to 4 breakpoints).
   * Lifted verbatim, like the guides; absent from the text = not sent.
   */
  const extra = splitStable(variable, extraStable.filter((x): x is string => !!x && x.length > 0));
  const blocks: string[] = [COPILOT_SYSTEM_PROMPT];
  if (extra.stable.length) blocks.push(extra.stable.join("\n\n"));
  if (opts.core) {
    const core = stable.filter((g) => opts.core!.includes(g)), own = stable.filter((g) => !opts.core!.includes(g));
    if (core.length) blocks.push(core.join("\n\n"));
    if (own.length) blocks.push(own.join("\n\n"));
  } else if (stable.length) blocks.push(stable.join("\n\n"));
  return [blocks, extra.variable];
}
