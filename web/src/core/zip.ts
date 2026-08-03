// Just enough ZIP to open the files a CNC front end is handed.
//
// Fusion 360 writes a tool library as a `.tools` file, which is a zip holding a
// single `tools.json`. Asking the operator to unzip it first is the sort of
// papercut that makes a feature go unused, and pulling in a zip library to read
// one deflate stream is not a trade worth making — the browser already has an
// inflater in DecompressionStream, so all that is missing is the ~80 lines that
// find where the compressed bytes start.
//
// Deliberately reads the central directory rather than walking local headers:
// a local header is allowed to claim zero sizes and defer them to a data
// descriptor after the payload, whereas the central directory is always
// authoritative. ZIP64 is rejected outright rather than half-supported — a tool
// library is a few tens of kilobytes and will never reach it.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** ZIP's own limit on a comment, plus the 22-byte record itself. */
const MAX_EOCD_SEARCH = 0xffff + 22;

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export class ZipError extends Error {}

/** Cheap sniff, so a caller can accept both the zip and the bare JSON inside. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('the archive directory is damaged');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported');
    }

    // A directory entry: no payload, and nothing a caller wants.
    if (!name.endsWith('/')) {
      entries.push({ name, bytes: await extract(bytes, view, localOffset, method, compressedSize, name) });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(view: DataView): number {
  const start = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('this does not look like a zip archive');
}

async function extract(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  name: string,
): Promise<Uint8Array> {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new ZipError(`${name}: the archive is damaged`);
  }
  // The local header's name and extra lengths are allowed to differ from the
  // central directory's, so they have to be read here rather than reused.
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + compressedSize);

  if (method === 0) return data;
  if (method !== 8) throw new ZipError(`${name}: unsupported compression method ${method}`);
  return inflateRaw(data, name);
}

async function inflateRaw(data: Uint8Array, name: string): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('this browser cannot decompress zip files');
  }
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError(`${name}: the compressed data is damaged`);
  }
}
