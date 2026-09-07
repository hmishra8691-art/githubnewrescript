import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * PROJECT CONFIGURATION (§60).
 *
 *   GET    → the project's own facts, plus what the caller may change
 *   PATCH  → change them
 *
 * THE DISTINCTION THIS ROUTE EXISTS TO MAKE. A survey DEFINITION describes
 * the questionnaire: its questions, its logic, its branding, its deployment
 * slugs. It is versioned, it is what a respondent sees, and "Survey Settings"
 * edits it. A PROJECT is the piece of work around the questionnaire — who it
 * is for, who is running it, when it is in field, when it is due — and none
 * of that belongs in a version, because none of it changes what a respondent
 * answers. Until now the platform had no place for it at all, so it ended up
 * in project titles and in `def.meta.description`, where nothing could sort
 * or filter it.
 *
 * WHY THIS IS NOT `PATCH /api/surveys/[id]`. That route changes `status` and
 * requires the EDIT LOCK, correctly: moving a project to live is an act on
 * the questionnaire. Setting a due date is not, and requiring the lock for it
 * would mean a project manager cannot record a deadline while a programmer
 * has the survey open — which is precisely when deadlines get recorded.
 *
 * TWO DIFFERENT PERMISSIONS. The facts need `survey.edit`. The FREEZE and the
 * collaboration overrides need `project.lock_settings`, which only an owner
 * holds — and which, until this route, was declared in `packages/access` and
 * referenced by nothing. `surveys.locked` has been enforced by `lib/guard.ts`
 * since migration 0008 (423 for every write capability, owner excepted) and
 * no screen in the platform could ever switch it on. The guarantee existed,
 * the permission existed, the switch did not.
 */

/** Free-text project fields, with the length a form should have stopped at. */
const TEXT_FIELDS = {
  client_name: 200,
  project_manager: 200,
  cost_centre: 80,
  notes: 4000,
} as const;

