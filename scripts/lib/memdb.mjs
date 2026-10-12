/**
 * A tiny in-memory stand-in for the Supabase client — the chain the analytics
 * apply/undo code uses, with real filter semantics — over arrays the caller
 * owns (so a fake backend and the code under test see the same rows).
 */
export function memoryDb(tables, { idPrefix = "00000000-0000-4000-8000-" } = {}) {
  let n = 0;
  class Q {
    constructor(table) { this.table = table; this.mode = "select"; this.filters = []; }
    select() { return this; }
    insert(row) { this.mode = "insert"; this.payload = row; return this; }
    update(p) { this.mode = "update"; this.payload = p; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.maybe = true; return this; }
    run() {
      const t = (tables[this.table] ??= []);
      let rows;
      if (this.mode === "insert") { const row = { id: `${idPrefix}${String(++n).padStart(12, "0")}`, deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...this.payload }; t.push(row); rows = [row]; }
      else { rows = t.filter((r) => this.filters.every((f) => f(r))); if (this.mode === "update") for (const r of rows) Object.assign(r, this.payload, { updated_at: new Date().toISOString() }); }
      if (this.one) return rows.length ? { data: { ...rows[0] }, error: null } : { data: null, error: { message: "no rows" } };
      if (this.maybe) return { data: rows[0] ? { ...rows[0] } : null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    then(ok, no) { return Promise.resolve(this.run()).then(ok, no); }
  }
  return { from: (t) => new Q(t) };
}
