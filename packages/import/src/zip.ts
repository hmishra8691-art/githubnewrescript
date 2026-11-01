import { inflateRawSync } from "node:zlib";

/**
 * READ A ZIP — the container Word and Excel files are.
 *
 * Walks the central directory (the end-of-central-directory record, then
 * one header per entry), so it copes with data descriptors and entries
 * written out of order. STORE and DEFLATE only, which is every Office file
 * written this century. Node's own zlib does the inflating; nothing here is
 * a dependency.
 */
export interface ZipEntry { name: string; size: number; data(): Uint8Array }

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

/**
 * Limits against a hostile archive (a "zip bomb": a few KB that inflate to
 * gigabytes). An Office file has dozens of parts and its largest part is a few
 * MB; these are far above that and far below what would hurt the server.
 */
export const ZIP_LIMITS = { maxEntries: 5000, maxEntryBytes: 100 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024, maxRatio: 400 };

export function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, ZipEntry>();
  // the end-of-central-directory record sits in the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no central directory)");
  const count = dv.getUint16(eocd + 10, true);
  if (count > ZIP_LIMITS.maxEntries) throw new Error(`the archive lists ${count} entries — more than the ${ZIP_LIMITS.maxEntries} an Office file could need`);
  let declared = 0;
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= bytes.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (dv.getUint32(local, true) !== 0x04034b50) continue;
    const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lxlen;
    const raw = bytes.subarray(start, start + csize);
    if (usize > ZIP_LIMITS.maxEntryBytes) throw new Error(`${name} would expand to ${(usize / 1048576).toFixed(0)} MB — over the ${ZIP_LIMITS.maxEntryBytes / 1048576} MB limit for one part`);
    if (csize > 0 && usize > 1024 * 1024 && usize / csize > ZIP_LIMITS.maxRatio) throw new Error(`${name} is compressed ${Math.round(usize / csize)}:1 — the shape of a zip bomb, not an Office file`);
    declared += usize;
    if (declared > ZIP_LIMITS.maxTotalBytes) throw new Error(`the archive would expand to more than ${ZIP_LIMITS.maxTotalBytes / 1048576} MB`);
    out.set(name, {
      name, size: usize,
      /* the declared size can lie: inflate never writes more than the limit */
      data: () => (method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.maxEntryBytes })) : (() => { throw new Error(`${name}: unsupported zip compression ${method}`); })()),
    });
  }
  return out;
}

export function zipText(zip: Map<string, ZipEntry>, name: string): string | null {
  const e = zip.get(name);
  return e ? new TextDecoder().decode(e.data()) : null;
}
