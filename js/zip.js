'use strict';
// Tiny ZIP (store-only writer, store/deflate reader), XLSX writer/reader and CSV reader. No external libraries.
const Zip = (() => {
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();

  function dosDateTime(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // entries: [{ name, data: string | Uint8Array | Blob }] -> Blob (application/zip)
  async function create(entries, mime = 'application/zip') {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime();
    for (const e of entries) {
      let bytes;
      if (typeof e.data === 'string') bytes = enc.encode(e.data);
      else if (e.data instanceof Blob) bytes = new Uint8Array(await e.data.arrayBuffer());
      else bytes = e.data;
      const name = enc.encode(e.name);
      const crc = crc32(bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true); // stored
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true);
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, bytes);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, bytes.length, true);
      ch.setUint32(24, bytes.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + bytes.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: mime });
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This ZIP is compressed and this device cannot decompress it. Use the original backup file.');
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Returns Map(name -> Uint8Array)
  async function read(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      const lnlen = dv.getUint16(lho + 26, true);
      const lxlen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lxlen;
      const raw = u8.subarray(start, start + csize);
      if (!name.endsWith('/')) {
        if (method === 0) out.set(name, raw);
        else if (method === 8) out.set(name, await inflateRaw(raw));
        else throw new Error('Unsupported ZIP compression in ' + name);
      }
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  return { create, read, crc32 };
})();

