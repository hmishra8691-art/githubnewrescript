import "server-only";
import { computeReport } from "./reportCompute";
import type { Db } from "./db";
import { loadDefinition, loadTheme } from "./analytics";
import { mailConfig, sendMail } from "./mail";
import { mediaDb } from "./mediaRoute";
import { runScheduleWith, type RunOutcome } from "./reportSchedulesCore";

export { SCHEDULE_COLUMNS, MISSING_0110, isMissing0110, timingOf, runFilePath } from "./reportSchedulesCore";

type Row = Record<string, unknown>;

/** one run with the real database, computation, store and mail (reportSchedulesCore.ts has the run itself) */
export async function runSchedule(db: Db, s: Row, opts: { trigger: "schedule" | "manual"; studioUrl: string | null }): Promise<RunOutcome> {
  const surveyId = String(s.survey_id);
  return runScheduleWith(db as never, {
    compute: async (report) => {
      const loaded = await loadDefinition(db as never, surveyId);
      if ("error" in loaded) throw new Error(loaded.error);
      return computeReport(db, surveyId, loaded as never, report);
    },
    theme: (themeId, customerId) => loadTheme(db as never, themeId, { surveyId, customerId }),
    store: mediaDb(db as never).stores.primary as never,
    mailConfigured: mailConfig().configured,
    send: (m) => sendMail({ ...m, stream: "transactional" }),
  }, s, opts);
}

export const studioPublicUrl = (requestOrigin?: string | null) => (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || requestOrigin || null;
