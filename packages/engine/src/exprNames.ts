/** The bare names a calc-language expression reads — shared by the dependency graph and the dynamic-logic lint. */
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

/** the bare names an expression reads (string literals and function names excluded) */
export function expressionNames(expression: string): string[] {
  const out = new Set<string>();
  const src = expression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ").replace(/\{\{\s*([^}]+?)\s*\}\}/g, " $1 ");
  for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_.]*(\s*\()?/g)) {
    if (m[1]) continue; // a function call
    const name = m[0].trim();
    if (!KEYWORDS.has(name.toLowerCase())) out.add(name);
  }
  return [...out];
}