const Xlsx = (() => {
  const xmlEsc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function colName(i) {
    let s = '';
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function excelDate(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return null;
    return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  // style ids: 0 normal, 1 header, 2 date, 3 money, 4 bold money, 5 bold text
  function cell(ref, value, type, bold) {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'money' || type === 'number') {
      const n = Number(value);
      if (!isFinite(n)) return '';
      const s = type === 'money' ? (bold ? 4 : 3) : (bold ? 5 : 0);
      return `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
    }
    if (type === 'date') {
      const d = excelDate(value);
      if (d !== null) return `<c r="${ref}" s="2"><v>${d}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="5"' : ''}><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
  }

  // Data validation (dropdown). list: array of allowed values. Short lists are written inline (they survive
  // most spreadsheet apps); long ones point at a range on another sheet (ref, e.g. "Lists!$A$2:$A$40").
  function validationXml(v, sqref) {
    const inline = v.list.map((x) => String(x).replace(/"/g, '""')).join(',');
    const useInline = !v.ref || (inline.length <= 250 && !v.list.some((x) => String(x).includes(',')));
    const formula = useInline ? `"${xmlEsc(inline)}"` : xmlEsc(v.ref);
    const strict = v.strict !== false;
    return `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="${strict ? 'stop' : 'warning'}"` +
      ` errorTitle="${xmlEsc(v.errorTitle || 'Not in the list')}" error="${xmlEsc(v.error || (strict ? 'Please pick a value from the dropdown list.' : 'This is not in the list. Keep it anyway?'))}"` +
      (v.prompt ? ` promptTitle="${xmlEsc(v.promptTitle || '')}" prompt="${xmlEsc(v.prompt.slice(0, 250))}"` : '') +
      ` sqref="${sqref}"><formula1>${formula}</formula1></dataValidation>`;
  }

  function sheetXml(sheet) {
    const cols = sheet.columns;
    const widths = cols.map((c) => c.width || Math.max(8, String(c.header).length + 2));
    sheet.rows.forEach((r) => {
      const vals = Array.isArray(r) ? r : r.cells;
      vals.forEach((v, i) => {
        if (i >= widths.length || cols[i].width) return;
        const len = cols[i].type === 'date' ? 11 : cols[i].type === 'money' ? String(Math.round(v || 0)).length + 6 : String(v ?? '').length + 2;
        widths[i] = Math.min(60, Math.max(widths[i], len));
      });
    });
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    x += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    x += '<sheetData>';
    x += '<row r="1">' + cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEsc(c.header)}</t></is></c>`).join('') + '</row>';
    sheet.rows.forEach((r, ri) => {
      const vals = Array.isArray(r) ? r : r.cells;
      const bold = !Array.isArray(r) && r.bold;
      const n = ri + 2;
      x += `<row r="${n}">` + vals.map((v, i) => cell(colName(i) + n, v, (cols[i] || {}).type, bold)).join('') + '</row>';
    });
    // empty rows that are still formatted (dates/amounts) so a template is easy to fill in
    for (let n = sheet.rows.length + 2; n <= (sheet.blankRows || 0) + 1; n++) {
      const styled = cols.map((c, i) => (c.type === 'date' ? `<c r="${colName(i)}${n}" s="2"/>` : c.type === 'money' ? `<c r="${colName(i)}${n}" s="3"/>` : '')).join('');
      if (styled) x += `<row r="${n}">${styled}</row>`;
    }
    x += '</sheetData>';
    if (cols.length && !sheet.noFilter) x += `<autoFilter ref="A1:${colName(cols.length - 1)}${Math.max(1, sheet.rows.length + 1)}"/>`;
    const vals = cols.map((c, i) => (c.validation && c.validation.list.length ? validationXml(c.validation, `${colName(i)}2:${colName(i)}${Math.max(2, (sheet.blankRows || 0) + 1)}`) : '')).filter(Boolean);
    if (vals.length) x += `<dataValidations count="${vals.length}">${vals.join('')}</dataValidations>`;
    x += '</worksheet>';
    return x;
  }

  function safeSheetName(name, used) {
    let n = String(name).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let base = n, k = 2;
    while (used.has(n.toLowerCase())) { const suf = ' ' + k++; n = base.slice(0, 31 - suf.length) + suf; }
    used.add(n.toLowerCase());
    return n;
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // sheets: [{ name, columns: [{header, type}], rows: [[...]] | [{cells, bold}] }]
  async function build(sheets) {
    const used = new Set();
    const names = sheets.map((s) => safeSheetName(s.name, used));
    const files = [];
    files.push({
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    });
    files.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    });
    files.push({
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}"${sheets[i].hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    });
    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    });
    files.push({ name: 'xl/styles.xml', data: STYLES });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
    return Zip.create(files, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ---- reader: returns [{ name, rows: [[cell, …], …] }]. Cells are strings, numbers or booleans.
  function attr(el, name) { return el.getAttribute(name); }
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  const textOf = (el) => Array.from(el.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('');
  async function read(buffer) {
    const files = await Zip.read(buffer);
    const dec = new TextDecoder();
    const xml = (name) => {
      const key = [...files.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? new DOMParser().parseFromString(dec.decode(files.get(key)), 'application/xml') : null;
    };
    const wb = xml('xl/workbook.xml');
    if (!wb) throw new Error('This is not an Excel (.xlsx) file.');
    const rels = xml('xl/_rels/workbook.xml.rels');
    const target = {};
    if (rels) for (const r of Array.from(rels.getElementsByTagNameNS('*', 'Relationship'))) target[attr(r, 'Id')] = attr(r, 'Target');
    const ss = xml('xl/sharedStrings.xml');
    const shared = ss ? Array.from(ss.getElementsByTagNameNS('*', 'si')).map(textOf) : [];
    const out = [];
    for (const sh of Array.from(wb.getElementsByTagNameNS('*', 'sheet'))) {
      const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let t = target[rid] || '';
      t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      const doc = xml(t);
      if (!doc) continue;
      const rows = [];
      for (const r of Array.from(doc.getElementsByTagNameNS('*', 'row'))) {
        const ri = (Number(attr(r, 'r')) || rows.length + 1) - 1;
        const row = [];
        let ci = 0;
        for (const c of Array.from(r.getElementsByTagNameNS('*', 'c'))) {
          const ref = attr(c, 'r');
          if (ref) ci = colIndex(ref);
          const type = attr(c, 't');
          const v = c.getElementsByTagNameNS('*', 'v')[0];
          let val = '';
          if (type === 's') val = v ? shared[Number(v.textContent)] ?? '' : '';
          else if (type === 'inlineStr') val = textOf(c);
          else if (type === 'str' || type === 'e') val = v ? v.textContent : '';
          else if (type === 'b') val = v ? v.textContent === '1' : '';
          else if (v && v.textContent !== '') val = Number(v.textContent);
          row[ci] = val;
          ci++;
        }
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
        rows[ri] = row;
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      out.push({ name: attr(sh, 'name'), hidden: attr(sh, 'state') === 'hidden' || attr(sh, 'state') === 'veryHidden', rows });
    }
    return out;
  }
  // Excel serial day number -> YYYY-MM-DD
  function serialToYmd(n) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    return d.toISOString().slice(0, 10);
  }

  return { build, read, serialToYmd, colName };
})();

// RFC 4180 CSV with auto-detected delimiter (comma, semicolon or tab). Returns [[cell, …], …].
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cellv = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cellv += '"'; i++; } else q = false; }
      else cellv += ch;
    } else if (ch === '"' && cellv === '') q = true;
    else if (ch === delim) { row.push(cellv); cellv = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cellv); rows.push(row); row = []; cellv = '';
    } else cellv += ch;
  }
  if (cellv !== '' || row.length) { row.push(cellv); rows.push(row); }
  return rows;
}
