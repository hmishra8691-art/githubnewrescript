import { compileFlow } from "./flow.js";
import { registerListFillStepLocator } from "./listFill.js";

/**
 * METHOD-09 wiring. `pendingListFills` needs to know whether the page that
 * carries a List Fill's source question has been reached; that is a question
 * for the compiled flow, and flow.ts already imports listFill.ts, so the
 * lookup is registered from here instead of imported there (the same pattern
 * loops.ts uses). The engine's entry point imports this module, so every
 * runtime, server route and simulator gets it.
 */
registerListFillStepLocator((def, state, questionId) =>
  compileFlow(def, state).findIndex((st) => st.kind === "page" && st.questionIds.includes(questionId)));
