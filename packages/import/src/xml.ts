/**
 * A SMALL, TOLERANT XML READER — enough for Decipher projects and the XML
 * inside Office files, and nothing more.
 *
 * Elements, attributes, text, CDATA, comments, processing instructions and
 * the five named entities plus numeric ones. No DTDs, no namespaces beyond
 * keeping the prefix in the name (`w:t`, `builder:wrap`), no validation. A
 * malformed file is read as far as it can be and the problem reported in
 * `errors`, because a questionnaire with one stray `&` should still import.
 *
 * Hand-rolled because the monorepo declares no XML library, and the ones in
 * the lockfile arrive only as other packages' dependencies.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** text directly inside this element, in order, CDATA included */
  text: string;
  /** the element's inner markup as written — Decipher titles carry HTML */
  inner?: string;
}

export interface XmlDoc { root: XmlNode | null; errors: string[] }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string, opts: { keepInner?: (name: string) => boolean } = {}): XmlDoc {
  const errors: string[] = [];
  const stack: { node: XmlNode; innerStart: number }[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  const n = src.length;
  const top = () => stack[stack.length - 1]?.node;
  const addText = (t: string) => { const p = top(); if (p) p.text += t; };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { addText(decodeEntities(src.slice(i))); break; }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); addText(src.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith("<!", lt)) { const e = src.indexOf(">", lt + 2); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt + 2);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      // pop to the matching open element; tolerate a missing close
      let k = stack.length - 1;
      while (k >= 0 && stack[k].node.name !== name) k--;
      if (k < 0) errors.push(`closing </${name}> with no open element at ${lt}`);
      else {
        while (stack.length - 1 > k) { const lost = stack.pop()!; errors.push(`<${lost.node.name}> not closed before </${name}>`); }
        const done = stack.pop()!;
        if (opts.keepInner?.(done.node.name)) done.node.inner = src.slice(done.innerStart, lt);
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    // an opening tag: read name and attributes, honouring quotes
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(lt + 1, j);
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "/" && src[j + 1] === ">") { selfClose = true; j += 2; break; }
      if (src[j] === ">") { j++; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); attrs[an] = decodeEntities(src.slice(j + 1, e < 0 ? n : e)); j = e < 0 ? n : e + 1; }
        else { let e = j; while (e < n && !/[\s>]/.test(src[e])) e++; attrs[an] = decodeEntities(src.slice(j, e)); j = e; }
      } else if (an) attrs[an] = "";
      if (!an) j++;
    }
    const node: XmlNode = { name, attrs, children: [], text: "" };
    const parent = top();
    if (parent) parent.children.push(node); else if (!root) root = node; else errors.push(`a second root element <${name}>`);
    if (!selfClose) stack.push({ node, innerStart: j });
    i = j;
  }
  for (const s of stack) errors.push(`<${s.node.name}> not closed at end of file`);
  return { root, errors };
}

/** children by name */
export const kids = (n: XmlNode | undefined, name?: string): XmlNode[] => (n ? (name ? n.children.filter((c) => c.name === name) : n.children) : []);
export const kid = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
/** all text in the subtree, in document order */
export function allText(n: XmlNode | undefined): string {
  if (!n) return "";
  let out = n.text;
  for (const c of n.children) out += allText(c);
  return out;
}
/** depth-first search */
export function findAll(n: XmlNode | undefined, pred: (x: XmlNode) => boolean, out: XmlNode[] = []): XmlNode[] {
  if (!n) return out;
  if (pred(n)) out.push(n);
  for (const c of n.children) findAll(c, pred, out);
  return out;
}
