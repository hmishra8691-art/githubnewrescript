import "server-only";
import { computeReport } from "./reportCompute";
import type { Db } from "./db";
import { loadDefinition, loadTheme } from "./analytics";
import { mailConfig, sendMail } from "./mail";
import { mediaDb } from "./mediaRoute";
import { runScheduleWith, type RunOutcome } from "./reportSchedulesCore";
import { publishReportWith } from "./reportPublishCore";
import { audit } from "./guard";

export { SCHEDULE_COLUMNS, MISSING_0110, isMissing0110, MISSING_0114, isMissing0114, timingOf, runFilePath } from "./reportSchedulesCore";

type Row = Record<string, unknown>;

/** one run with the real database, computation, store and mail (reportSchedulesCore.ts has the run itself) */
export async function runSchedule(db: Db, s: Row, opts: { trigger: "schedule" | "manual"; studioUrl: string | null }): Promise<RunOutcome> {
  const surveyId = String(s.survey_id);
  let loadedOnce: Awaited<ReturnType<typeof loadDefinition>> | null = null;
  const loaded = async () => {
    loadedOnce ??= await loadDefinition(db as never, surveyId);
    if ("error" in loadedOnce) throw new Error(loadedOnce.error);
    return loadedOnce;
  };
  let customerId: string | null = null;
  return runScheduleWith(db as never, {
    compute: async (report) => computeReport(db, surveyId, (await loaded()) as never, report),
    theme: (themeId, customer) => { customerId = customer; return loadTheme(db as never, themeId, { surveyId, customerId: customer }); },
    /* a schedule with republish on: the same publish as the Studio's button (lib/reportPublishCore.ts), never forced */
    publish: async (reportId, results, note) => {
      const l = await loaded();
      const out = await publishReportWith(db as never, {
        compute: (definition, filters, condition) => computeReport(db, surveyId, l as never, definition, filters, condition ?? null),
        theme: (themeId) => loadTheme(db as never, themeId, { surveyId, customerId }),
        source: { version: l.version, revision: l.revision },
      }, { surveyId, reportId, userId: null, note, snapshot: results });
      if (!out.ok) return { ok: false, error: out.error };
      void audit({ action: "analytics.report_published", userId: null, surveyId, customerId, entity: "analytics", entityId: reportId, detail: { name: out.name, version: out.version, mode: out.mode, by: "schedule", scheduleId: String(s.id), trigger: opts.trigger, viewerFilters: out.viewerFilters, drillValues: out.drillValues, withheld: out.withheld.length } });
      return { ok: true, version: out.version, withheld: out.withheld };
    },
    store: mediaDb(db as never).stores.primary as never,
    mailConfigured: mailConfig().configured,
    send: (m) => sendMail({ ...m, stream: "transactional" }),
  }, s, opts);
}

export const studioPublicUrl = (requestOrigin?: string | null) => (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || requestOrigin || null;
