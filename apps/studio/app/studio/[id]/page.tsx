import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { newSurveyDefinition } from "@/lib/defaults";
import { Studio } from "@/components/studio/Studio";

export const dynamic = "force-dynamic";

export default async function StudioPage({ params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data: survey } = await db
    .from("surveys")
    .select("id, code, title, current_version_id")
    .eq("id", params.id)
    .single();

  if (!survey) {
    return <div className="dash"><h1>Survey not found</h1><a href="/">← back</a></div>;
  }

  let definition = newSurveyDefinition(survey.id, survey.code, survey.title);
  let versionId: string | null = null;
  if (survey.current_version_id) {
    const { data: ver } = await db
      .from("survey_versions")
      .select("id, definition")
      .eq("id", survey.current_version_id)
      .single();
    if (ver) {
      const parsed = SurveyDefinition.safeParse(ver.definition);
      if (parsed.success) {
        definition = parsed.data;
        versionId = ver.id;
      }
    }
  }

  return <Studio definition={definition} surveyDbId={survey.id} versionId={versionId} />;
}
