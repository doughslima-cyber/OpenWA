// Reads the first worksheet of an .xlsx file into rows of text (OpenMsg campaigns). An .xlsx is a zip of
// XML parts; the zip is walked from its central directory and each part inflated with the browser's own
// DecompressionStream, so no spreadsheet library ships with the dashboard for one list import.
import type { RecipientTable } from './recipientTable.ts';

/** Ceiling on the inflated bytes of one part, so a small zip cannot expand without bound in the tab. */
export const XLSX_PART_MAX_BYTES = 64 * 1024 * 1024;

export class XlsxReadError extends Error {}

interface ZipEntry {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: fixed 22 bytes plus a comment of up to 64 KiB, searched from the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new XlsxReadError('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new XlsxReadError('damaged zip directory');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > XLSX_PART_MAX_BYTES) {
      await reader.cancel();
      throw new XlsxReadError('spreadsheet too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function readPart(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localHeaderOffset;
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) {
    throw new XlsxReadError('damaged zip entry');
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method === 8) return new TextDecoder().decode(await inflate(data));
  throw new XlsxReadError(`unsupported zip compression ${entry.method}`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? '';
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

/** Every `<t>` text run inside a fragment, joined: a rich-text cell splits its text into several. */
function textRuns(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(match[1]);
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A numeric cell as text. Excel stores a long number like a phone as a plain integer, or in exponent
 * form when it was typed as one; either reads back as its digits.
 */
function numberText(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : value;
}

/** The worksheet path of the workbook's first sheet, or the conventional one when the relationship is missing. */
function firstSheetPath(workbook: string | null, rels: string | null): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  const id = workbook && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  if (!id || !rels) return fallback;
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!match[0].includes(`Id="${id}"`)) continue;
    const target = /Target="([^"]+)"/.exec(match[0])?.[1];
    if (!target) return fallback;
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return fallback;
}

/** The first worksheet of an .xlsx as rows of cell text; empty rows are dropped. */
export async function readXlsx(buffer: ArrayBuffer): Promise<RecipientTable> {
  const bytes = new Uint8Array(buffer);
  const entries = readCentralDirectory(bytes);
  const sheetPath = firstSheetPath(
    await readPart(bytes, entries, 'xl/workbook.xml'),
    await readPart(bytes, entries, 'xl/_rels/workbook.xml.rels'),
  );
  const sheet = await readPart(bytes, entries, sheetPath);
  if (sheet === null) throw new XlsxReadError('no worksheet');
  const sharedXml = await readPart(bytes, entries, 'xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textRuns(m[1])) : [];

  const rows: RecipientTable = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : next;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textRuns(inner);
      else if (raw !== undefined) value = type === 'n' ? numberText(raw) : decodeXml(raw);
      while (row.length < index) row.push('');
      row[index] = value.trim();
      next = index + 1;
    }
    if (row.some(cell => cell)) rows.push(row);
  }
  return rows;
}
