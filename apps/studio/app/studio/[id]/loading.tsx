/**
 * THE STUDIO WHILE IT LOADS. The server component fetches the survey, the
 * draft and the gate before it can render anything; until then the shell is
 * drawn as itself — top bar, left navigation, canvas, properties — in
 * skeleton, so the page arrives in place rather than as a blank that jumps.
 */
export default function StudioLoading() {
  return (
    <div className="ide" aria-busy="true" aria-label="Loading the Studio">
      <div className="topbar">
        <span className="logo-mark" style={{ width: 30, height: 30, fontSize: 15 }}>R</span>
        <div className="ctx"><span className="sk" style={{ width: 220, height: 16 }} /><span className="sk" style={{ width: 140, height: 11, marginTop: 5 }} /></div>
        <span className="spacer" />
        {[88, 110, 120, 84, 70].map((w, i) => <span key={i} className="sk" style={{ width: w, height: 34, borderRadius: 10 }} />)}
        <span className="sk" style={{ width: 118, height: 36, borderRadius: 10, background: "var(--c-primary-100)" }} />
      </div>
      <div className="ide-body">
        <nav className="leftnav" aria-hidden="true">
          {[["Programming", 8], ["Research tools", 6], ["Results", 3], ["Management", 6]].map(([g, n]) => (
            <div key={String(g)}>
              <div className="nav-group">{g}</div>
              {Array.from({ length: Number(n) }).map((_, i) => <div key={i} className="nav-item" style={{ gap: 10 }}><span className="sk" style={{ width: 18, height: 18, borderRadius: 5 }} /><span className="sk" style={{ width: 70 + ((i * 37) % 60), height: 12 }} /></div>)}
            </div>
          ))}
        </nav>
        <main className="center">
          <div className="row" style={{ marginBottom: 18 }}><span className="sk" style={{ width: 150, height: 24 }} /><span className="grow" /><span className="sk" style={{ width: 110, height: 38, borderRadius: 10 }} /><span className="sk" style={{ width: 130, height: 38, borderRadius: 10 }} /></div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="row"><span className="sk" style={{ width: 64, height: 20, borderRadius: 6 }} /><span className="sk" style={{ width: 240 - i * 40, height: 14 }} /></div>
              <span className="sk" style={{ width: "72%", height: 12 }} /><span className="sk" style={{ width: "48%", height: 12 }} />
            </div>
          ))}
        </main>
        <aside className="rightpanel" aria-hidden="true">
          <span className="sk" style={{ width: 90, height: 12, marginBottom: 16, display: "block" }} />
          {[0, 1, 2, 3].map((i) => <div key={i} style={{ marginBottom: 14 }}><span className="sk" style={{ width: 80, height: 10, display: "block", marginBottom: 6 }} /><span className="sk" style={{ width: "100%", height: 36, borderRadius: 10, display: "block" }} /></div>)}
        </aside>
      </div>
    </div>
  );
}
