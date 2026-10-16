/**
 * A Map with a ceiling (audit ANALYTICS-11).
 *
 * The analytics data-stamp cache was a plain Map keyed `survey:environment`
 * that nothing ever evicted: tiny per entry, but it grew with every survey a
 * long-lived server instance had ever reported on. This keeps the most
 * recently USED `max` entries — a read moves the key to the young end, a write
 * past the ceiling drops the oldest — using the Map's own insertion order, so
 * every operation is O(1).
 */
export class BoundedLru<K, V> {
  private readonly map = new Map<K, V>();
  readonly max: number;
  constructor(max: number) {
    this.max = max;
    if (!Number.isInteger(max) || max < 1) throw new Error("BoundedLru needs a positive integer size");
  }
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key); this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }
  delete(key: K): boolean { return this.map.delete(key); }
  has(key: K): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }
}
