import "server-only";
import type { Deps } from "./service";
import { AiInterviewError } from "./service";
import type { SessionRec, StudyRec } from "./types";

/** the interview behind a resume token, for the voice, speech and media routes; `live` = still in progress */
export async function interviewFor(deps: Deps, token: unknown, opts: { live?: boolean } = {}): Promise<{ session: SessionRec; study: StudyRec }> {
  const t = String(token ?? "");
  if (!/^[0-9a-f]{64}$/.test(t)) throw new AiInterviewError("invalid session", 400, "invalid_session");
  const session = await deps.store.sessionByHash(await deps.hash(t));
  if (!session) throw new AiInterviewError("This interview could not be found.", 404, "unknown_session");
  if (opts.live && session.status !== "in_progress") throw new AiInterviewError("This interview has finished.", 409, "finished");
  const study = await deps.store.studyById(session.studyId);
  if (!study) throw new AiInterviewError("This interview's study is gone.", 410, "unknown_study");
  return { session, study };
}