const DATE_FIELDS = ["fieldwork_from", "fieldwork_to", "due_date"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CAMEL: Record<string, string> = {
  clientName: "client_name",
  projectManager: "project_manager",
  costCentre: "cost_centre",
  fieldworkFrom: "fieldwork_from",
  fieldworkTo: "fieldwork_to",
  dueDate: "due_date",
  notes: "notes",
  settings: "settings",
};

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("surveys")
    .select("id, code, title, status, owner_id, client_name, project_manager, fieldwork_from, fieldwork_to, due_date, cost_centre, notes, locked, collaboration, settings, created_at, updated_at")
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    /*
     * Migration 0015 not applied: answer with the row's existing fields and
     * say the configuration is unavailable, rather than failing the panel.
     * The shape every migration-gated panel here uses.
     */
    if (/client_name|project_manager|does not exist|schema cache/i.test(error.message)) {
      const bare = await db.from("surveys").select("id, code, title, status, owner_id, locked").eq("id", params.id).maybeSingle();
      return NextResponse.json({
        available: false,
        note: "Project configuration needs migration 0015.",
        project: bare.data ?? null,
        can: { edit: false, lockSettings: false },
      }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    available: true,
    project: {
      id: data.id, code: data.code, title: data.title, status: data.status,
      clientName: data.client_name, projectManager: data.project_manager,
      fieldworkFrom: data.fieldwork_from, fieldworkTo: data.fieldwork_to,
      dueDate: data.due_date, costCentre: data.cost_centre, notes: data.notes,
      locked: data.locked, collaboration: data.collaboration ?? {},
      settings: data.settings ?? {},
      createdAt: data.created_at, updatedAt: data.updated_at,
    },
    /*
     * What the caller may change, so the panel can show a field as read-only
     * rather than letting somebody type into it and be refused on save.
     */
    can: {
      edit: gate.role === "owner" || gate.role === "editor" || gate.role === "programmer",
      lockSettings: gate.role === "owner",
    },
    role: gate.role,
  }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const wantsLockSettings = "locked" in body || "collaboration" in body;
  const patch: Record<string, unknown> = {};
  /* whichever gate ran — kept so the audit line names the right person once */
  let ctx: Exclude<Awaited<ReturnType<typeof requireProject>>, { response: unknown }> | null = null;

  /*
   * The freeze and the collaboration overrides are gated separately, and the
   * gate is checked FIRST — so a request that mixes them with ordinary fields
   * is refused as a whole rather than half-applied. Note `project.lock_settings`
   * is deliberately not in the guard's WRITE_CAPABILITIES: an owner must be
   * able to UNLOCK a project they locked, and a lock that cannot be undone is
   * a support ticket, not a safeguard.
   */
  if (wantsLockSettings) {
    const gate = await requireProject(req, params.id, "project.lock_settings");
    if (isFailure(gate)) return gate.response;
    ctx = gate;
    if ("locked" in body) {
      if (typeof body.locked !== "boolean") return NextResponse.json({ error: "locked must be true or false" }, { status: 400 });
      patch.locked = body.locked;
    }
    if ("collaboration" in body) {
      const c = body.collaboration;
      if (c == null || typeof c !== "object" || Array.isArray(c)) {
        return NextResponse.json({ error: "collaboration must be an object" }, { status: 400 });
      }
      /*
       * Only the keys this project may override. Anything else would be a
       * silent no-op stored for ever, which is how `surveys.collaboration`
       * came to hold nothing at all for two migrations: a jsonb column with
       * no declared shape is a column nobody dares read.
       */
      const out: Record<string, unknown> = {};
      if ("requireLockToEdit" in c) out.requireLockToEdit = !!c.requireLockToEdit;
      if ("allowConcurrentViewers" in c) out.allowConcurrentViewers = !!c.allowConcurrentViewers;
      if ("lockMinutes" in c) {
        const n = Number(c.lockMinutes);
        if (!Number.isFinite(n) || n < 1 || n > 480) return NextResponse.json({ error: "lockMinutes must be between 1 and 480" }, { status: 400 });
        out.lockMinutes = Math.round(n);
      }
      patch.collaboration = out;
    }
  }

  const hasFacts = Object.keys(CAMEL).some((k) => k in body) || DATE_FIELDS.some((k) => k in body) || Object.keys(TEXT_FIELDS).some((k) => k in body);
  if (hasFacts) {
    const gate = await requireProject(req, params.id, "survey.edit");
    if (isFailure(gate)) return gate.response;
    ctx = gate;

    for (const [camel, column] of Object.entries(CAMEL)) {
      const key = camel in body ? camel : column in body ? column : null;
      if (!key) continue;
      const raw = body[key];

      if (column === "settings") {
        if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
          return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
        }
        patch.settings = raw ?? {};
        continue;
      }

      if ((DATE_FIELDS as readonly string[]).includes(column)) {
        if (raw === null || raw === "") { patch[column] = null; continue; }
        const s = String(raw).slice(0, 10);
        if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s))) {
          return NextResponse.json({ error: `${camel} must be a date (YYYY-MM-DD) or empty` }, { status: 400 });
        }
        patch[column] = s;
        continue;
      }

      const max = TEXT_FIELDS[column as keyof typeof TEXT_FIELDS];
      if (raw === null || raw === "") { patch[column] = null; continue; }
      patch[column] = String(raw).trim().slice(0, max) || null;
    }
  }

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to change" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: before } = await db
    .from("surveys")
    .select("id, code, customer_id, locked, client_name, project_manager, fieldwork_from, fieldwork_to, due_date, cost_centre")
    .eq("id", params.id)
    .maybeSingle();
  if (!before) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await db
    .from("surveys")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .select("id, client_name, project_manager, fieldwork_from, fieldwork_to, due_date, cost_centre, notes, locked, collaboration, settings")
    .single();

  if (error) {
    if (/client_name|project_manager|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: "Project configuration needs migration 0015.", migration: "0015" }, { status: 503 });
    }
    if (/surveys_fieldwork_order/i.test(error.message)) {
      return NextResponse.json({ error: "Fieldwork cannot end before it starts." }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  /*
   * The audit line says what a person would say. A freeze is the change most
   * worth being able to find later — it is what somebody will be looking for
   * when they ask why they cannot save.
   */
  const changed = Object.keys(patch).filter((k) => k !== "settings");
  const froze = "locked" in patch && patch.locked !== before.locked;

  await audit({
    action: "survey.modified",
    userId: ctx?.user.userId ?? null,
    sessionId: ctx?.user.sessionId ?? null,
    surveyId: params.id,
    customerId: ctx?.user.customerId ?? before.customer_id,
    entity: "project_config",
    entityId: params.id,
    detail: {
      summary: froze
        ? `${patch.locked ? "froze" : "unfroze"} the project ${before.code}`
        : `changed the project configuration of ${before.code} (${changed.join(", ")})`,
      changed,
      ...(froze ? { locked: patch.locked } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    project: {
      id: data.id, clientName: data.client_name, projectManager: data.project_manager,
      fieldworkFrom: data.fieldwork_from, fieldworkTo: data.fieldwork_to, dueDate: data.due_date,
      costCentre: data.cost_centre, notes: data.notes, locked: data.locked,
      collaboration: data.collaboration ?? {}, settings: data.settings ?? {},
    },
    ...(froze && patch.locked
      ? { note: "Everyone but you is now refused every change to this project, including saving the survey. Unfreeze it here when you are done." }
      : {}),
  });
}
