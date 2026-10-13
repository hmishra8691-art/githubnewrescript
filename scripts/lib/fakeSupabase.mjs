/**
 * AN IN-MEMORY SUPABASE for tests: the query chains the Studio's analytics
 * service uses (select / insert / update with eq, is, gte, lt, in, order,
 * limit, single, maybeSingle, head counts) over plain arrays, and the one RPC
 * the plan editor calls (`rescript_save_draft`, with its revision guard).
 * Timestamps are monotonic the way Postgres's microseconds are, so two rows
 * written in one millisecond still order. Used by the studio's
 * analysisPlanCore unit test and by the analysis-plan browser test, where the
 * REAL service runs over it inside the test process.
 */
let seq = 0;
export const uuid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
let tick = Date.now();
export const stamp = () => new Date(++tick).toISOString();

/* the unique indexes the story tables rely on (migration 0051) */
const ACTIVE = ["queued", "rendering", "verifying"];
const UNIQUE = {
  analytics_story_renders: [{ name: "analytics_story_renders_one_active", cols: ["story_id", "kind"], where: (r) => ACTIVE.includes(r.status ?? "queued") }],
  analytics_story_versions: [{ name: "analytics_story_versions_story_id_version_key", cols: ["story_id", "version"], where: () => true }],
  analytics_story_segments: [{ name: "analytics_story_segments_pkey", cols: ["survey_id", "hash"], where: () => true }],
};

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.op = "select"; this.filters = []; this.head = false; this.wantCount = false; this.orderBy = null; this.limitN = null; this.mode = "many"; this.payload = null; }
  select(_cols, opts) { if (opts?.head) this.head = true; if (opts?.count) this.wantCount = true; return this; }
  insert(row) { this.op = "insert"; this.payload = row; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
  is(col, v) { this.filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return this; }
  gte(col, v) { this.filters.push((r) => String(r[col]) >= v); return this; }
  lt(col, v) { this.filters.push((r) => String(r[col]) < v); return this; }
  gt(col, v) { this.filters.push((r) => String(r[col]) > v); return this; }
  delete() { this.op = "delete"; return this; }
  in(col, vs) { this.filters.push((r) => vs.includes(r[col])); return this; }
  or(expr) {
    /* `survey_id.eq.X,customer_id.eq.Y` — the one shape the analytics route writes */
    const alts = expr.split(",").map((part) => { const [col, , ...rest] = part.split("."); return { col, v: rest.join(".") }; });
    this.filters.push((r) => alts.some((a) => String(r[a.col]) === a.v));
    return this;
  }
  order(col, opts) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  limit(n) { this.limitN = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
  run() {
    const rows = this.db.tables[this.table];
    if (!rows) return { data: null, error: { message: `relation "public.${this.table}" does not exist` } };
    if (this.op === "insert") {
      const clash = (UNIQUE[this.table] ?? []).find((u) => rows.some((r) => u.where(r) && u.where(this.payload) && u.cols.every((c) => r[c] === this.payload[c])));
      if (clash) return { data: null, error: { message: `duplicate key value violates unique constraint "${clash.name}"`, code: "23505" } };
      const row = { id: uuid(), created_at: stamp(), updated_at: stamp(), ...this.payload };
      if (this.table === "analytics_plan_applies" && !this.payload?.started_at) row.started_at = stamp();
      rows.push(row);
      this.db.log.push({ op: "insert", table: this.table, row });
      return { data: this.mode === "many" ? [row] : row, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "delete") {
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      this.db.log.push({ op: "delete", table: this.table, n: hit.length });
      return { data: null, error: null };
    }
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload, { updated_at: stamp() });
      this.db.log.push({ op: "update", table: this.table, n: hit.length });
      return { data: this.mode === "many" ? hit : hit[0] ?? null, error: this.mode === "single" && !hit[0] ? { message: "no row" } : null };
    }
    if (this.orderBy) { const { col, asc } = this.orderBy; hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1)); }
    if (this.limitN != null) hit = hit.slice(0, this.limitN);
    if (this.head) return { data: null, error: null, count: hit.length };
    const data = hit.map((r) => structuredClone(r));
    if (this.mode === "single") return data[0] ? { data: data[0], error: null } : { data: null, error: { message: "no row" } };
    if (this.mode === "maybe") return { data: data[0] ?? null, error: null };
    return { data, error: null, ...(this.wantCount ? { count: data.length } : {}) };
  }
}

export class FakeDb {
  constructor() {
    /** @type {Record<string, Record<string, unknown>[]>} */
    this.tables = { surveys: [], responses: [], analytics_analyses: [], analytics_analysis_versions: [], analytics_charts: [], analytics_segments: [], analytics_themes: [], analytics_reports: [], analytics_report_versions: [], analytics_shares: [], analytics_runs: [], analytics_plan_applies: [], analytics_result_cache: [], audit_logs: [], analytics_story_reports: [], analytics_story_versions: [], analytics_story_renders: [], analytics_story_segments: [], analytics_story_themes: [] };
    /** @type {Record<string, unknown>[]} */
    this.log = [];
  }
  from(table) { return new Query(this, table); }
  async rpc(name, args) {
    if (name !== "rescript_save_draft") return { data: null, error: { message: `function ${name} does not exist` } };
    const s = this.tables.surveys.find((r) => r.id === args.p_survey_id);
    if (!s || s.revision !== args.p_base_revision) return { data: [], error: null };
    s.draft_definition = args.p_definition; s.revision = Number(s.revision) + 1; s.draft_updated_at = stamp();
    return { data: [{ revision: s.revision, draft_updated_at: s.draft_updated_at }], error: null };
  }
}
