/**
 * Version numbering for survey snapshots (requirement §12).
 *
 * The editor cannot know which versions exist — after restoring an older
 * version its in-memory number is behind the database — so the *server*
 * resolves the next number from the versions actually stored.
 */

export function parseVersion(v: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return -1;
  if (!pb) return 1;
  return pa[0] - pb[0] || pa[1] - pb[1];
}

/**
 * Pick the version string for a new snapshot.
 *
 * - `requested` is honoured when given and still free (lets a programmer cut
 *   a deliberate "2.0").
 * - Otherwise the next minor after the highest existing version is used, so
 *   Save can never dead-end on a collision.
 */
export function nextVersion(taken: Iterable<string>, requested?: string): string {
  const used = new Set<string>();
  for (const v of taken) used.add(String(v).trim());

  const wanted = requested?.trim();
  if (wanted && parseVersion(wanted) && !used.has(wanted)) return wanted;

  let major = 1;
  let minor = 0;
  let seen = false;
  for (const v of used) {
    const p = parseVersion(v);
    if (!p) continue;
    seen = true;
    if (p[0] > major || (p[0] === major && p[1] > minor)) {
      major = p[0];
      minor = p[1];
    }
  }

  if (!seen) {
    // no parseable versions yet: start at 1.0, stepping past odd strings
    let candidate = "1.0";
    let n = 0;
    while (used.has(candidate)) candidate = `1.${++n}`;
    return candidate;
  }

  let candidate = `${major}.${minor + 1}`;
  let guard = 0;
  while (used.has(candidate) && guard++ < 10000) {
    minor += 1;
    candidate = `${major}.${minor + 1}`;
  }
  return candidate;
}
