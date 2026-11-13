'use strict';
// Small RFC 4180 CSV parser/writer. Handles quoted fields, escaped quotes (""),
// commas and newlines inside quotes, CRLF/LF line endings and a UTF-8 BOM
// (Excel adds one when you "Save as CSV UTF-8").

function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;          // physical line where the current row started
  let rowStartLine = 1;
  let quotesUnclosed = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push({ line: rowStartLine, cells: row });
      row = []; field = '';
      line++; rowStartLine = line;
      continue;
    }
    field += c;
  }
  if (inQuotes) quotesUnclosed = true;
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ line: rowStartLine, cells: row });
  }
  // Drop rows that are completely blank (e.g. trailing empty lines).
  const nonBlank = rows.filter(r => r.cells.some(c => c.trim() !== ''));
  return { rows: nonBlank, quotesUnclosed };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(header, rows) {
  return [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseCsv, toCsv };
