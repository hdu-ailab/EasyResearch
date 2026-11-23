export const TABLE_LIMITS = {
  characters: 1_048_576,
  rows: 10_000,
  columns: 256,
  cells: 100_000,
  cellCharacters: 65_536,
} as const;

/** Bounded RFC-4180-style CSV/TSV. No coercion: cell text is kept exactly, including embedded newlines. */
export function parseDelimited(text: string, delimiter: "," | "\t") {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let touched = false;
  let malformed = false;
  let limited = text.length > TABLE_LIMITS.characters;
  let columns = 0;
  let cells = 0;
  const length = Math.min(text.length, TABLE_LIMITS.characters);
  const endField = () => {
    if (row.length >= TABLE_LIMITS.columns || cells >= TABLE_LIMITS.cells) {
      limited = true;
      return false;
    }
    row.push(field);
    cells++;
    field = "";
    closedQuote = false;
    return true;
  };
  const endRow = () => {
    if (rows.length >= TABLE_LIMITS.rows) {
      limited = true;
      return false;
    }
    columns = Math.max(columns, row.length);
    rows.push(row);
    row = [];
    touched = false;
    return true;
  };
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < length; index++) {
    if (rows.length >= TABLE_LIMITS.rows || cells >= TABLE_LIMITS.cells) {
      limited = true;
      break;
    }
    const char = text.charAt(index);
    touched = true;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += char;
    } else if (char === delimiter) {
      if (!endField()) break;
    } else if (char === "\n" || char === "\r") {
      if (!endField() || !endRow()) break;
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else if (char === '"' && !field && !closedQuote) {
      quoted = true;
    } else {
      if (closedQuote || char === '"') malformed = true;
      field += char;
    }
    if (field.length > TABLE_LIMITS.cellCharacters) {
      field = field.slice(0, TABLE_LIMITS.cellCharacters);
      limited = true;
      break;
    }
  }
  if (quoted && index >= text.length) malformed = true;
  if (touched || row.length || field) {
    endField();
    if (row.length) endRow();
  }
  return { rows, columns, malformed, limited };
}
