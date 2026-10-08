// A recipient list read from a file (OpenMsg campaigns): rows and columns, so the operator can say which
// column holds the phone instead of every number-looking cell (a CPF, a ZIP code, an order id) being sent to.

export type RecipientTable = string[][];

const DELIMITERS = [';', ',', '\t'] as const;

/** The field separator of a delimited file: whichever of `;`, `,` and tab its first line uses most, outside quotes. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n?|\n/).find(line => line.trim()) ?? '';
  let best: string = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === delimiter) count++;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse a `.csv` or `.txt` export: one record per line, fields split on the detected delimiter, with
 * double-quoted fields (a `"Silva, Ana"` name, an escaped `""`) kept whole. Blank lines are dropped.
 */
export function parseDelimited(text: string): RecipientTable {
  const delimiter = detectDelimiter(text);
  const rows: RecipientTable = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field.trim());
    if (row.some(cell => cell)) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  endRow();
  return rows;
}

/** A cell that reads as a phone number: only phone formatting characters, and 10 to 15 digits. */
export function looksLikePhone(cell: string): boolean {
  const value = cell.trim();
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  // A formatted CPF (000.000.000-00) has the digit count of a mobile number and none of its shape.
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

const PHONE_HEADER = /tel|fone|phone|celular|cel\b|whats|zap|n[uú]mero|contato|mobile/i;

export interface ColumnGuess {
  column: number;
  /** Whether the first row names the columns rather than holding a recipient. */
  header: boolean;
}

/**
 * The column most likely to hold the phone: one whose header names a phone, else the one with the most
 * phone-looking cells. The first row is a header when none of its cells looks like a phone and at least
 * one holds a letter.
 */
export function guessPhoneColumn(rows: RecipientTable): ColumnGuess {
  const width = Math.max(0, ...rows.map(row => row.length));
  const first = rows[0] ?? [];
  const header = first.length > 0 && !first.some(looksLikePhone) && first.some(cell => /\p{L}/u.test(cell));
  const body = header ? rows.slice(1) : rows;
  const scores = Array.from(
    { length: width },
    (_, column) => body.filter(row => looksLikePhone(row[column] ?? '')).length,
  );
  const named = header ? first.findIndex(cell => PHONE_HEADER.test(cell)) : -1;
  if (named !== -1 && scores[named] > 0) return { column: named, header };
  let column = 0;
  for (let i = 1; i < width; i++) if (scores[i] > scores[column]) column = i;
  return { column, header };
}

/** The cells of one column, without the header row. */
export function columnValues(rows: RecipientTable, column: number, header: boolean): string[] {
  return (header ? rows.slice(1) : rows).map(row => (row[column] ?? '').trim()).filter(Boolean);
}

/** The spreadsheet letter of a 0-based column index: A, B, …, Z, AA, … */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
