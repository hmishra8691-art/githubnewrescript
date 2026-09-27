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
    out.set(name, {
      name, size: usize,
      data: () => (method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw)) : (() => { throw new Error(`${name}: unsupported zip compression ${method}`); })()),
    });
  }
  return out;
}

export function zipText(zip: Map<string, ZipEntry>, name: string): string | null {
  const e = zip.get(name);
  return e ? new TextDecoder().decode(e.data()) : null;
}
