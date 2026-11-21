// A fast drop-in for csv-reader 1.0.0: run(input) answers {columns, rows, errors}
// for {text, header}, reading the text once, left to right.
//
// The reading policy (kept exactly): a leading U+FEFF is dropped; a record ends
// at LF or CRLF and a line with no characters is no record; a CR outside quotes
// that is not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next quote that is not doubled ("" inside is one quote, and
// CRLF or a lone CR inside reads as LF); what follows the closing quote up to
// the next comma or line break is appended as it stands (quote_junk when the
// field ends); a quote that never closes is a literal character and the text
// after it is re-read as unquoted (unterminated_quote); a quote inside an
// unquoted field is literal; fields stay strings, never trimmed or converted;
// columns is the first record when header is true, else null; rows are padded
// with "" (short_row, with fields) or cut (long_row, with extra) to the first
// record's width; each error is {code, line, row} in the order met, line the
// 1-based line its record starts on (every LF, CRLF and lone CR inside quotes
// counted), row its index in rows (null for the header).
//
// Speed comes from never building a field one character at a time: unquoted
// runs are located with indexOf behind three monotonic cursors (the next comma,
// LF and CR, each refreshed only once the scan moves past it, so the native
// scans cover the text about once each), quoted fields are located with
// indexOf('"') and taken as one slice when they hold no line break, and only
// a quoted field that really spans lines falls back to a character walk.

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && s.charCodeAt(0) === 0xfeff) pos = 1;

  // Next ',' / LF / CR at or after the position each was last refreshed from.
  // -1 means stale (refresh on first use); once a cursor runs out it is Infinity.
  let nextComma = -1;
  let nextLF = -1;
  let nextCR = -1;

  // The record being read: the line it starts on and its index in rows (null:
  // the header). Field errors below are stamped with these two.
  let recordLine = 1;
  let recordRow = null;

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = s.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;

    for (;;) {
      let value;
      let ended;
      let done = false;
      let junkScan = false;
      let head = '';

      if (s.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        // Find the closing quote, stepping over doubled ones.
        let q = s.indexOf('"', open + 1);
        let doubled = null;
        let endQ = -1;
        while (q !== -1) {
          if (s.charCodeAt(q + 1) === 34) {
            if (doubled === null) doubled = [];
            doubled.push(q);
            q = s.indexOf('"', q + 2);
            continue;
          }
          endQ = q;
          break;
        }
        if (endQ === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted. The line is still the line
          // the quote opened on, as nothing above has moved it.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          head = '"';
          pos = open + 1;
        } else {
          const start = open + 1;
          if (nextLF < start) {
            const j = s.indexOf('\n', start);
            nextLF = j < 0 ? Infinity : j;
          }
          if (nextCR < start) {
            const j = s.indexOf('\r', start);
            nextCR = j < 0 ? Infinity : j;
          }
          let qval;
          if (nextLF >= endQ && nextCR >= endQ) {
            // No line break inside: one slice, or slices joined at the
            // doubled quotes.
            if (doubled === null) {
              qval = s.slice(start, endQ);
            } else {
              const ps = [];
              let st = start;
              for (let i = 0; i < doubled.length; i++) {
                ps.push(s.slice(st, doubled[i]), '"');
                st = doubled[i] + 2;
              }
              ps.push(s.slice(st, endQ));
              qval = ps.join('');
            }
          } else {
            // A quoted field that spans lines: walk it once, turning every
            // CRLF and lone CR into one LF and collapsing doubled quotes.
            const ps = [];
            let st = start;
            let i = start;
            let delta = 0;
            while (i < endQ) {
              const c = s.charCodeAt(i);
              if (c === 34) {
                ps.push(s.slice(st, i), '"');
                i += 2;
                st = i;
              } else if (c === 13) {
                ps.push(s.slice(st, i), '\n');
                delta += 1;
                i += s.charCodeAt(i + 1) === 10 ? 2 : 1;
                st = i;
              } else if (c === 10) {
                ps.push(s.slice(st, i), '\n');
                delta += 1;
                i += 1;
                st = i;
              } else {
                i += 1;
              }
            }
            ps.push(s.slice(st, endQ));
            qval = ps.join('');
            line += delta;
          }
          pos = endQ + 1;
          if (pos >= n) {
            value = qval;
            ended = END;
            done = true;
          } else {
            const c = s.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              value = qval;
              ended = COMMA;
              done = true;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              value = qval;
              ended = BREAK;
              done = true;
            } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              value = qval;
              ended = BREAK;
              done = true;
            } else {
              // What follows the closing quote is appended as it stands.
              head = qval;
              junkScan = true;
            }
          }
        }
      } else {
        lastQuoted = false;
      }

      if (!done) {
        // Read an unquoted run starting at pos, prefixed by head ('' for a
        // plain field, the quoted value for junk, '"' for an unterminated
        // quote). A CR not followed by LF is dropped (stray_cr) and the run
        // goes on; a comma, LF, CRLF or the end of the text ends it.
        let cur = pos;
        let parts = null;
        let kept = 0;
        let segStart = cur;
        let segEnd = n;
        for (;;) {
          if (nextComma < cur) {
            const j = s.indexOf(',', cur);
            nextComma = j < 0 ? Infinity : j;
          }
          if (nextLF < cur) {
            const j = s.indexOf('\n', cur);
            nextLF = j < 0 ? Infinity : j;
          }
          if (nextCR < cur) {
            const j = s.indexOf('\r', cur);
            nextCR = j < 0 ? Infinity : j;
          }
          let m = nextComma;
          let kind = 0;
          if (nextLF < m) {
            m = nextLF;
            kind = 1;
          }
          if (nextCR < m) {
            m = nextCR;
            kind = 2;
          }
          if (m === Infinity) {
            segStart = cur;
            segEnd = n;
            pos = n;
            ended = END;
            break;
          }
          if (kind === 2) {
            if (s.charCodeAt(m + 1) === 10) {
              segStart = cur;
              segEnd = m;
              pos = m + 2;
              line += 1;
              ended = BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            const seg = s.slice(cur, m);
            kept += seg.length;
            if (parts === null) parts = [];
            parts.push(seg);
            cur = m + 1;
            continue;
          }
          segStart = cur;
          segEnd = m;
          if (kind === 0) {
            pos = m + 1;
            ended = COMMA;
          } else {
            pos = m + 1;
            line += 1;
            ended = BREAK;
          }
          break;
        }
        const tail = s.slice(segStart, segEnd);
        kept += tail.length;
        if (parts === null) {
          value = head ? head + tail : tail;
        } else {
          parts.push(tail);
          value = head + parts.join('');
        }
        if (junkScan && kept > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
