/**
 * A ZIP FILE, WITHOUT A ZIP LIBRARY.
 *
 * ## Why no dependency
 *
 * The archive this builds holds `.webm`, `.mp4` and `.wav` — bytes that a
 * codec has already compressed as hard as anything is going to. Running them
 * through DEFLATE spends CPU in a serverless function to make the file
 * fractionally *larger*, which is the standard result for compressed input.
 * So every entry is written with the STORE method, and once compression is
 * off, the entire remaining job is two record layouts and a CRC — about a
 * hundred lines, all of it here, none of it a supply chain.
 *
 * ## What is deliberately not implemented
 *
 * ZIP64, encryption, data descriptors, multi-disk archives, Unicode path
 * extra fields. The archive this writes is one respondent's recordings: a
 * handful of files, each capped at 25 MB by `MEDIA_KINDS`, so the 4 GB and
 * 65 535-entry limits of the original format are not reachable. Filenames are
 * produced by `safeSegment`, so they are already ASCII and need no UTF-8 flag
 * — but the flag is set anyway, because a name that somehow is not ASCII
 * should be read as UTF-8 rather than as whatever the reader guesses.
 *
 * ## Times
 *
 * MS-DOS timestamps have two-second resolution and no timezone, which is a
 * statement about 1980 rather than about the file. The recording's own
 * timestamp lives in the delivery email and in the response data, where it
 * means something; here it is written in UTC so an archive is reproducible.
 */

/* ------------------------------------------------------------------- crc */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- writing */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash. */
  name: string;
  bytes: Uint8Array;
  /** Defaults to now. */
  modified?: Date;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = d.getUTCFullYear();
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    // the format's epoch is 1980; anything earlier is clamped to it rather
    // than written as a negative year that no reader will accept
    date: (Math.max(0, year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Normalise a path for the archive: forward slashes, no leading slash, no
 * `..` segment. A ZIP entry name is a path a reader will create on disk, and
 * `../../etc/passwd` inside an archive is the oldest trick there is — the
 * names here are built from `safeSegment`, but this function is what makes
 * that a belt rather than a hope.
 */
export function zipSafeName(name: string): string {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.replace(/^\.+$/, "_").trim())
    .filter(Boolean)
    .join("/")
    || "file";
}

const utf8 = new TextEncoder();

function u16(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v: number): number[] { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/**
 * Build the archive.
 *
 * Held entirely in memory on purpose: the caller has already read each object
 * out of storage to compute its CRC, so the bytes are resident either way,
 * and a delivery is one respondent's sitting rather than a corpus. If that
 * ever stops being true, the change is streaming with data descriptors — a
 * different function, not a flag on this one.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const FLAG_UTF8 = 0x0800;
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8.encode(zipSafeName(entry.name));
    const crc = crc32(entry.bytes);
    const { time, date } = dosTime(entry.modified ?? new Date());
    const size = entry.bytes.length;

    const local = [
      ...u32(0x04034b50),      // local file header
      ...u16(20),              // version needed: 2.0
      ...u16(FLAG_UTF8),
      ...u16(0),               // method: STORE
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0),
    ];
    parts.push(local, [...name]);
    const headerBytes = local.length + name.length;

    central.push([
      ...u32(0x02014b50),      // central directory header
      ...u16(20),              // version made by
      ...u16(20),              // version needed
      ...u16(FLAG_UTF8),
      ...u16(0),
      ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0),               // disk number
      ...u16(0),               // internal attributes
      ...u32(0),               // external attributes
      ...u32(offset),
      ...[...name],
    ]);

    offset += headerBytes + size;
  }

  const centralStart = offset;
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(centralStart),
    ...u16(0),               // no comment
  ];

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  const put = (arr: number[] | Uint8Array) => { out.set(arr instanceof Uint8Array ? arr : Uint8Array.from(arr), at); at += arr.length; };

  // interleave the two streams again: header, name, then the file's bytes
  let pi = 0;
  for (const entry of entries) {
    put(parts[pi++]!);        // local header
    put(parts[pi++]!);        // name
    put(entry.bytes);
  }
  for (const c of central) put(c);
  put(eocd);

  return out;
}
