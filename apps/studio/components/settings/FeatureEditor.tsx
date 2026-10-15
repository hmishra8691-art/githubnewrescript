"use client";
import React from "react";
import { api } from "@/lib/useSession";
import {
  blockedReason, catalogFor, changes, chooseProvider, draftFromFeature, fallbackKeysToSave, FEATURE_META, isDirty, keysFor, modeWords, platformBackstopAvailable, problems,
  providerIndex, saveBody, testBody, testWords,
  type CatalogProvider, type Draft, type DraftFallback, type FeatureState, type Overview, type TestRecord,
} from "@/lib/byok/settingsModel";

/**
 * ONE FEATURE'S CONNECTION: who provides the AI (the platform, or my own
 * provider), which provider and model, the key, the fallbacks, Test
 * Connection, Save.
 *
 * A key is a password field that is never prefilled. A saved key is shown as
 * its mask and chosen by id; typing a new one replaces it on save. Nothing the
 * server says about a key ever contains the key.
 *
 * Every edit is a DRAFT. What differs from what is saved is marked, field by
 * field, and the section says "Unsaved changes" until Save or Discard — so a
 * person always knows whether what they see is what is in force.
 */

const LABELS: Record<string, string> = {
  mode: "Who provides the AI", provider: "Provider", base: "Address", model: "Model", modelSmall: "Small model", embeddingsModel: "Embeddings model", visionModel: "Vision model", language: "Language",
  extra: "Identifiers", key: "API key", fallbacks: "Fallbacks", allowPlatformFallback: "Platform last resort",
};

interface Props {
  overview: Overview;
  feature: FeatureState;
  onSaved: (o: Overview) => void;
  onDirty: (feature: string, dirty: boolean) => void;
  onKeysChanged: () => void;
}

interface ModelList { models: { id: string; label: string; capabilities: string[]; intelligent: boolean }[]; message: string | null; discovered: boolean }

