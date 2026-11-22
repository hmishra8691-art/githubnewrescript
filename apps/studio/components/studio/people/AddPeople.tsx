"use client";
import React from "react";
import {
  ACCEPTED_FILES, ACCEPTED_FILES_WORDS, EMPTY_ROW, isBlank, listNameFromFile, manualProblems, manualToUpload, mergeRows, parseQuickPaste, previewHeadline,
  type IntakeProblem, type IntakeSummary, type ManualRow,
} from "@/lib/peopleIntakeCore";

/**
 * ADD PEOPLE (2026-11-21) — the one way people get onto a respondent list, used on the Distribution tab and in the
 * Respondent portal section so the two cannot drift apart.
 *
 *   1  HOW      type them in · upload a file (with a template to download) · paste from a spreadsheet
 *   2  WHERE    an existing list, or a new one with a name
 *   3  CHECK    the server reads it and says, row by row, what it found — nothing is added yet
 *   4  CONFIRM  the researcher adds exactly what they looked at
 *
 * Every way in becomes the same rows and goes through the same server check (lib/respondentIntake.ts). The
 * component holds no knowledge of where it is mounted: it is told the survey, the environment and the lists.
 */
type Field = "email" | "external_id" | "name" | "embedded";
type Mode = "type" | "file" | "paste";
interface Preview {
  headers: string[]; mapping: Record<string, Field>; sheetName?: string; sheetNames?: string[];
  summary: IntakeSummary; issues: string[]; duplicates: string[]; problems?: IntakeProblem[];
  alreadyOnList?: { count: number; examples: string[] };
  sample: { email: string | null; external_id: string | null; name: string | null; embedded: Record<string, unknown> }[];
  rows: Record<string, unknown>[]; blocking: string | null; listName: string | null;
}
export interface AddedResult { listName: string | null; inserted: number; leftOut: number }

const NEW_LIST = "__new__";
const step: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 999, background: "var(--c-primary, #2563eb)", color: "#fff", fontSize: 12, fontWeight: 700, marginRight: 8, flex: "none" };
const head: React.CSSProperties = { display: "flex", alignItems: "center", fontWeight: 600, fontSize: 13.5, margin: "0 0 8px" };

