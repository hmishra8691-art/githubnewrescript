"use client";
import React from "react";
import { EXPORT_PRESETS } from "@rescript/exporters";
import { useStudio } from "./store";

/**
 * THE DOCUMENTS PANEL (audit DOC-11) — the six documents a research project
 * hands over, one button each, so none of them is reachable only by typing a
 * sentence to the copilot:
 *
 *   Research plan (.docx)              the full plan: hypotheses and rationale, traceability, variables, tests, charts, QC, limitations (2026-10-17)
 *   Research proposal (.docx)          the design, the sample, the screening, the timeline, the ethics
 *   Statistical analysis plan (.docx)  what is tested, how, at what α, on whom
 *   Data-cleaning plan (.docx)         the quality rules in force for this survey
 *   Questionnaire (.docx)              the programming specification, from the draft on screen
 *   Findings report (.docx)            from a run of the plan on the survey's completes
 *   Findings deck (.pptx)              the same, as slides
 *
 * Each button fetches the file, saves it through an anchor and says what the
 * route said about it (its `x-rescript-output` header) in a toast. The two
 * findings documents need completes to report on, so without them the button
 * is disabled and its tooltip says why; the sandbox has no database, so the
 * documents that read stored data are disabled there too.
 */
type DocKey = "research_plan_docx" | "proposal_docx" | "sap_docx" | "cleaning_plan_docx" | "questionnaire_docx" | "findings_docx" | "findings_pptx";
type Audience = "executive" | "client" | "researcher";

export function ResearchDocuments() {
  const s = useStudio();
  const id = s.surveyDbId;
  const sandbox = !id || id === "sandbox";
  const [completes, setCompletes] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<DocKey | null>(null);
  const [audience, setAudience] = React.useState<Audience>("client");

  /* how many completes there are, to know whether a findings document has anything to report on */
  React.useEffect(() => {
    if (sandbox) { setCompletes(0); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/surveys/${id}/overview`, { cache: "no-store" });
        const j = await res.json().catch(() => null) as { counts?: { complete?: number | null } } | null;
        if (live) setCompletes(res.ok && typeof j?.counts?.complete === "number" ? j.counts.complete : 0);
      } catch { if (live) setCompletes(0); }
    })();
    return () => { live = false; };
  }, [id, sandbox]);

  const download = async (key: DocKey) => {
    if (busy) return;
    setBusy(key);
    try {
      let res: Response;
      const json = { "content-type": "application/json" };
      if (key === "cleaning_plan_docx") res = await fetch(`/api/surveys/${id}/quality/plan`, { cache: "no-store" });
      else if (key === "questionnaire_docx") res = await fetch(`/api/surveys/${id || "sandbox"}/export/survey`, { method: "POST", headers: json, body: JSON.stringify({ definition: s.def, fields: EXPORT_PRESETS.spec, format: "docx", version: s.def.meta.version }) });
      else {
        const type = key;
        res = await fetch("/api/copilot/output", { method: "POST", headers: json, body: JSON.stringify({ surveyId: id || "sandbox", output: { type, audience }, ...(sandbox ? { definition: s.def } : {}) }) });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { error?: string } | null;
        s.toast(j?.error ?? (res.status === 401 ? "Sign in to produce documents for this survey." : res.status === 403 ? "You do not have access to this document." : `The document could not be produced (HTTP ${res.status}).`), "err");
        return;
      }
      const blob = await res.blob();
      /* never save a file that is not one (2026-10-17): an empty body or an error page saved as .docx is what "the Word file will not open" was */
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (blob.size < 100 || head[0] !== 0x50 || head[1] !== 0x4b) { s.toast(`The document could not be produced: the server sent ${blob.size ? "something that is not a document" : "an empty file"}.`, "err"); return; }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${key.replace(/_/g, ".")}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      /* revoked well after the browser has started the save (a large file on a slow disk read the URL after 4 s and got nothing) */
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const said = res.headers.get("x-rescript-output");
      s.toast(said ? `${name}: ${said}` : `Downloaded ${name}`);
    } catch (e) {
      s.toast(`The document could not be produced: ${(e as Error).message || "the network request failed"}.`, "err");
    } finally { setBusy(null); }
  };

  const noData = completes === null ? "Checking for completes…" : completes === 0 ? "There are no completes to report on yet — this document is made from a run of the analysis plan on the survey's data." : "";
  const noDb = "Open a saved project to produce this document — it is made from stored survey data.";
  const docs: { key: DocKey; label: string; hint: string; disabled: string }[] = [
    { key: "research_plan_docx", label: "Research plan (.docx)", hint: "Executive summary, objectives, hypotheses and rationale, how each question serves them, variables and scales, hypothesis tests, proposed tables and charts, interpretation framework, QC, limitations", disabled: "" },
    { key: "proposal_docx", label: "Research proposal (.docx)", hint: "Objective, hypotheses, questionnaire, sampling design, screening, timeline, analysis plan, ethics", disabled: "" },
    { key: "sap_docx", label: "Statistical analysis plan (.docx)", hint: "Variables, populations, the test for each analysis and why, α and corrections, weighting, missing data, sample size", disabled: "" },
    { key: "cleaning_plan_docx", label: "Data-cleaning plan (.docx)", hint: "The quality rules in force for this survey, their thresholds and what each does to the dataset", disabled: sandbox ? noDb : "" },
    { key: "questionnaire_docx", label: "Questionnaire (.docx)", hint: "The programming specification of the survey as it is open in the editor", disabled: "" },
    { key: "findings_docx", label: "Findings report (.docx)", hint: "Executive summary, verdicts on each hypothesis, key findings, caveats", disabled: sandbox ? noDb : noData },
    { key: "findings_pptx", label: "Findings deck (.pptx)", hint: "The findings as slides, edition for the audience chosen", disabled: sandbox ? noDb : noData },
  ];

  return (
    <div data-testid="research-documents">
      <h4 className="rd-h">Documents <span className="muted">· download what the project hands over</span></h4>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {docs.map((d) => (
          <button key={d.key} type="button" className="btn small" data-testid={`doc-${d.key}`} disabled={!!d.disabled || !!busy} aria-busy={busy === d.key}
            title={d.disabled || d.hint} onClick={() => void download(d.key)}>
            {busy === d.key ? "Preparing…" : d.label}
          </button>
        ))}
        <label className="row" style={{ gap: 6, alignItems: "center" }} title="Who the findings report and deck are written for">
          <span className="muted" style={{ fontSize: 12.5 }}>Findings for</span>
          <select className="select" style={{ width: 130 }} data-testid="doc-audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
            <option value="client">the client</option>
            <option value="executive">executives</option>
            <option value="researcher">researchers</option>
          </select>
        </label>
      </div>
    </div>
  );
}