export function FeatureEditor({ overview, feature, onSaved, onDirty, onKeysChanged }: Props) {
  const meta = FEATURE_META[feature.feature];
  const idx = React.useMemo(() => providerIndex(overview), [overview]);
  const catalog = catalogFor(overview, meta.kind);
  const saved = React.useMemo(() => draftFromFeature(feature), [feature]);
  const [draft, setDraft] = React.useState<Draft>(saved);
  const savedRef = React.useRef<Draft>(saved);
  const [busy, setBusy] = React.useState<null | "save" | "test" | "models">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [test, setTest] = React.useState<(TestRecord & { jsonMode?: boolean }) | null>(null);
  const [models, setModels] = React.useState<ModelList | null>(null);
  const [armedPlatform, setArmedPlatform] = React.useState(false);

  /* a refreshed overview re-baselines this editor only when it had no unsaved work of its own */
  React.useEffect(() => {
    const before = savedRef.current;
    setDraft((cur) => (isDirty(cur, before) ? cur : saved));
    savedRef.current = saved;
  }, [saved]);

  const dirtyParts = changes(draft, saved);
  const dirty = dirtyParts.length > 0;
  React.useEffect(() => { onDirty(feature.feature, dirty); }, [dirty, feature.feature, onDirty]);
  React.useEffect(() => () => onDirty(feature.feature, false), [feature.feature, onDirty]);
  React.useEffect(() => { if (!armedPlatform) return; const t = setTimeout(() => setArmedPlatform(false), 5000); return () => clearTimeout(t); }, [armedPlatform]);

  const def: CatalogProvider | undefined = idx.get(draft.provider);
  const chatReuse = def?.kind === "translate" && def.id === "llm";
  const blocked = blockedReason(overview, feature);
  const keys = def ? keysFor(overview, def.id) : [];
  const local = problems(draft, def, () => true);
  /* Test Connection needs only the main connection to be complete; Save needs the fallbacks too */
  const primaryIncomplete = Object.keys(local).some((k) => !k.startsWith("fallback."));
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setTest(null); };
  const mark = (part: string) => (dirtyParts.includes(part) ? " fe-changed" : "");
  const err = (k: string) => fieldErrors[k] ?? null;

  const pickProvider = (id: string) => {
    const p = idx.get(id);
    setDraft((d) => chooseProvider(d, p, p ? keysFor(overview, p.id) : []));
    setModels(null); setTest(null); setFieldErrors({}); setError(null);
  };

  const switchMode = (mode: "platform" | "user") => {
    if (mode === "user" && blocked) return;
    setError(null); setFieldErrors({}); setTest(null);
    if (mode === "platform") { setDraft({ ...draftFromFeature({ ...feature, mode: "platform", config: null, credential: null, fallbacks: [] }) }); return; }
    setDraft((d) => (d.mode === "user" ? d : (saved.mode === "user" ? saved : { ...d, mode: "user" })));
  };

  const findModels = async () => {
    if (!def) return;
    setBusy("models"); setError(null);
    const r = await api<ModelList & { ok: true }>("/api/account/ai/models", { method: "POST", json: { provider: def.id, base: def.customBase ? draft.base : undefined, extra: draft.extra, ...(draft.newKey.trim() ? { apiKey: draft.newKey.trim() } : draft.credentialId ? { credentialId: draft.credentialId } : {}) } });
    setBusy(null);
    if (!r.ok) { setError(r.error); setModels(null); return; }
    setModels({ models: r.data.models.length ? r.data.models : (r.data as unknown as { suggestions: ModelList["models"] }).suggestions ?? [], message: r.data.message, discovered: r.data.discovered });
  };

  const runTest = async () => {
    setBusy("test"); setError(null); setFieldErrors({}); setTest(null);
    const r = await api<{ ok: true; result: TestRecord & { jsonMode?: boolean } }>("/api/account/ai/test", { method: "POST", json: testBody(feature.feature, draft, idx) });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      const p = (r.data as { problems?: Record<string, string> } | undefined)?.problems;
      if (p) setFieldErrors(p);
      return;
    }
    setTest(r.data.result);
    onKeysChanged();
  };

  const save = async () => {
    setBusy("save"); setError(null); setFieldErrors({});
    /* a fallback's typed key is saved first, so the setting can name it by id; the key is never in the setting itself */
    const ids: (string | null)[] = draft.fallbacks.map((f) => f.credentialId);
    for (const k of fallbackKeysToSave(draft)) {
      const r = await api<{ ok: true; credential: { id: string } }>("/api/account/ai/credentials", { method: "POST", json: { provider: k.provider, apiKey: k.apiKey } });
      if (!r.ok) { setBusy(null); setError(r.error); setFieldErrors({ [`fallback.${k.index}.key`]: r.error }); return; }
      ids[k.index] = r.data.credential.id;
    }
    const r = await api<Overview & { ok: true }>("/api/account/ai", { method: "PUT", json: saveBody(feature.feature, draft, idx, ids) });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      const p = (r.data as { problems?: Record<string, string> } | undefined)?.problems;
      if (p) setFieldErrors(p);
      return;
    }
    setTest(null); setArmedPlatform(false);
    const next = r.data;
    /* the typed key leaves the field the moment it is saved */
    savedRef.current = draftFromFeature(next.features.find((x) => x.feature === feature.feature)!);
    setDraft(savedRef.current);
    onSaved(next);
  };

  const words = modeWords(feature, idx);
  const last = testWords(feature.lastTest);
  const backstop = platformBackstopAvailable(overview, meta.kind);

  return (
    <div className="card fe-card" data-testid={`ai-feature-${feature.feature}`} data-dirty={dirty ? "1" : "0"} data-mode={saved.mode}>
      <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
        <div className="card-title" style={{ margin: 0 }}>{meta.title}</div>
        <span className={`chip ${saved.mode === "user" ? "on" : ""}`} data-testid={`ai-feature-${feature.feature}-mode`}>{words.headline}</span>
        <span className="grow" />
        {dirty && <span className="chip warn" data-testid={`ai-feature-${feature.feature}-unsaved`} title={dirtyParts.map((p) => LABELS[p] ?? p).join(", ")}>Unsaved changes</span>}
      </div>
      <p className="muted fe-blurb">{meta.blurb}</p>
      <ul className="fe-covers muted">{meta.covers.map((c) => <li key={c}>{c}</li>)}</ul>

      {blocked && <div className="auth-note" data-testid={`ai-feature-${feature.feature}-blocked`}>{blocked}</div>}

      <fieldset className={`fe-modes${mark("mode")}`}>
        <legend className="flabel">Who provides the AI</legend>
        <label className="fe-radio">
          <input type="radio" name={`mode-${feature.feature}`} checked={draft.mode === "platform"} onChange={() => switchMode("platform")} data-testid={`ai-${feature.feature}-mode-platform`} />
          <span><strong>Platform AI</strong><span className="muted"> — provided and billed by the platform, as it has always been.</span></span>
        </label>
        <label className="fe-radio">
          <input type="radio" name={`mode-${feature.feature}`} checked={draft.mode === "user"} disabled={!!blocked} onChange={() => switchMode("user")} data-testid={`ai-${feature.feature}-mode-user`} />
          <span><strong>My own provider</strong><span className="muted"> — your key, your provider, your agreement. Not charged by the platform.</span></span>
        </label>
      </fieldset>

      {draft.mode === "platform" && saved.mode === "user" && (
        <p className="muted fe-note">Saving returns this feature to the platform's AI and clears its connection. Your saved keys are kept (see <a href="#ai-keys">Saved API keys</a>).</p>
      )}

      {draft.mode === "user" && (
        <div className="fe-form" data-testid={`ai-${feature.feature}-form`}>
          <div className={`fe-field${mark("provider")}`}>
            <label className="flabel" htmlFor={`prov-${feature.feature}`}>Provider</label>
            <select id={`prov-${feature.feature}`} className="input" value={draft.provider} onChange={(e) => pickProvider(e.target.value)} data-testid={`ai-${feature.feature}-provider`}>
              <option value="">Choose a provider…</option>
              {catalog.map((p) => <option key={p.id} value={p.id}>{p.id === "llm" ? "My AI model (Other AI features)" : p.label}</option>)}
            </select>
            {(err("provider") || local.provider) && !draft.provider && <div className="fe-err">{err("provider") ?? local.provider}</div>}
            {def?.notes && <div className="muted fe-help">{def.notes}</div>}
            {def?.docsUrl && <div className="fe-help"><a href={def.docsUrl} target="_blank" rel="noreferrer noopener">{def.label} documentation</a></div>}
          </div>

          {def && def.customBase && (
            <div className={`fe-field${mark("base")}`}>
              <label className="flabel" htmlFor={`base-${feature.feature}`}>Address</label>
              <input id={`base-${feature.feature}`} className="input" value={draft.base} onChange={(e) => set({ base: e.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} data-testid={`ai-${feature.feature}-base`} />
              <div className="muted fe-help">https only. Addresses on private networks are refused.</div>
              {(err("base") || local.base) && <div className="fe-err">{err("base") ?? local.base}</div>}
            </div>
          )}
          {def && !def.customBase && def.base && (
            <div className="muted fe-help" data-testid={`ai-${feature.feature}-fixed-base`}>Address: <span className="mono">{def.base}</span> (fixed for this provider)</div>
          )}

          {def && def.fields.map((f) => (
            <div key={f.id} className={`fe-field${mark("extra")}`}>
              <label className="flabel" htmlFor={`x-${feature.feature}-${f.id}`}>{f.label}{f.required ? "" : " (optional)"}</label>
              <input id={`x-${feature.feature}-${f.id}`} className="input" value={draft.extra[f.id] ?? ""} onChange={(e) => set({ extra: { ...draft.extra, [f.id]: e.target.value } })} placeholder={f.example} autoComplete="off" spellCheck={false} data-testid={`ai-${feature.feature}-extra-${f.id}`} />
              <div className="muted fe-help">{f.help}</div>
              {(err(`extra.${f.id}`) || local[`extra.${f.id}`]) && <div className="fe-err">{err(`extra.${f.id}`) ?? local[`extra.${f.id}`]}</div>}
            </div>
          ))}

          {def && !chatReuse && (
            <KeyField
              testid={`ai-${feature.feature}`} providerLabel={def.label} keys={keys} credentialId={draft.credentialId} newKey={draft.newKey} changed={dirtyParts.includes("key")}
              error={err("apiKey") ?? err("key") ?? (local.key && (draft.credentialId || draft.newKey) ? local.key : null)}
              onChoose={(id) => set({ credentialId: id, newKey: "" })} onType={(v) => set({ newKey: v })}
            />
          )}
          {chatReuse && <p className="muted fe-note" data-testid={`ai-${feature.feature}-reuse`}>“My AI model” has no key of its own: it translates with the connection saved under <a href="#ai-additional">Other AI features</a> — its key, model and fallbacks.</p>}

          {def && def.kind !== "translate" && (
            <div className={`fe-field${mark("model")}`}>
              <label className="flabel" htmlFor={`model-${feature.feature}`}>Model</label>
              <div className="row" style={{ gap: 8 }}>
                <input id={`model-${feature.feature}`} className="input grow" list={`models-${feature.feature}`} value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder={def.hints[0]?.id ?? "model name"} autoComplete="off" spellCheck={false} data-testid={`ai-${feature.feature}-model`} />
                <button type="button" className="btn small" onClick={() => void findModels()} disabled={busy !== null || (!draft.credentialId && !draft.newKey.trim())} data-testid={`ai-${feature.feature}-find-models`}>{busy === "models" ? "Looking…" : def.canListModels ? "Find models" : "Suggestions"}</button>
              </div>
              <datalist id={`models-${feature.feature}`}>{(models?.models ?? def.hints.map((h) => ({ id: h.id, label: h.label }))).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
              {models && (
                <div className="muted fe-help" data-testid={`ai-${feature.feature}-models-note`}>
                  {models.discovered ? `${models.models.length} model${models.models.length === 1 ? "" : "s"} your key can use.` : (models.message ?? "Suggestions only — Test Connection confirms the model works for your account.")}
                  {models.models.length > 0 && (
                    <div className="fe-chips">{models.models.slice(0, 12).map((m) => <button key={m.id} type="button" className="chip" onClick={() => set({ model: m.id })}>{m.id}{m.intelligent ? " ★" : ""}</button>)}</div>
                  )}
                </div>
              )}
              {feature.feature === "intelligent" && <div className="muted fe-help">★ suits Intelligent Mode. The Test Connection step checks the model accepts structured (JSON) answers.</div>}
              {(err("model") || local.model) && <div className="fe-err">{err("model") ?? local.model}</div>}
            </div>
          )}

          {def && def.kind === "chat" && (
            <details className="fe-adv">
              <summary>Optional models</summary>
              {([["modelSmall", "Small model", "A cheaper model for short tasks. Leave empty to use the model above."], ["embeddingsModel", "Embeddings model", "Used for research search. Leave empty if your provider has none."], ["visionModel", "Vision model", "Used to read images. Leave empty to use the model above."]] as const).map(([k, label, help]) => (
                <div key={k} className={`fe-field${mark(k)}`}>
                  <label className="flabel" htmlFor={`${k}-${feature.feature}`}>{label}</label>
                  <input id={`${k}-${feature.feature}`} className="input" value={draft[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)} autoComplete="off" spellCheck={false} data-testid={`ai-${feature.feature}-${k}`} />
                  <div className="muted fe-help">{help}</div>
                  {err(k) && <div className="fe-err">{err(k)}</div>}
                </div>
              ))}
            </details>
          )}

          {def && def.kind === "stt" && (
            <div className={`fe-field${mark("language")}`}>
              <label className="flabel" htmlFor={`lang-${feature.feature}`}>Usual language (optional)</label>
              <input id={`lang-${feature.feature}`} className="input" value={draft.language} onChange={(e) => set({ language: e.target.value })} placeholder="en, en-US, pt-BR" autoComplete="off" spellCheck={false} data-testid={`ai-${feature.feature}-language`} />
              <div className="muted fe-help">Helps accuracy when recordings are mostly in one language. Leave empty to let the provider detect it.</div>
              {err("language") && <div className="fe-err">{err("language")}</div>}
            </div>
          )}

          {def && !chatReuse && (
            <Fallbacks
              feature={feature.feature} overview={overview} kind={meta.kind} idx={idx} fallbacks={draft.fallbacks} changed={dirtyParts.includes("fallbacks")} errors={fieldErrors} local={local}
              onChange={(fallbacks) => set({ fallbacks })}
            />
          )}

          {def && !chatReuse && (
            <label className={`fe-check${mark("allowPlatformFallback")}`}>
              <input type="checkbox" checked={draft.allowPlatformFallback} disabled={!backstop} onChange={(e) => set({ allowPlatformFallback: e.target.checked })} data-testid={`ai-${feature.feature}-allow-platform`} />
              <span>
                <strong>Allow the platform's AI as a last resort</strong>
                <span className="muted"> — if your provider and every fallback fail, the platform answers instead, and that call is <u>billed to your wallet as platform usage</u>. Off by default: without this, a failure is shown to you and nothing is charged.</span>
                {!backstop && <span className="muted"> The platform has no {meta.kind === "stt" ? "speech-to-text" : meta.kind === "translate" ? "translation" : "AI"} provider configured, so this is unavailable.</span>}
              </span>
            </label>
          )}
        </div>
      )}

      {error && <div className="auth-note err" role="alert" data-testid={`ai-${feature.feature}-error`}>{error}</div>}
      {test && (
        <div className={`auth-note ${test.ok ? "ok" : "err"}`} role="status" data-testid={`ai-${feature.feature}-test-result`} data-ok={test.ok ? "1" : "0"}>
          <strong>{test.ok ? "Connection works." : "Connection failed."}</strong> {test.message}{typeof test.latencyMs === "number" ? ` (${test.latencyMs} ms)` : ""}
        </div>
      )}

      <div className="row fe-actions">
        {draft.mode === "user" && def && (
          <button type="button" className="btn" onClick={() => void runTest()} disabled={busy !== null || primaryIncomplete} data-testid={`ai-${feature.feature}-test`} title={primaryIncomplete ? "Complete the fields above first" : "Sends one tiny request to your provider"}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        <span className="grow" />
        {dirty && <button type="button" className="btn" onClick={() => { setDraft(saved); setTest(null); setError(null); setFieldErrors({}); setModels(null); }} disabled={busy !== null} data-testid={`ai-${feature.feature}-discard`}>Discard changes</button>}
        {draft.mode === "platform" && saved.mode === "user" ? (
          <button type="button" className="btn danger" onClick={() => (armedPlatform ? void save() : setArmedPlatform(true))} disabled={busy !== null} data-testid={`ai-${feature.feature}-save`}>{busy === "save" ? "Saving…" : armedPlatform ? "Confirm: use platform AI" : "Save"}</button>
        ) : (
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!dirty || busy !== null || (draft.mode === "user" && Object.keys(local).length > 0)} data-testid={`ai-${feature.feature}-save`}>{busy === "save" ? "Saving…" : "Save"}</button>
        )}
      </div>

      <div className="muted fe-last" data-testid={`ai-${feature.feature}-last`} data-tone={last.tone}>
        {saved.mode === "user" ? <>Saved: {words.detail}. {last.text}.</> : <>In force: platform AI.</>}
        {feature.updatedAt && saved.mode === "user" ? ` Updated ${new Date(feature.updatedAt).toLocaleString()}.` : ""}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ key */

function KeyField({ testid, providerLabel, keys, credentialId, newKey, changed, error, onChoose, onType }: {
  testid: string; providerLabel: string; keys: Overview["credentials"]; credentialId: string | null; newKey: string; changed: boolean; error: string | null;
  onChoose: (id: string | null) => void; onType: (v: string) => void;
}) {
  const saved = keys.find((k) => k.id === credentialId) ?? null;
  const [typing, setTyping] = React.useState(!saved);
  React.useEffect(() => { if (saved && !newKey) setTyping(false); }, [saved, newKey]);
  return (
    <div className={`fe-field${changed ? " fe-changed" : ""}`}>
      <label className="flabel" htmlFor={`${testid}-key`}>API key</label>
      {keys.length > 0 && (
        <select className="input" value={typing ? "__new" : (credentialId ?? "")} onChange={(e) => { if (e.target.value === "__new") { setTyping(true); onChoose(null); } else { setTyping(false); onChoose(e.target.value); } }} data-testid={`${testid}-key-select`}>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.label ? `${k.label} · ` : ""}{k.mask}</option>)}
          <option value="__new">Use a different key…</option>
        </select>
      )}
      {(typing || keys.length === 0) && (
        <input id={`${testid}-key`} className="input" type="password" value={newKey} onChange={(e) => onType(e.target.value)} placeholder={`Paste your ${providerLabel} API key`} autoComplete="new-password" spellCheck={false} data-testid={`${testid}-key`} />
      )}
      {saved && !typing && (
        <div className="fe-help muted" data-testid={`${testid}-key-saved`}>Saved key <span className="mono">{saved.mask}</span>. To replace it, add the new one under Saved API keys, or choose “Use a different key…”.</div>
      )}
      <div className="muted fe-help">Stored encrypted. Shown only as a mask after saving — never displayed again, never sent to anyone but {providerLabel}.</div>
      {error && <div className="fe-err">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ fallbacks */

function Fallbacks({ feature, overview, kind, idx, fallbacks, changed, errors, local, onChange }: {
  feature: string; overview: Overview; kind: "chat" | "stt" | "translate"; idx: Map<string, CatalogProvider>; fallbacks: DraftFallback[]; changed: boolean;
  errors: Record<string, string>; local: Record<string, string>; onChange: (f: DraftFallback[]) => void;
}) {
  const options = catalogFor(overview, kind).filter((p) => !(p.kind === "translate" && p.id === "llm"));
  const patch = (i: number, p: Partial<DraftFallback>) => onChange(fallbacks.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div className={`fe-field fe-fallbacks${changed ? " fe-changed" : ""}`} data-testid={`ai-${feature}-fallbacks`}>
      <div className="flabel">Fallback providers</div>
      <div className="muted fe-help">Tried in this order when your main provider fails in a way another provider could fix (a rejected key, no credit, rate limit, outage). Never another person's key.</div>
      {fallbacks.map((f, i) => {
        const def = idx.get(f.provider);
        const keys = def ? keysFor(overview, def.id) : [];
        return (
          <div key={i} className="fe-fb" data-testid={`ai-${feature}-fallback-${i}`}>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <strong>{i + 1}.</strong>
              <select className="input" value={f.provider} onChange={(e) => { const p = idx.get(e.target.value); const k = p ? keysFor(overview, p.id) : []; patch(i, { provider: e.target.value, base: p?.customBase ? "" : (p?.base ?? ""), model: "", extra: {}, credentialId: k.length === 1 ? k[0].id : null, newKey: "" }); }} data-testid={`ai-${feature}-fallback-${i}-provider`}>
                <option value="">Choose a provider…</option>
                {options.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <span className="grow" />
              <button type="button" className="btn small" onClick={() => onChange(fallbacks.filter((_, j) => j !== i))} data-testid={`ai-${feature}-fallback-${i}-remove`}>Remove</button>
            </div>
            {def?.customBase && <input className="input" value={f.base} onChange={(e) => patch(i, { base: e.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} />}
            {def && def.fields.map((fl) => <input key={fl.id} className="input" value={f.extra[fl.id] ?? ""} onChange={(e) => patch(i, { extra: { ...f.extra, [fl.id]: e.target.value } })} placeholder={`${fl.label}${fl.required ? "" : " (optional)"} — e.g. ${fl.example}`} autoComplete="off" spellCheck={false} />)}
            {def && def.kind !== "translate" && <input className="input" value={f.model} onChange={(e) => patch(i, { model: e.target.value })} placeholder="Model" list={`fbm-${feature}-${i}`} autoComplete="off" spellCheck={false} data-testid={`ai-${feature}-fallback-${i}-model`} />}
            {def && <datalist id={`fbm-${feature}-${i}`}>{def.hints.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</datalist>}
            {def && (
              <div className="row" style={{ gap: 8 }}>
                {keys.length > 0 && (
                  <select className="input" value={f.newKey ? "__new" : (f.credentialId ?? "")} onChange={(e) => (e.target.value === "__new" ? patch(i, { credentialId: null }) : patch(i, { credentialId: e.target.value, newKey: "" }))} data-testid={`ai-${feature}-fallback-${i}-key-select`}>
                    {!f.credentialId && !f.newKey && <option value="">Choose a saved key…</option>}
                    {keys.map((k) => <option key={k.id} value={k.id}>{k.label ? `${k.label} · ` : ""}{k.mask}</option>)}
                    <option value="__new">Use a different key…</option>
                  </select>
                )}
                {(keys.length === 0 || (!f.credentialId)) && <input className="input grow" type="password" value={f.newKey} onChange={(e) => patch(i, { newKey: e.target.value, credentialId: null })} placeholder={`Paste your ${def.label} API key`} autoComplete="new-password" spellCheck={false} data-testid={`ai-${feature}-fallback-${i}-key`} />}
              </div>
            )}
            {(errors[`fallback.${i}.key`] || local[`fallback.${i}.key`] || local[`fallback.${i}.model`] || local[`fallback.${i}.provider`]) && (
              <div className="fe-err">{errors[`fallback.${i}.key`] ?? local[`fallback.${i}.provider`] ?? local[`fallback.${i}.model`] ?? local[`fallback.${i}.key`]}</div>
            )}
          </div>
        );
      })}
      {fallbacks.length < 3 && <button type="button" className="btn small" onClick={() => onChange([...fallbacks, { provider: "", base: "", model: "", extra: {}, credentialId: null, newKey: "" }])} data-testid={`ai-${feature}-add-fallback`}>Add a fallback</button>}
    </div>
  );
}
