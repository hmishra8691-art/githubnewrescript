/**
 * PATCHES CARRIED BETWEEN COPIES OF THE REPOSITORY — STAMP AND CHECK THEIR BASE (2026-11-23).
 *
 * Patches made in one copy (an .mbox from `git format-patch`) are applied to another whose commits have different
 * ids (they are recreated there), so `base-commit:` cannot be compared. The TREE they were made on can:
 *
 *   node scripts/patch-base.mjs stamp <file.mbox> [<rev>]
 *       write "Base-Tree: <tree of rev^>" (rev defaults to HEAD) into the patch's notes area, after the "---" line
 *       — `git apply` / `git am` ignore it, and it never enters the commit message
 *
 *   node scripts/patch-base.mjs check [--onto <rev>] <first.mbox> [<more.mbox> …]
 *       before applying, in the copy that will receive them (rev defaults to main):
 *         · the first patch's Base-Tree is <rev>'s tree — otherwise the branch has moved on (or lags), and the
 *           files that differ are listed
 *         · no patch adds a migration whose number <rev> already has, nor two patches the same number
 *       exit 1 on either
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const [cmd, ...rest] = process.argv.slice(2);

/** the migration files a patch adds */
export const addedMigrations = (mbox) => [...mbox.matchAll(/^diff --git a\/(supabase\/migrations\/(\d{4})_[^\s]+\.sql) b\/\1\nnew file mode/gm)].map((m) => ({ path: m[1], num: m[2] }));
export const baseTreeOf = (mbox) => /^Base-Tree: ([0-9a-f]{40})$/m.exec(mbox)?.[1] ?? null;

if (cmd === "stamp") {
  const [file, rev = "HEAD"] = rest;
  if (!file) { console.error("usage: patch-base.mjs stamp <file.mbox> [<rev>]"); process.exit(2); }
  const tree = git("rev-parse", `${rev}^^{tree}`);
  let text = readFileSync(file, "utf8").replace(/^Base-Tree: [0-9a-f]{40}\n/m, "");
  const at = text.search(/^---$/m);
  if (at < 0) { console.error(`${file}: no "---" line — is it a format-patch mbox?`); process.exit(2); }
  const eol = text.indexOf("\n", at) + 1;
  text = `${text.slice(0, eol)}Base-Tree: ${tree}\n${text.slice(eol)}`;
  writeFileSync(file, text);
  console.log(`${file}: Base-Tree ${tree} (the tree of ${rev}^)`);
} else if (cmd === "check") {
  let onto = "main";
  const files = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--onto") onto = rest[++i]; else files.push(rest[i]); }
  if (!files.length) { console.error("usage: patch-base.mjs check [--onto <rev>] <first.mbox> [<more.mbox> …]"); process.exit(2); }
  const problems = [];
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const want = baseTreeOf(texts[0]);
  const have = git("rev-parse", `${onto}^{tree}`);
  if (!want) problems.push(`${files[0]} carries no Base-Tree (stamp it where it was made)`);
  else if (want !== have) {
    let diff = "";
    try { diff = git("diff", "--stat", want, have); } catch { diff = "(that tree is not in this repository — the branch it was made on has commits this copy lacks)"; }
    problems.push(`${onto} has moved: the patches were made on tree ${want.slice(0, 12)}, ${onto} is ${have.slice(0, 12)}\n${diff}`);
  }
  const existing = new Set(git("ls-tree", "--name-only", `${onto}:supabase/migrations`).split("\n").map((n) => n.slice(0, 4)));
  const seen = new Map();
  texts.forEach((t, i) => {
    for (const m of addedMigrations(t)) {
      if (existing.has(m.num)) problems.push(`${files[i]} adds ${m.path}, but ${onto} already has a migration ${m.num}`);
      if (seen.has(m.num)) problems.push(`${files[i]} and ${seen.get(m.num)} both add a migration ${m.num}`);
      seen.set(m.num, files[i]);
    }
  });
  if (problems.length) { for (const p of problems) console.error(`  ✗ ${p}`); process.exit(1); }
  console.log(`patch-base: ${files.length} patch(es) made on ${onto}'s tree; no migration number clashes`);
} else {
  console.error("usage: patch-base.mjs stamp <file.mbox> [<rev>] | check [--onto <rev>] <first.mbox> …");
  process.exit(2);
}