export function AddPeople({ surveyId, env, lists, defaultList, onAdded, onClose }: { surveyId: string; env: "LIVE" | "TEST"; lists: string[]; defaultList?: string; onAdded: (r: AddedResult) => void; onClose?: () => void }) {
  const envWord = env === "TEST" ? "test" : "live";
  const api = `/api/surveys/${surveyId}/respondents`;
  const [mode, setMode] = React.useState<Mode>("type");
  const [rows, setRows] = React.useState<ManualRow[]>([{ ...EMPTY_ROW }, { ...EMPTY_ROW }, { ...EMPTY_ROW }]);
  const [quick, setQuick] = React.useState("");
  const [text, setText] = React.useState("");
  const [xlsxBase64, setXlsxBase64] = React.useState<string | null>(null);
  const [fileText, setFileText] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const named = lists.filter(Boolean);
  const [listChoice, setListChoice] = React.useState<string>(defaultList && named.includes(defaultList) ? defaultList : NEW_LIST);
  const [listName, setListName] = React.useState("");
  /* the list people were just added to: once it shows up among the lists it becomes the one in hand, so adding more
     goes to the same place and a "new list" is never silently the old one typed again */
  const [justUsed, setJustUsed] = React.useState<string | null>(null);
  React.useEffect(() => { if (justUsed && lists.includes(justUsed)) { setListChoice(justUsed); setJustUsed(null); } }, [justUsed, lists]);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [skipExisting, setSkipExisting] = React.useState(true);
  const [showAll, setShowAll] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<AddedResult | null>(null);
  /* a column was re-mapped since the last check: what is on screen no longer describes what would be added */
  const [dirty, setDirty] = React.useState(false);

  /* a different environment is a different list entirely */
  React.useEffect(() => { setPreview(null); setDone(null); setError(null); }, [env]);

  const typedProblems = React.useMemo(() => manualProblems(rows), [rows]);
  const typedCount = rows.filter((r) => !isBlank(r)).length;
  const theList = (listChoice === NEW_LIST ? listName.trim() : listChoice) || null;
  const ready = mode === "type" ? typedCount > 0 : mode === "file" ? !!(xlsxBase64 || fileText) : !!text.trim();

  const setRow = (i: number, patch: Partial<ManualRow>) => { setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r))); setPreview(null); };
  const addQuick = () => {
    const found = parseQuickPaste(quick);
    if (!found.length) { setError("No names or email addresses were found in what you pasted."); return; }
    setRows((rs) => [...mergeRows(rs, found), { ...EMPTY_ROW }]); setQuick(""); setError(null); setPreview(null);
  };

  const onFile = async (f: File) => {
    setError(null); setPreview(null); setSheet(null);
    if (!/\.(csv|tsv|txt|xlsx|xlsm)$/i.test(f.name)) { setError(`“${f.name}” is not a file this can read. Upload ${ACCEPTED_FILES_WORDS}. The template below is the easiest way to get the format right.`); return; }
    if (f.size > 15 * 1024 * 1024) { setError("That file is larger than 15 MB. Split it into smaller files."); return; }
    setFileName(f.name);
    if (listChoice === NEW_LIST && !listName.trim()) setListName(listNameFromFile(f.name));
    /* a workbook is bytes, not text: it is sent as base64 and read on the server (0x8000 chunks keep the stack safe) */
    if (/\.xlsx?$|\.xlsm$/i.test(f.name)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      setXlsxBase64(btoa(bin)); setFileText(null);
      return;
    }
    setXlsxBase64(null); setFileText(await f.text());
  };

  const source = (): Record<string, unknown> => {
    if (mode === "type") { const u = manualToUpload(rows); return { rows: u.rows, headers: u.headers }; }
    if (mode === "file") return xlsxBase64 ? { xlsxBase64, sheet: sheet ?? undefined } : { text: fileText ?? "" };
    return { text };
  };
  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: env, listName: theList, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ? String(j.error).replace(/^./, (c: string) => c.toUpperCase()) : `That did not work (${r.status}).`); return null; }
      return j;
    } catch (e) { setError((e as Error).message); return null; }
    finally { setBusy(false); }
  };
  const check = async (override?: { sheet?: string }) => {
    if (listChoice === NEW_LIST && !listName.trim()) { setError("Give the new list a name first, for example “Wave 1”."); return; }
    /* checking again keeps the columns as the researcher set them; another sheet starts from a fresh guess */
    const j = await post({ stage: "preview", ...source(), ...(override?.sheet ? { sheet: override.sheet } : preview ? { mapping: preview.mapping } : {}) });
    if (j) { setPreview(j as Preview); setShowAll(false); setDirty(false); if ((j as Preview).sheetNames?.length && !sheet) setSheet((j as Preview).sheetName ?? null); }
  };
  const commit = async () => {
    if (!preview) return;
    /* the rows the researcher just looked at are posted back unchanged, with the mapping as it stands on screen */
    const j = await post({ stage: "commit", rows: preview.rows, headers: preview.headers, mapping: preview.mapping, skipExisting });
    if (!j) return;
    const result = { listName: j.listName ?? theList, inserted: Number(j.inserted ?? 0), leftOut: Number(j.alreadyOnTheListCount ?? 0) };
    setDone(result); setPreview(null);
    if (listChoice === NEW_LIST) { setListName(""); setJustUsed(result.listName); }
    setRows([{ ...EMPTY_ROW }, { ...EMPTY_ROW }, { ...EMPTY_ROW }]); setText(""); setXlsxBase64(null); setFileText(null); setFileName(null);
    onAdded(result);
  };

  const onList = preview?.alreadyOnList?.count ?? 0;
  const adding = preview ? Math.max(0, preview.summary.people - (skipExisting ? onList : 0)) : 0;
  const problems = preview?.problems ?? [];
  const noKey = preview ? !Object.values(preview.mapping).some((t) => t === "email" || t === "external_id") : false;
  const tab = (m: Mode, label: string, hint: string) => (
    <button type="button" role="tab" aria-selected={mode === m} className={`btn small ${mode === m ? "primary" : ""}`} onClick={() => { setMode(m); setPreview(null); setError(null); }} data-testid={`ds-mode-${m}`} title={hint}>{label}</button>
  );

  return (
    <div className="card" data-testid="ds-upload">
      <div className="row" style={{ gap: 8 }}>
        <h3 className="sec" style={{ margin: 0 }}>Add people to the {envWord} list</h3>
        <span className="grow" />
        {onClose && <button type="button" className="btn small ghost" onClick={onClose}>Close</button>}
      </div>

      {done && (
        <div className="chip on qd-note" style={{ marginTop: 10 }} data-testid="ds-added" role="status">
          {done.inserted} {done.inserted === 1 ? "person was" : "people were"} added{done.listName ? ` to “${done.listName}”` : ""}.
          {done.leftOut ? ` ${done.leftOut} ${done.leftOut === 1 ? "was" : "were"} already on the list and left as they were.` : ""} You can add more below, or close this.
        </div>
      )}

      {/* ------------------------------------------------------------------ 1 */}
      <p style={{ ...head, marginTop: 14 }}><span style={step}>1</span>How do you want to add them?</p>
      <div className="row" role="tablist" aria-label="How to add people" style={{ gap: 6, flexWrap: "wrap" }}>
        {tab("type", "Type them in", "Best for a few people")}
        {tab("file", "Upload a file", "Best for a long list: Excel or CSV")}
        {tab("paste", "Paste from a spreadsheet", "Copy the cells, including the heading row, and paste them")}
      </div>

      {mode === "type" && (
        <div style={{ marginTop: 10 }} data-testid="ds-manual">
          {/* one person per line; on a phone the three boxes stack under each other instead of pushing the page sideways */}
          <style>{`.ap-row{display:grid;grid-template-columns:24px 1fr 1.3fr 1fr 36px;gap:6px;align-items:center;margin-bottom:6px}.ap-row input{min-width:0;width:100%}.ap-cap{display:none;font-size:11.5px}.ap-head{font-size:12.5px;font-weight:600}
@media (max-width:640px){.ap-row{grid-template-columns:24px 1fr 36px;padding-bottom:8px;border-bottom:1px solid var(--c-border,#e5e7eb)}.ap-row>.ap-f{grid-column:2}.ap-row>.ap-x{grid-column:3;grid-row:1}.ap-head{display:none}.ap-cap{display:block}}`}</style>
          <div className="ap-row ap-head" aria-hidden="true"><span>#</span><span>Name</span><span>Email</span><span>Their ID <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></span><span /></div>
          {rows.map((r, i) => (
            <React.Fragment key={i}>
              <div className="ap-row" data-testid="ds-manual-row">
                <span className="muted">{i + 1}</span>
                <label className="ap-f"><span className="ap-cap muted">Name</span><input className="input" value={r.name} placeholder="Ada Lovelace" aria-label={`Name, line ${i + 1}`} onChange={(e) => setRow(i, { name: e.target.value })} /></label>
                <label className="ap-f"><span className="ap-cap muted">Email</span><input className="input" type="email" value={r.email} placeholder="ada@example.com" aria-label={`Email, line ${i + 1}`} aria-invalid={!!typedProblems[i]} onChange={(e) => setRow(i, { email: e.target.value })} data-testid={`ds-manual-email-${i}`} /></label>
                <label className="ap-f"><span className="ap-cap muted">Their ID (optional)</span><input className="input" value={r.id} placeholder="EMP-001" aria-label={`ID, line ${i + 1}`} onChange={(e) => setRow(i, { id: e.target.value })} /></label>
                <button type="button" className="btn small ghost ap-x" aria-label={`Remove line ${i + 1}`} disabled={rows.length === 1} onClick={() => { setRows((rs) => rs.filter((_, k) => k !== i)); setPreview(null); }}>×</button>
              </div>
              {typedProblems[i] && <div style={{ margin: "-2px 0 6px 30px" }}><span className="chip warn" data-testid={`ds-manual-problem-${i}`}>{typedProblems[i]}</span></div>}
            </React.Fragment>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn small" onClick={() => setRows((rs) => [...rs, { ...EMPTY_ROW }])} data-testid="ds-manual-add">+ Add another person</button>
            <span className="muted" style={{ fontSize: 12.5 }}>{typedCount} {typedCount === 1 ? "person" : "people"} typed in</span>
          </div>
          <label className="f" style={{ marginTop: 12 }}>
            <span>Have several email addresses? Paste them here, one per line or separated by commas.</span>
            <textarea className="input" rows={3} value={quick} placeholder={"ada@example.com, bob@example.com\nCy Young <cy@example.com>"} onChange={(e) => setQuick(e.target.value)} data-testid="ds-quick" />
          </label>
          <button type="button" className="btn small" style={{ marginTop: 6 }} disabled={!quick.trim()} onClick={addQuick} data-testid="ds-quick-add">Add these to the table</button>
        </div>
      )}

      {mode === "file" && (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }} data-testid="ds-file-mode">
          <div className="card" style={{ padding: 10 }}>
            <div className="flabel">A. Download the template</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              <a className="btn small" href={`${api}/template?format=xlsx`} download data-testid="ds-template-xlsx">Download template (Excel)</a>
              <a className="btn small" href={`${api}/template?format=csv`} download data-testid="ds-template-csv">Download template (CSV)</a>
            </div>
            <div className="flabel" style={{ marginTop: 10 }}>B. Fill it in</div>
            <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
              One person per row. Columns: <strong>name</strong>, <strong>email</strong>, <strong>id</strong>. Each person needs an email or an id; the name is optional.
              You can add more columns (department, region); they are kept with the person. Delete the example row.
            </p>
            <div className="flabel" style={{ marginTop: 10 }}>C. Upload the file</div>
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
              style={{ display: "block", marginTop: 4, padding: "18px 12px", textAlign: "center", border: `2px dashed ${dragging ? "var(--c-primary, #2563eb)" : "var(--c-border, #cbd5e1)"}`, borderRadius: 10, cursor: "pointer", background: dragging ? "var(--c-surface-2, #eff6ff)" : "transparent" }}
              data-testid="ds-drop">
              <input type="file" accept={ACCEPTED_FILES} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} data-testid="ds-file" aria-label="Choose a file of people to upload"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
              {fileName
                ? <><strong data-testid="ds-file-name">{fileName}</strong> is ready to check. <span className="muted">Click to choose another file.</span></>
                : <><strong>Drop your file here</strong>, or click to choose one.<br /><span className="muted" style={{ fontSize: 12.5 }}>{ACCEPTED_FILES_WORDS}, up to 20,000 people and 15 MB.</span></>}
            </label>
            {preview?.sheetNames && preview.sheetNames.length > 1 && (
              <label className="f" style={{ width: 240, marginTop: 8 }}>
                <span>This workbook has several sheets. Read:</span>
                <select className="select" value={sheet ?? ""} onChange={(e) => { setSheet(e.target.value); void check({ sheet: e.target.value }); }}>{preview.sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </label>
            )}
          </div>
        </div>
      )}

      {mode === "paste" && (
        <label className="f" style={{ marginTop: 10 }}>
          <span>Copy the cells from your spreadsheet, including the heading row, and paste them here.</span>
          <textarea className="input mono" rows={6} value={text} data-testid="ds-paste"
            placeholder={"name,email,id,region\nAda Lovelace,ada@example.com,EMP-001,North"}
            onChange={(e) => { setText(e.target.value); setPreview(null); }} />
        </label>
      )}

      {/* ------------------------------------------------------------------ 2 */}
      <p style={{ ...head, marginTop: 16 }}><span style={step}>2</span>Which list do they go on?</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        {named.length > 0 && (
          <label className="f" style={{ width: 240 }}>
            <span>List</span>
            <select className="select" value={listChoice} onChange={(e) => { setListChoice(e.target.value); setPreview(null); if (e.target.value === NEW_LIST && !listName.trim() && mode === "file" && fileName) setListName(listNameFromFile(fileName)); }} data-testid="ds-list-choice">
              {named.map((n) => <option key={n} value={n}>{n}</option>)}
              <option value={NEW_LIST}>A new list…</option>
            </select>
          </label>
        )}
        {listChoice === NEW_LIST && (
          <label className="f" style={{ width: 240 }}>
            <span>Name of the new list</span>
            <input className="input" placeholder="Wave 1" value={listName} maxLength={120} data-testid="ds-list-name" onChange={(e) => { setListName(e.target.value); setPreview(null); }} />
          </label>
        )}
        <span className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}>A list is a group you invite together, such as “Wave 1” or “Night shift”. You can rename it later.</span>
      </div>

      {error && <div className="chip warn qd-note" style={{ marginTop: 10 }} role="alert" data-testid="ds-error">{error}</div>}

      {/* ------------------------------------------------------------------ 3 */}
      <p style={{ ...head, marginTop: 16 }}><span style={step}>3</span>Check it before anything is added</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className={`btn small ${preview ? "" : "primary"}`} disabled={busy || !ready} data-testid="ds-preview" onClick={() => void check()}>{busy && !preview ? "Reading…" : preview ? "Check again" : "Check the list"}</button>
        {!ready && <span className="muted" style={{ fontSize: 12.5 }}>{mode === "type" ? "Type at least one person in first." : mode === "file" ? "Choose a file first." : "Paste your list first."}</span>}
      </div>

      {preview && (
        <div style={{ marginTop: 12 }} data-testid="ds-preview-result">
          <div className={`chip ${preview.summary.people ? "on" : "warn"} qd-note`} data-testid="ds-headline">{previewHeadline(preview.summary, onList, skipExisting, envWord)}</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
            <span className="chip">{preview.summary.read} row{preview.summary.read === 1 ? "" : "s"} read</span>
            <span className="chip">{preview.summary.withEmail} with an email</span>
            <span className="chip">{preview.summary.withExternalId} with an ID</span>
            {(preview.summary.invalidEmails ?? 0) > 0 && <span className="chip warn" data-testid="ds-invalid">{preview.summary.invalidEmails} email{preview.summary.invalidEmails === 1 ? "" : "s"} that look wrong</span>}
            {preview.summary.duplicatesInFile > 0 && <span className="chip warn" data-testid="ds-dupes">{preview.summary.duplicatesInFile} repeated in this list</span>}
            {preview.summary.dropped > 0 && <span className="chip warn">{preview.summary.dropped} row{preview.summary.dropped === 1 ? "" : "s"} with nobody in</span>}
          </div>

          {onList > 0 && (
            <div className="card" style={{ padding: 10, marginBottom: 8 }} data-testid="ds-existing">
              <strong>{onList} {onList === 1 ? "person is" : "people are"} already on this survey&apos;s {envWord} list</strong>
              <span className="muted"> ({preview.alreadyOnList!.examples.slice(0, 3).join(", ")}{onList > 3 ? ", …" : ""})</span>
              <label className="row" style={{ gap: 6, marginTop: 6 }}><input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} data-testid="ds-skip-existing" /> Leave them out, so nobody gets a second link</label>
            </div>
          )}

          {noKey && preview.summary.people > 0 && <div className="chip warn qd-note" data-testid="ds-no-key">No column was recognised as an email or an ID. Open “Columns” below and say which one it is, or use the template.</div>}

          {problems.length > 0 && (
            <div className="card" style={{ padding: 10, marginBottom: 8 }} data-testid="ds-issues">
              <div className="flabel">What needs a look ({problems.length}{problems.length >= 200 ? "+" : ""})</div>
              <ul style={{ fontSize: 12.5, margin: "4px 0 0", paddingLeft: 18 }}>
                {(showAll ? problems : problems.slice(0, 6)).map((p, i) => <li key={i} className={p.skipped ? "" : "muted"}>{p.message}</li>)}
              </ul>
              {problems.length > 6 && <button type="button" className="btn small ghost" style={{ marginTop: 4 }} onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${problems.length}`}</button>}
              <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Fix these in your file and check again, or continue: rows marked “left out” are skipped, the rest are added.</p>
            </div>
          )}

          <details style={{ marginBottom: 8 }} open={noKey || undefined} data-testid="ds-columns">
            <summary style={{ cursor: "pointer", fontSize: 13 }}>Columns ({preview.headers.filter(Boolean).length}) — what each one is</summary>
            <div className="card" style={{ padding: 10, marginTop: 6 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                {preview.headers.filter(Boolean).map((h) => (
                  <label className="f" key={h} style={{ width: 190 }}>
                    <span className="mono" title={h}>{h.length > 22 ? `${h.slice(0, 21)}…` : h}</span>
                    <select className="select" value={preview.mapping[h] ?? "embedded"} data-testid={`ds-map-${h}`}
                      onChange={(e) => { setPreview({ ...preview, mapping: { ...preview.mapping, [h]: e.target.value as Field } }); setDirty(true); }}>
                      <option value="email">Email address</option>
                      <option value="external_id">Their ID (your own reference)</option>
                      <option value="name">Name</option>
                      <option value="embedded">Extra information, kept with the person</option>
                    </select>
                  </label>
                ))}
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Changed a column? Press “Check again” to see the result. Extra information reaches the survey only if a field of the same name is declared in Survey Flow.</p>
            </div>
          </details>

          <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 8 }}>
            <table className="grid" style={{ minWidth: 520 }} data-testid="ds-sample">
              <caption className="muted" style={{ textAlign: "left", padding: "6px 10px", fontSize: 12 }}>The first {preview.sample.length} of {preview.summary.people}</caption>
              <thead><tr><th>Name</th><th>Email</th><th>Their ID</th><th>Extra information</th></tr></thead>
              <tbody>
                {preview.sample.map((p, i) => (
                  <tr key={i}><td>{p.name ?? "—"}</td><td className="mono">{p.email ?? "—"}</td><td className="mono">{p.external_id ?? "—"}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{Object.entries(p.embedded).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(", ") || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* -------------------------------------------------------------- 4 */}
          <p style={{ ...head, marginTop: 14 }}><span style={step}>4</span>Add them</p>
          {preview.blocking ? <div className="chip warn" data-testid="ds-blocking">{preview.blocking.replace(/^./, (c) => c.toUpperCase())}.</div> : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn primary" disabled={busy || adding === 0 || dirty} data-testid="ds-commit" onClick={() => void commit()}>
                {busy ? "Adding…" : adding === 0 ? "Nobody new to add" : `Add ${adding} ${adding === 1 ? "person" : "people"}${theList ? ` to “${theList}”` : ""}`}
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>{dirty ? "You changed a column. Press “Check again” first." : "Adding people does not send anything. You send invitations afterwards."}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
