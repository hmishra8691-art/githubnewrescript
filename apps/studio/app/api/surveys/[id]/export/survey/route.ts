import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import {
  exportSurveyDocx, exportSurveyJsonConfigured,
  EXPORT_PRESETS, ALL_FIELDS, type ExportFields,
} from "@rescript/exporters";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Export the survey the programmer is looking at.
 *
 * The definition is POSTed from the editor rather than read from the
 * database, deliberately: the requirement is that a change made in the Studio
 * shows up in the export, and the newest saved VERSION is not what is on
 * screen — the draft is. Sending the definition also means /sandbox can
 * export without a database.
 *
 * The server still parses it against the schema before writing anything, so
 * an export can never be produced from a definition the runtime would refuse.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  // A definition is a few hundred KB at the very outside; anything larger is
  // not a survey, and both the schema parse and the docx build run
  // synchronously, so an unbounded body is an easy way to tie up the server.
  const MAX_BYTES = 8 * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json({ error: "that definition is too large to export" }, { status: 413 });
  }

  let payload: any;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BYTES) {
      return NextResponse.json({ error: "that definition is too large to export" }, { status: 413 });
    }
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = SurveyDefinition.safeParse(payload?.definition);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "the survey definition is not valid, so it cannot be exported",
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
      { status: 400 },
    );
  }
  const def = parsed.data;

  // an unknown field name is ignored rather than trusted
  const incoming = payload?.fields ?? {};
  const fields = Object.fromEntries(
    ALL_FIELDS.map((f) => [f, incoming[f] === true]),
  ) as unknown as ExportFields;
  const anySelected = ALL_FIELDS.some((f) => fields[f]);
  const chosen = anySelected ? fields : EXPORT_PRESETS.basic;
  const complete = ALL_FIELDS.every((f) => chosen[f]);

  const version = typeof payload?.version === "string" ? payload.version : def.meta.version;
  const stem = `${def.meta.code}_v${version}`.replace(/[^A-Za-z0-9._-]+/g, "_");

  if (payload?.format === "json") {
    const doc = exportSurveyJsonConfigured(def, chosen, { version, complete });
    return new NextResponse(JSON.stringify(doc, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${stem}_survey.json"`,
      },
    });
  }

  const buf = await exportSurveyDocx(def, chosen, { version });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${stem}_survey.docx"`,
    },
  });
}
