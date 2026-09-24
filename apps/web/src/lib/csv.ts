/**
 * Parses CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF). The first row is the header.
 * The delimiter is taken from the header line: commas, or semicolons (Excel in some regions), or tabs (pasted cells).
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const input = text.replace(/^\uFEFF/, '');
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t']
    .map((d) => [d, firstLine.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0]![0];

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  const endRecord = () => {
    record.push(field);
    if (record.some((v) => v.trim())) records.push(record);
    record = [];
    field = '';
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      endRecord();
    } else field += c;
  }
  endRecord();
  const [headers = [], ...rows] = records;
  return { headers: headers.map((h) => h.trim()), rows };
}
