import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { exportVariableDictionaryXlsx } from "@rescript/exporters";

export const dynamic = "force-dynamic";

/** One-click "Export Variable Dictionary" (requirement §10). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const versionId = req.nextUrl.searchParams.get("versionId");

  let q = db.from("survey_versions").select("id, version, definition").eq("survey_id", params.id);
  const { data: ver } = versionId
    ? await q.eq("id", versionId).single()
    : await db.from("surveys").select("current_version_id").eq("id", params.id).single()
        .then(async (r) =>
          r.data?.current_version_id
            ? db.from("survey_versions").select("id, version, definition").eq("id", r.data.current_version_id).single()
            : { data: null },
        );
  if (!ver) return NextResponse.json({ error: "version not found" }, { status: 404 });

  const parsed = SurveyDefinition.safeParse(ver.definition);
  if (!parsed.success) return NextResponse.json({ error: "stored definition invalid" }, { status: 500 });

  const buf = await exportVariableDictionaryXlsx(parsed.data);
  const fname = `${parsed.data.meta.code}_v${ver.version}_variables.xlsx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fname}"`,
    },
  });
}
