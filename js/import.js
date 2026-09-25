'use strict';
/* Bulk import of past transactions from Excel (.xlsx) or CSV.
   Flow: download a personal template (dropdowns filled with this device's properties, partners, accounts…)
   → fill it in → choose the file → match columns and unknown names with dropdowns → preview → import.
   Every import can be undone. Uses globals from app.js. */

// Type labels used in the template dropdown, and every other spelling we accept.
const IMPORT_TYPES = [
  ['Income', 'income'], ['Expense', 'expense'],
  ['Deposit received', 'deposit_in'], ['Deposit refunded', 'deposit_out'], ['Deposit kept', 'deposit_apply'],
  ['Partner put money in', 'contribution'], ['Partner took money out', 'withdrawal'],
  ['Partner paid partner', 'settlement'], ['Transfer between accounts', 'transfer'],
];
const TYPE_WORDS = {
  income: ['income', 'receipt', 'received', 'credit', 'cr', 'in', 'money in', 'rent received'],
  expense: ['expense', 'expenses', 'payment', 'paid', 'debit', 'dr', 'out', 'money out', 'bill', 'expenditure'],
  deposit_in: ['deposit in', 'security deposit', 'deposit', 'security deposit received'],
  deposit_out: ['deposit refund', 'deposit returned', 'refund', 'security deposit refunded'],
  deposit_apply: ['deposit applied', 'deposit kept', 'deposit used', 'deposit deducted'],
  contribution: ['contribution', 'capital', 'capital contribution', 'partner contribution', 'put in'],
  withdrawal: ['withdrawal', 'drawing', 'drawings', 'personal use', 'took out', 'partner withdrawal'],
  settlement: ['settlement', 'settle', 'partner payment'],
  transfer: ['transfer', 'account transfer', 'internal transfer'],
};
// Columns the importer understands. `syn` = other headings that mean the same thing.
const IMPORT_FIELDS = [
  { key: 'date', header: 'Date', need: 'required', syn: ['transaction date', 'txn date', 'value date', 'posting date', 'posted', 'posted date', 'date paid'] },
  { key: 'type', header: 'Type', syn: ['kind', 'transaction type', 'entry type', 'income / expense', 'income/expense'] },
  { key: 'amount', header: 'Amount', need: 'amount', syn: ['value', 'amt', 'total', 'amount paid', 'transaction amount'] },
  { key: 'moneyIn', header: 'Money in', need: 'amount', syn: ['credit', 'credits', 'deposits', 'paid in', 'inflow', 'credit amount', 'in'] },
  { key: 'moneyOut', header: 'Money out', need: 'amount', syn: ['debit', 'debits', 'withdrawals', 'paid out', 'outflow', 'debit amount', 'out'] },
  { key: 'property', header: 'Property', syn: ['building', 'property name'] },
  { key: 'unit', header: 'Unit', syn: ['apartment', 'flat', 'apt', 'unit no', 'unit number'] },
  { key: 'lease', header: 'Tenant / lease', syn: ['tenant', 'lease', 'renter', 'tenant name'] },
  { key: 'category', header: 'Category', syn: ['head', 'account head', 'expense type', 'income type', 'expense category'] },
  { key: 'period', header: 'Rent month', syn: ['rent for', 'period', 'for month', 'rent period', 'month'] },
  { key: 'via', header: 'Paid from / received into', syn: ['paid from', 'received into', 'account used', 'via', 'paid from/received into'] },
  { key: 'handledBy', header: 'Collected / paid by', syn: ['collected by', 'handled by', 'paid by'] },
  { key: 'partner', header: 'Partner', syn: ['from partner'] },
  { key: 'toPartner', header: 'To partner', syn: [] },
  { key: 'account', header: 'Account', syn: ['from account'] },
  { key: 'toAccount', header: 'To account', syn: [] },
  { key: 'description', header: 'Description', syn: ['details', 'memo', 'notes', 'note', 'narration', 'particulars', 'reference', 'remarks', 'description / reference'] },
  { key: 'entryId', header: 'Entry ID', syn: [] },
];
const FIELD = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, f]));

// ---------------------------------------------------------------- labels shared by template & matching
const unitLabel = (u) => `${propName(u.propertyId)} › ${u.name}`;
function leaseImportLabel(l) {
  const u = byId('units', l.unitId);
  return `${tenantName(l.tenantId) || 'Tenant'} · ${u ? unitLabel(u) : ''}${l.status === 'ended' ? ' (ended)' : ''}`;
}
const personallyLabel = (p) => `${p.name} (personally)`;
const allCategories = () => [...new Set([...Object.values(KINDS).flatMap((k) => k.cats), ...S.txns.map((t) => t.category).filter(Boolean)])];

// ---------------------------------------------------------------- template
async function buildImportTemplate() {
  const types = IMPORT_TYPES.map((x) => x[0]);
  const props = [...S.properties].sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.name);
  const units = [...S.units].sort((a, b) => unitLabel(a).localeCompare(unitLabel(b))).map(unitLabel);
  const leases = [...S.leases].sort((a, b) => leaseImportLabel(a).localeCompare(leaseImportLabel(b))).map(leaseImportLabel);
  const cats = allCategories();
  const accs = S.accounts.map((a) => a.name);
  const partners = S.partners.map((p) => p.name);
  const vias = [...accs, ...S.partners.map(personallyLabel)];
  const first = [today(), ...S.leases.map((l) => l.startDate), ...S.txns.map((t) => t.date)].filter(Boolean).sort()[0];
  const months = [];
  for (let m = addMonths(first.slice(0, 7), -24), end = addMonths(thisMonth(), 3); m <= end; m = addMonths(m, 1)) months.push(m);
  const lists = [['Type', types], ['Property', props], ['Unit', units], ['Tenant / lease', leases], ['Category', cats], ['Rent month', months], ['Paid from / received into', vias], ['Partner', partners], ['Account', accs]];
  const ref = (name) => { const i = lists.findIndex((x) => x[0] === name); return `Lists!$${Xlsx.colName(i)}$2:$${Xlsx.colName(i)}$${Math.max(2, lists[i][1].length + 1)}`; };
  const v = (name, list, extra = {}) => ({ list, ref: ref(name), ...extra });
  const columns = [
    { header: 'Date', type: 'date', width: 12 },
    { header: 'Type', width: 24, validation: v('Type', types, { prompt: 'Pick the kind of entry' }) },
    { header: 'Amount', type: 'money', width: 12 },
    { header: 'Property', width: 20, validation: v('Property', props) },
    { header: 'Unit', width: 22, validation: v('Unit', units, { prompt: 'Optional' }) },
    { header: 'Tenant / lease', width: 30, validation: v('Tenant / lease', leases, { prompt: 'For rent and deposits. Fills in property and unit for you.' }) },
    { header: 'Category', width: 24, validation: v('Category', cats, { strict: false, prompt: 'Pick one, or type your own' }) },
    { header: 'Rent month', width: 12, validation: v('Rent month', months, { strict: false, prompt: 'Only for rent. Blank = month of the date' }) },
    { header: 'Paid from / received into', width: 28, validation: v('Paid from / received into', vias, { prompt: 'Blank = the property\'s common account' }) },
    { header: 'Collected / paid by', width: 18, validation: v('Partner', partners, { prompt: 'Optional note, when a common account was used' }) },
    { header: 'Partner', width: 16, validation: v('Partner', partners, { prompt: 'Only for partner put in / took out / paid partner' }) },
    { header: 'To partner', width: 16, validation: v('Partner', partners, { prompt: 'Only for partner paid partner' }) },
    { header: 'Account', width: 20, validation: v('Account', accs, { prompt: 'Only for partner put in / took out / transfer' }) },
    { header: 'To account', width: 20, validation: v('Account', accs, { prompt: 'Only for transfer' }) },
    { header: 'Description', width: 40 },
  ];
  const help = [
    ['Date', 'Required. The date of the payment.', '2025-03-01'],
    ['Type', 'Required — pick from the list: ' + types.join(', ') + '.', 'Income'],
    ['Amount', 'Required. Always a positive number.', '1500'],
    ['Property', 'Pick from the list.', props[0] || ''],
    ['Unit', 'Optional. Pick from the list.', units[0] || ''],
    ['Tenant / lease', 'For rent and deposits — pick the tenant\'s lease. Property and unit are then filled in for you. Deposits need a lease.', leases[0] || ''],
    ['Category', 'Pick one (e.g. Rent, Mortgage / loan EMI, Repairs) or type your own.', 'Rent'],
    ['Rent month', 'Only for rent. Which month the rent is for. Blank = the month of the date.', thisMonth()],
    ['Paid from / received into', 'Blank = the property\'s common account (shared by all owners, nobody owes anyone). Pick an account, or “Name (personally)” if a partner paid from their own pocket or kept the money.', accs[0] || (S.partners[0] ? personallyLabel(S.partners[0]) : '')],
    ['Collected / paid by', 'Optional note of who collected / paid it when a common account was used. Does not change balances.', partners[1] || ''],
    ['Partner / Account', 'Only for “Partner put money in” and “Partner took money out”: which partner and which account.', ''],
    ['To partner', 'Only for “Partner paid partner”: Partner = who paid, To partner = who received.', ''],
    ['Account / To account', 'Only for “Transfer between accounts”.', ''],
    ['Description', 'Anything — cheque no., invoice, notes.', 'Cheque 1234'],
    ['', '', ''],
    ['Tips', 'Delete nothing from the Lists sheet (it feeds the dropdowns). Dates can also be typed like 01/03/2025 — you choose day/month order when importing. Entries that already exist in the app are detected as duplicates. You can undo an import.', ''],
  ];
  return Xlsx.build([
    { name: 'Transactions', columns, rows: [], blankRows: 1000 },
    { name: 'How to fill', columns: [{ header: 'Column', width: 26 }, { header: 'What to put', width: 90 }, { header: 'Example', width: 30 }], rows: help, noFilter: true },
    { name: 'Lists', hidden: true, noFilter: true, columns: lists.map(([h]) => ({ header: h, width: 30 })), rows: Array.from({ length: Math.max(...lists.map((l) => l[1].length)) }, (_, i) => lists.map((l) => l[1][i] ?? '')) },
  ]);
}

// ---------------------------------------------------------------- parsing helpers
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const validYmd = (y, m, d) => y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const fullYear = (y) => (y < 100 ? 2000 + y : y);
// Parse a date cell. order: 'dmy' | 'mdy' for ambiguous 01/02/2025 style dates. Returns YYYY-MM-DD or ''.
function parseImportDate(v, order) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v > 10000 && v < 80000 ? Xlsx.serialToYmd(v) : '';
  const s = String(v).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return validYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : ''; }
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\b/.exec(s);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], fullYear(+m[3])];
    const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    return validYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : '';
  }
  const mon = (w) => MONTHS.indexOf(w.slice(0, 3)) + 1;
  m = /^(\d{1,2})[-/. ]?([a-z]{3,9})[-/., ]*(\d{2,4})$/.exec(s); // 1 Mar 2025, 01-Mar-25
  if (m && mon(m[2])) { const [y, mo, d] = [fullYear(+m[3]), mon(m[2]), +m[1]]; return validYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : ''; }
  m = /^([a-z]{3,9})[-/. ]+(\d{1,2})[-/., ]+(\d{2,4})$/.exec(s); // Mar 1, 2025
  if (m && mon(m[1])) { const [y, mo, d] = [fullYear(+m[3]), mon(m[1]), +m[2]]; return validYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : ''; }
  return '';
}
// Which day/month order do the ambiguous dates in this column use? Returns { order, sure }.
function detectDateOrder(values) {
  let dmy = false, mdy = false;
  for (const v of values) {
    const m = typeof v === 'string' && /^\s*(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/.exec(v);
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy !== mdy) return { order: dmy ? 'dmy' : 'mdy', sure: true };
  const anyAmbiguous = values.some((v) => typeof v === 'string' && /^\s*\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}/.test(v));
  return { order: /^en-(US|PH|CA)$/i.test(navigator.language || '') ? 'mdy' : 'dmy', sure: !anyAmbiguous };
}
function parseImportMonth(v, order) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v > 10000 ? Xlsx.serialToYmd(v).slice(0, 7) : '';
  const s = String(v).trim().toLowerCase();
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad2(+m[2])}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad2(+m[1])}`;
  m = /^([a-z]{3,9})[-/. ,]*(\d{2,4})$/.exec(s);
  if (m && MONTHS.indexOf(m[1].slice(0, 3)) >= 0) return `${fullYear(+m[2])}-${pad2(MONTHS.indexOf(m[1].slice(0, 3)) + 1)}`;
  const d = parseImportDate(v, order);
  return d ? d.slice(0, 7) : '';
}
// "$1,500.00", "(200)", "-200", "200 DR", "1.234,56" → number (NaN when not a number)
function parseImportAmount(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bdr\.?$/i.test(s)) { neg = true; s = s.replace(/\bdr\.?$/i, ''); }
  s = s.replace(/\bcr\.?$/i, '');
  if (/-/.test(s)) neg = !neg;
  s = s.replace(/[^\d.,]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!s || !/\d/.test(s)) return NaN;
  const n = parseFloat(s);
  return neg ? -n : n;
}

// ---------------------------------------------------------------- matching
const cellText = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v)).trim();
// Typing mistakes between two words (swapped neighbouring letters count as one).
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// Best candidate for a typed name. cands: [{ value, names: [..] }]. Returns { value, exact } or null.
function bestMatch(raw, cands) {
  const n = normName(raw);
  if (!n) return null;
  for (const c of cands) if (c.names.some((x) => normName(x) === n)) return { value: c.value, exact: true };
  const loose = (s) => normName(s).replace(/[^a-z0-9]/g, '');
  const ln = loose(raw);
  for (const c of cands) if (c.names.some((x) => loose(x) === ln)) return { value: c.value, exact: false };
  let best = null, bd = 99;
  for (const c of cands) for (const x of c.names) {
    const d = editDistance(loose(x), ln);
    const lim = Math.min(2, Math.floor(ln.length / 4));
    if (d <= lim && d < bd) { bd = d; best = c.value; }
    else if (ln.length >= 3 && loose(x).length >= 3 && (loose(x).startsWith(ln) || ln.startsWith(loose(x))) && bd > 3) { bd = 3; best = c.value; }
  }
  return best ? { value: best, exact: false } : null;
}
const typeCands = () => IMPORT_TYPES.map(([label, kind]) => ({ value: kind, names: [label, kind, KINDS[kind].label, KINDS[kind].short, ...(TYPE_WORDS[kind] || [])] }));
const propCands = () => S.properties.map((p) => ({ value: p.id, names: [p.name] }));
const partnerCands = () => S.partners.map((p) => ({ value: p.id, names: [p.name, personallyLabel(p), ...(p.isSelf ? ['me', 'myself', 'self'] : [])] }));
const accountCands = () => S.accounts.map((a) => ({ value: a.id, names: [a.name, `${a.name} (${propName(a.propertyId)})`] }));
function unitCands(propertyId) {
  return S.units.filter((u) => !propertyId || u.propertyId === propertyId).map((u) => ({ value: u.id, names: propertyId ? [u.name, unitLabel(u)] : [unitLabel(u)] }));
}
function leaseCands(propertyId) {
  const ls = S.leases.filter((l) => !propertyId || byId('units', l.unitId)?.propertyId === propertyId);
  const byTenant = {};
  for (const l of ls) (byTenant[l.tenantId] = byTenant[l.tenantId] || []).push(l);
  const out = ls.map((l) => ({ value: 'l:' + l.id, names: [leaseImportLabel(l), leaseImportLabel(l).replace(/ \(ended\)$/, ''), leaseLabel(l)] }));
  // plain tenant name → the tenant's lease covering each row's date
  for (const [tid, list] of Object.entries(byTenant)) out.push({ value: list.length === 1 ? 'l:' + list[0].id : 't:' + tid, names: [tenantName(tid)] });
  return out;
}

// ---------------------------------------------------------------- import state & row building
let IMP = null; // { fileName, sheets, sheetIdx, headerRow, colMap, order, orderSure, map: {field: {key: value}}, skipDup, filter }

function autoHeaderRow(rows) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const score = (rows[i] || []).filter((c) => IMPORT_FIELDS.some((f) => [f.header, ...f.syn].some((h) => normName(h) === normName(cellText(c))))).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
function autoColMap(headers) {
  const map = {}, used = new Set();
  const norm = headers.map((h) => normName(cellText(h)));
  for (const pass of ['header', 'syn']) {
    for (const f of IMPORT_FIELDS) {
      if (map[f.key] !== undefined) continue;
      const names = pass === 'header' ? [f.header] : f.syn;
      const i = norm.findIndex((h, j) => !used.has(j) && h && names.some((n) => normName(n) === h));
      if (i >= 0) { map[f.key] = i; used.add(i); }
    }
  }
  // exported ledger sheets have Money in / Money out AND Amount: prefer the signed pair only when there's no Type
  return map;
}
function startImport(fileName, sheets) {
  const idx = Math.max(0, sheets.findIndex((s) => !s.hidden && /transactions|ledger/i.test(s.name)));
  IMP = { fileName, sheets, map: {}, skipDup: true, filter: 'all' };
  selectSheet(sheets[idx] && !sheets[idx].hidden ? idx : Math.max(0, sheets.findIndex((s) => !s.hidden)));
}
function selectSheet(i) {
  IMP.sheetIdx = i;
  const rows = IMP.sheets[i]?.rows || [];
  IMP.headerRow = autoHeaderRow(rows);
  resetColumns();
}
function resetColumns() {
  const rows = IMP.sheets[IMP.sheetIdx]?.rows || [];
  IMP.colMap = autoColMap(rows[IMP.headerRow] || []);
  const dates = IMP.colMap.date !== undefined ? rows.slice(IMP.headerRow + 1).map((r) => r[IMP.colMap.date]) : [];
  const d = detectDateOrder(dates);
  IMP.order = d.order; IMP.orderSure = d.sure;
  IMP.map = {};
}
const impDataRows = () => {
  const rows = IMP.sheets[IMP.sheetIdx]?.rows || [];
  return rows.slice(IMP.headerRow + 1).map((r, i) => ({ r, rowNo: IMP.headerRow + i + 2 })).filter(({ r }) => r.some((c) => cellText(c) !== ''));
};
const impCell = (r, key) => (IMP.colMap[key] === undefined ? '' : r[IMP.colMap[key]]);

// Resolve a value through the user's choices (IMP.map) or automatic matching. Returns { value, auto } where
// value '' = leave blank. Unresolved values are collected in `pending` for the "Match names" card.
function resolver() {
  const pending = {};
  const cache = {};
  const cands = { type: typeCands(), property: propCands(), partner: partnerCands(), account: accountCands() };
  const res = (field, raw, cfn, ctx = '') => {
    const text = cellText(raw);
    if (!text) return '';
    const key = normName(text) + (ctx ? '|' + ctx : '');
    const chosen = IMP.map[field]?.[key];
    const ck = field + '\u0000' + key;
    if (!(ck in cache)) {
      const m = bestMatch(text, cfn());
      cache[ck] = m;
    }
    const m = cache[ck];
    if (chosen !== undefined) { if (!m?.exact) (pending[field] = pending[field] || {})[key] = { text, ctx, count: ((pending[field] || {})[key]?.count || 0) + 1, suggestion: m?.value || '' }; return chosen; }
    if (m?.exact) return m.value;
    (pending[field] = pending[field] || {})[key] = { text, ctx, count: ((pending[field] || {})[key]?.count || 0) + 1, suggestion: m?.value || '' };
    return m ? m.value : '';
  };
  return {
    pending,
    type: (raw) => res('type', raw, () => cands.type),
    property: (raw) => res('property', raw, () => cands.property),
    unit: (raw, pid) => res('unit', raw, () => unitCands(pid), pid),
    lease: (raw, pid) => res('lease', raw, () => leaseCands(pid), pid),
    partner: (raw) => res('partner', raw, () => cands.partner),
    account: (raw) => res('account', raw, () => cands.account),
    via: (raw) => {
      const text = cellText(raw);
      if (!text) return '';
      const personal = /\((personally|personal)\)\s*$/i.test(text);
      const base = text.replace(/\s*\((personally|personal)\)\s*$/i, '');
      const key = normName(text);
      const chosen = IMP.map.via?.[key];
      const a = personal ? null : bestMatch(base, cands.account);
      const p = bestMatch(base, cands.partner);
      const auto = a?.exact ? 'a:' + a.value : p?.exact ? 'p:' + p.value : a ? 'a:' + a.value : p ? 'p:' + p.value : '';
      const exact = a?.exact || p?.exact;
      if (!exact || chosen !== undefined) (pending.via = pending.via || {})[key] = { text, ctx: '', count: ((pending.via || {})[key]?.count || 0) + 1, suggestion: auto };
      return chosen !== undefined ? chosen : auto;
    },
  };
}
// Did the user explicitly pick "leave blank" / "default" for this value in Match names?
const pickedBlank = (field, raw, ctx = '') => cellText(raw) !== '' && IMP.map[field]?.[normName(cellText(raw)) + (ctx ? '|' + ctx : '')] === '';
function leaseForDate(tenantId, propertyId, date) {
  const ls = S.leases.filter((l) => l.tenantId === tenantId && (!propertyId || byId('units', l.unitId)?.propertyId === propertyId));
  return ls.find((l) => l.startDate <= date && (!l.endDate || l.endDate >= date)) || ls.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
}

// Build the entries from the file. Returns { rows: [{ rowNo, txn, errors, warnings, dup }], pending, newAccounts }
function buildImport() {
  const R = resolver();
  const out = [];
  const newAccounts = {}; // propertyId|'' -> name, for entries whose property has no account yet
  const existing = new Map();
  const dupKey = (t) => [t.kind, t.date, r2(t.amount), t.propertyId || '', t.leaseId || ''].join('|');
  for (const t of S.txns) existing.set(dupKey(t), t);
  const ids = new Set(S.txns.map((t) => t.id));
  const cats = allCategories();
  const fileKeys = new Map();
  for (const { r, rowNo } of impDataRows()) {
    const errors = [], warnings = [];
    const t = {};
    // date
    const rawDate = impCell(r, 'date');
    t.date = parseImportDate(rawDate, IMP.order);
    if (!cellText(rawDate)) errors.push('Date is empty'); else if (!t.date) errors.push(`Can't read the date “${cellText(rawDate)}”`);
    // amount & type
    let amount = parseImportAmount(impCell(r, 'amount'));
    const inAmt = parseImportAmount(impCell(r, 'moneyIn')), outAmt = parseImportAmount(impCell(r, 'moneyOut'));
    let signKind = '';
    if (isNaN(amount) || !amount) {
      if (inAmt > 0) { amount = inAmt; signKind = 'income'; } else if (outAmt > 0) { amount = outAmt; signKind = 'expense'; } else if (inAmt < 0 || outAmt < 0) { amount = Math.abs(inAmt || outAmt); signKind = inAmt < 0 ? 'expense' : 'income'; }
    } else if (amount < 0) signKind = 'expense';
    else if (IMP.colMap.moneyIn !== undefined && inAmt > 0) signKind = 'income';
    else if (IMP.colMap.moneyOut !== undefined && outAmt > 0) signKind = 'expense';
    const rawType = impCell(r, 'type');
    let kind = R.type(rawType);
    if (kind === '__skip') continue;
    if (!kind) kind = signKind || (!cellText(rawType) && amount > 0 && IMP.colMap.type === undefined ? 'income' : '');
    if (!kind) errors.push(cellText(rawType) ? `Unknown type “${cellText(rawType)}” — match it above` : 'Type is empty');
    if (!(Math.abs(amount) > 0)) errors.push(cellText(impCell(r, 'amount')) ? `Can't read the amount “${cellText(impCell(r, 'amount'))}”` : 'Amount is empty');
    t.kind = kind || 'income';
    t.amount = r2(Math.abs(amount) || 0);
    // property / unit / lease
    let pid = cellText(impCell(r, 'property')) ? R.property(impCell(r, 'property')) : IMP.defProp || '';
    if (cellText(impCell(r, 'property')) && !pid && !pickedBlank('property', impCell(r, 'property'))) warnings.push(`Property “${cellText(impCell(r, 'property'))}” not matched`);
    const rawLease = impCell(r, 'lease');
    let lv = R.lease(rawLease, pid);
    let lease = null;
    if (lv.startsWith('l:')) lease = byId('leases', lv.slice(2));
    else if (lv.startsWith('t:')) lease = leaseForDate(lv.slice(2), pid, t.date || today());
    if (cellText(rawLease) && !lease && !pickedBlank('lease', rawLease, pid)) warnings.push(`Tenant “${cellText(rawLease)}” not matched`);
    const rawUnit = impCell(r, 'unit');
    const unitCtx = pid;
    let uid_ = R.unit(rawUnit, pid);
    if (lease) { uid_ = lease.unitId; pid = byId('units', lease.unitId)?.propertyId || pid; }
    else if (uid_) pid = byId('units', uid_)?.propertyId || pid;
    if (cellText(rawUnit) && !uid_ && !pickedBlank('unit', rawUnit, unitCtx)) warnings.push(`Unit “${cellText(rawUnit)}” not matched`);
    const propScoped = VIA_KINDS.includes(t.kind) || t.kind === 'deposit_apply';
    if (propScoped || ['contribution', 'withdrawal', 'settlement'].includes(t.kind)) t.propertyId = pid || '';
    if (propScoped) { t.unitId = uid_ || ''; t.leaseId = lease?.id || ''; }
    if (LEASE_KINDS.includes(t.kind) && !t.leaseId) errors.push('Deposits need the tenant / lease');
    // category & rent month
    const rawCat = cellText(impCell(r, 'category'));
    t.category = rawCat ? (cats.find((c) => normName(c) === normName(rawCat)) || rawCat) : (KINDS[t.kind].cats.length === 1 ? KINDS[t.kind].cats[0] : t.kind === 'income' && t.leaseId ? 'Rent' : '');
    if ((t.kind === 'income' || t.kind === 'deposit_apply') && t.leaseId && /rent/i.test(t.category)) {
      const rawP = impCell(r, 'period');
      t.period = parseImportMonth(rawP, IMP.order) || (t.date || '').slice(0, 7);
      if (cellText(rawP) && !parseImportMonth(rawP, IMP.order)) warnings.push(`Can't read the rent month “${cellText(rawP)}” — used the month of the date`);
    }
    t.description = cellText(impCell(r, 'description'));
    // paid from / received into
    if (VIA_KINDS.includes(t.kind)) {
      const rawVia = impCell(r, 'via');
      let via = parseVia(cellText(rawVia) ? R.via(rawVia) : IMP.defVia || '');
      const useDefault = !cellText(rawVia) || pickedBlank('via', rawVia);
      if (!via && !useDefault) errors.push(`“${cellText(rawVia)}” is not an account or partner — match it above`);
      if (!via && useDefault) {
        via = defaultVia(t.kind, t.propertyId);
        if (via.t === 'a' && via.id === NEW_ACCOUNT) { newAccounts[t.propertyId || ''] = t.propertyId ? propName(t.propertyId) + ' account' : 'Common account'; via = { t: 'a', id: '__new:' + (t.propertyId || '') }; }
      }
      if (via) {
        t.via = via;
        if (via.t === 'p' && t.propertyId && ownerIds(t.propertyId).length && !ownerIds(t.propertyId).includes(via.id)) warnings.push(`${partnerName(via.id)} is not an owner of ${propName(t.propertyId)}`);
        const hb = impCell(r, 'handledBy');
        if (cellText(hb)) {
          const h = R.partner(hb, 'handledBy');
          if (h && via.t === 'a') t.handledBy = h;
          else if (!h && !pickedBlank('partner', hb)) warnings.push(`“${cellText(hb)}” (collected by) not matched`);
        }
      }
    }
    // partner / account fields
    if (['contribution', 'withdrawal', 'settlement'].includes(t.kind)) {
      t.partnerId = R.partner(impCell(r, 'partner'));
      if (!t.partnerId) errors.push(cellText(impCell(r, 'partner')) ? `Partner “${cellText(impCell(r, 'partner'))}” not matched` : 'Partner is empty');
    }
    if (t.kind === 'settlement') {
      t.toPartnerId = R.partner(impCell(r, 'toPartner'));
      if (!t.toPartnerId) errors.push('To partner is empty or not matched');
      else if (t.toPartnerId === t.partnerId) errors.push('Partner and To partner are the same');
    }
    if (['contribution', 'withdrawal', 'transfer'].includes(t.kind)) {
      const rawAcc = cellText(impCell(r, 'account')) ? impCell(r, 'account') : t.kind !== 'transfer' ? impCell(r, 'via') : '';
      t.accountId = R.account(rawAcc);
      if (!t.accountId && !cellText(rawAcc) && t.kind !== 'transfer') {
        const { own, shared } = accountsFor(t.propertyId);
        t.accountId = own[0]?.id || shared[0]?.id || (S.accounts.length === 1 ? S.accounts[0].id : '');
      }
      if (!t.accountId) errors.push(cellText(rawAcc) ? `Account “${cellText(rawAcc)}” not matched` : 'Account is empty');
      else if (!t.propertyId && t.kind !== 'transfer' && byId('accounts', t.accountId)?.propertyId) t.propertyId = byId('accounts', t.accountId).propertyId;
    }
    if (t.kind === 'transfer') {
      t.toAccountId = R.account(impCell(r, 'toAccount'));
      if (!t.toAccountId) errors.push('To account is empty or not matched');
      else if (t.toAccountId === t.accountId) errors.push('Account and To account are the same');
    }
    // duplicates
    const eid = cellText(impCell(r, 'entryId'));
    let dup = '';
    if (eid && ids.has(eid)) dup = 'Already in the app (same entry ID)';
    else if (t.date && existing.has(dupKey(t))) { const x = existing.get(dupKey(t)); dup = `Looks like an existing entry: ${txnTitle(x)} on ${fmtDate(x.date)}`; }
    const fk = dupKey(t) + '|' + t.description;
    if (fileKeys.has(fk)) warnings.push(`Same as row ${fileKeys.get(fk)} in this file`); else fileKeys.set(fk, rowNo);
    out.push({ rowNo, txn: t, errors, warnings, dup });
  }
  return { rows: out, pending: R.pending, newAccounts };
}

// ---------------------------------------------------------------- commit & undo
async function commitImport(built) {
  const pick = built.rows.filter((x) => !x.errors.length && !(x.dup && IMP.skipDup));
  if (!pick.length) return toast('Nothing to import');
  const importId = 'imp_' + uid();
  const created = { accounts: [], partners: [] };
  const acctFor = {};
  for (const x of pick) {
    const v = x.txn.via;
    if (v?.t === 'a' && v.id.startsWith('__new:')) {
      const pid = v.id.slice(6);
      if (!acctFor[pid]) { const a = await createDefaultAccount(pid); acctFor[pid] = a.id; created.accounts.push(a.id); }
      x.txn.via = { t: 'a', id: acctFor[pid] };
    }
  }
  const now = Date.now();
  const txns = pick.map((x, i) => {
    const t = { ...x.txn, id: uid() + i.toString(36), importId };
    const ts = new Date(now + i).toISOString();
    t.createdAt = ts; t.updatedAt = ts;
    for (const k of Object.keys(t)) if (t[k] === '' && !['category', 'description', 'propertyId'].includes(k)) delete t[k];
    return t;
  });
  // "Deposit kept" follows where the deposit was received (same as the entry form)
  for (const t of txns.filter((x) => x.kind === 'deposit_apply')) {
    const src = [...S.txns, ...txns].find((x) => x.leaseId === t.leaseId && x.kind === 'deposit_in');
    if (src) t.via = src.via;
  }
  await DB.putMany('txns', txns);
  S.txns.push(...txns);
  S.settings.imports = [{ id: importId, at: new Date().toISOString(), fileName: IMP.fileName, count: txns.length, created }, ...(S.settings.imports || [])].slice(0, 30);
  markDirty();
  IMP = null;
  toast(`Imported ${txns.length} entr${txns.length === 1 ? 'y' : 'ies'}`);
  location.hash = '#/ledger';
  render();
}
async function undoImport(id) {
  const imp = (S.settings.imports || []).find((x) => x.id === id);
  const list = S.txns.filter((t) => t.importId === id);
  if (!confirm(`Undo this import?\n\n${list.length} entries from “${imp?.fileName || 'file'}” will be deleted.${list.some((t) => t.updatedAt !== t.createdAt) ? '\n\nSome of them were edited after importing — those edits will be lost too.' : ''}`)) return;
  for (const t of list) for (const f of filesFor('txn', t.id)) await remove('files', f.id);
  await DB.delMany('txns', list.map((t) => t.id));
  S.txns = S.txns.filter((t) => t.importId !== id);
  // accounts the import created and nothing uses any more
  for (const aid of imp?.created?.accounts || []) {
    if (byId('accounts', aid) && !S.txns.some((t) => t.accountId === aid || t.toAccountId === aid || (t.via?.t === 'a' && t.via.id === aid))) await remove('accounts', aid);
  }
  S.settings.imports = (S.settings.imports || []).filter((x) => x.id !== id);
  markDirty();
  toast('Import undone');
  render();
}

// ---------------------------------------------------------------- view
async function readImportFile(file) {
  const name = file.name || 'file';
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4b) return Xlsx.read(buf);
  if (/\.(xls|numbers)$/i.test(name)) throw new Error('Please save the file as Excel (.xlsx) or CSV first. (In Numbers: File › Export To › Excel or CSV.)');
  return [{ name: name.replace(/\.[^.]+$/, ''), rows: parseCsv(new TextDecoder().decode(buf)) }];
}
const impSel = (attrs, inner) => `<select ${attrs}>${inner}</select>`;
function matchOptions(field, info, chosen) {
  const cur = chosen !== undefined ? chosen : info.suggestion;
  const blank = (label) => opt('', label, cur);
  switch (field) {
    case 'type': return blank('Choose…') + IMPORT_TYPES.map(([l, k]) => opt(k, l, cur)).join('') + opt('__skip', 'Skip these rows', cur);
    case 'property': return blank('Leave blank (no property)') + propertyOptions(cur);
    case 'unit': return blank('Leave blank') + S.units.filter((u) => !info.ctx || u.propertyId === info.ctx).map((u) => opt(u.id, unitLabel(u), cur)).join('');
    case 'lease': {
      const ls = S.leases.filter((l) => !info.ctx || byId('units', l.unitId)?.propertyId === info.ctx);
      const tenants = [...new Set(ls.map((l) => l.tenantId))];
      return blank('Leave blank') + tenants.filter((tid) => ls.filter((l) => l.tenantId === tid).length > 1).map((tid) => opt('t:' + tid, `${tenantName(tid)} (lease matching each date)`, cur)).join('') +
        ls.map((l) => opt('l:' + l.id, leaseImportLabel(l), cur)).join('');
    }
    case 'partner': return blank('Leave blank') + S.partners.map((p) => opt(p.id, p.name + (p.isSelf ? ' (me)' : ''), cur)).join('');
    case 'account': return blank('Leave blank') + S.accounts.map((a) => opt(a.id, a.name, cur)).join('');
    case 'via': return blank('Property\'s common account (default)') +
      (S.accounts.length ? `<optgroup label="Common accounts">${S.accounts.map((a) => opt('a:' + a.id, a.name, cur)).join('')}</optgroup>` : '') +
      `<optgroup label="A partner personally">${S.partners.map((p) => opt('p:' + p.id, personallyLabel(p), cur)).join('')}</optgroup>`;
    default: return '';
  }
}
const MATCH_LABELS = { type: 'Type', property: 'Property', unit: 'Unit', lease: 'Tenant / lease', partner: 'Partner', account: 'Account', via: 'Paid from / received into' };

V.import = () => {
  const pastImports = (S.settings.imports || []).filter((x) => S.txns.some((t) => t.importId === x.id));
  const past = pastImports.length ? `<h2>Previous imports</h2><div class="list">${pastImports.map((x) => `<div class="row"><div class="grow"><div class="t">${esc(x.fileName)}</div><div class="s">${fmtDate(x.at.slice(0, 10))} · ${plural(S.txns.filter((t) => t.importId === x.id).length, 'entry', 'entries')}</div></div><a class="btn sm sec" href="#/ledger?imp=${x.id}">View</a><button class="btn sm danger" data-act="undoImport" data-id="${x.id}">Undo</button></div>`).join('')}</div>` : '';
  if (!IMP) {
    return {
      title: 'Import', back: '#/more',
      html: `<div class="card pad" style="margin-top:12px">
          <div class="t" style="font-weight:600;margin-bottom:6px">Add many past entries at once</div>
          <ol class="small" style="padding-left:18px;margin:0 0 12px">
            <li>Download the template. Its columns have <b>dropdown lists with your own properties, units, tenants, partners and accounts</b>, so you pick instead of typing.</li>
            <li>Fill in one row per payment in Excel, Numbers or Google Sheets.</li>
            <li>Choose the file here. You'll see a preview and can fix anything before importing.</li>
          </ol>
          <button class="btn block" data-act="importTemplate">Download template (.xlsx)</button>
          <div class="hint" style="margin:8px 2px 0">Add your properties, units, tenants/leases, partners and accounts in the app <b>first</b> — the dropdowns are made from them. Re-download the template after adding more.</div>
        </div>
        <div class="card pad">
          <input type="file" id="impFile" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
          <button class="btn block" id="impPick">Choose file to import…</button>
          <div class="hint" style="margin:8px 2px 0">Excel (.xlsx) or CSV. Your own spreadsheet or a bank export works too — you'll match its columns with dropdowns.</div>
        </div>${past}`,
      bind(main) {
        $('#impPick', main).onclick = () => $('#impFile', main).click();
        $('#impFile', main).onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const sheets = await readImportFile(f);
            if (!sheets.some((s) => s.rows.some((r) => r.some((c) => cellText(c))))) throw new Error('The file is empty.');
            startImport(f.name, sheets);
            render();
          } catch (err) { alert('Could not read the file: ' + err.message); }
        };
      },
    };
  }
  const built = buildImport();
  const rows = IMP.sheets[IMP.sheetIdx].rows;
  const headers = rows[IMP.headerRow] || [];
  const dataRows = impDataRows();
  const samples = headers.map((_, ci) => { const r = dataRows.find(({ r }) => cellText(r[ci])); return r ? cellText(r.r[ci]).slice(0, 24) : ''; });
  const sample = (ci) => samples[ci];
  const colOpts = (key) => opt('', '— not in file —', IMP.colMap[key] ?? '') + headers.map((h, i) => opt(i, `${cellText(h) || Xlsx.colName(i)}${sample(i) ? ' (e.g. ' + sample(i) + ')' : ''}`, IMP.colMap[key] ?? '')).join('');
  const hasAmount = ['amount', 'moneyIn', 'moneyOut'].some((k) => IMP.colMap[k] !== undefined);
  const colsOk = IMP.colMap.date !== undefined && hasAmount;
  const ready = built.rows.filter((x) => !x.errors.length && !(x.dup && IMP.skipDup));
  const bad = built.rows.filter((x) => x.errors.length);
  const dups = built.rows.filter((x) => !x.errors.length && x.dup);
  const pendingList = Object.entries(built.pending).flatMap(([field, obj]) => Object.entries(obj).map(([key, info]) => ({ field, key, info })));
  const unresolved = pendingList.filter(({ field, key }) => IMP.map[field]?.[key] === undefined);
  const shown = built.rows.filter((x) => IMP.filter === 'all' || (IMP.filter === 'bad' ? x.errors.length : IMP.filter === 'dup' ? x.dup && !x.errors.length : IMP.filter === 'warn' ? x.warnings.length && !x.errors.length : !x.errors.length && !(x.dup && IMP.skipDup)));
  const txLine = (t) => [KINDS[t.kind]?.short, t.propertyId && propName(t.propertyId), t.unitId && unitName(t.unitId), t.leaseId && tenantName(byId('leases', t.leaseId)?.tenantId), t.category, t.period && 'for ' + monthLabel(t.period),
    t.via && (t.via.id?.startsWith('__new:') ? 'into new ' + (built.newAccounts[t.via.id.slice(6)] || 'account') : (KINDS[t.kind].dir === 'out' ? 'paid from ' : 'into ') + viaLabel(t.via)),
    t.handledBy && 'by ' + partnerName(t.handledBy), t.partnerId && partnerName(t.partnerId) + (t.toPartnerId ? ' → ' + partnerName(t.toPartnerId) : ''), t.accountId && accountName(t.accountId) + (t.toAccountId ? ' → ' + accountName(t.toAccountId) : '')].filter(Boolean).join(' · ');
  const visibleSheets = IMP.sheets.map((s, i) => [s, i]).filter(([s]) => !s.hidden);
  return {
    title: 'Import', back: '#/more',
    actions: [{ label: 'Start over', act: 'importReset' }],
    html: `<div class="card pad" style="margin-top:12px"><div class="t" style="font-weight:600;word-break:break-all">${esc(IMP.fileName)}</div>
        <div class="two" style="margin-top:10px">
          ${visibleSheets.length > 1 ? field('Sheet', impSel('id="impSheet"', visibleSheets.map(([s, i]) => opt(i, s.name, IMP.sheetIdx)).join(''))) : ''}
          ${field('Headings are in row', impSel('id="impHead"', rows.slice(0, 15).map((r, i) => opt(i, `${i + 1}: ${(r || []).map(cellText).filter(Boolean).slice(0, 3).join(', ').slice(0, 30) || '(empty)'}`, IMP.headerRow)).join('')))}
          ${field('Dates are written as', impSel('id="impOrder"', opt('dmy', 'Day / month / year (31/01/2025)', IMP.order) + opt('mdy', 'Month / day / year (01/31/2025)', IMP.order)))}
        </div>
        ${IMP.orderSure ? '' : '<div class="hint warn" style="margin-top:0">Some dates could be read either way (e.g. 03/04/2025). Check the date order above.</div>'}
      </div>
      <div class="card pad"><div class="t" style="font-weight:600">For empty cells, use</div>
        <div class="hint" style="margin:4px 0 10px">Handy for a bank statement: e.g. every row is for one property and went through one account.</div>
        <div class="two">
          ${field('Property', impSel('id="impDefProp"', propertyOptions(IMP.defProp || '', 'None')))}
          ${field('Paid from / received into', impSel('id="impDefVia"', matchOptions('via', { suggestion: '' }, IMP.defVia || '')))}
        </div></div>
      <details class="card pad" id="impCols"${colsOk && !IMP.colsOpen ? '' : ' open'}><summary style="font-weight:600">Columns ${colsOk ? '✓' : '<span class="err">— choose Date and Amount</span>'}</summary>
        <div class="hint" style="margin:8px 0">Which column of your file holds each thing. Already matched by the headings — change any that are wrong.</div>
        <div class="map-grid">${IMPORT_FIELDS.map((f) => `<span>${esc(f.header)}${f.need === 'required' ? ' *' : ''}</span>${impSel(`data-col="${f.key}"`, colOpts(f.key))}`).join('')}</div>
        <div class="hint" style="margin:6px 0 0">* required. Amount: one “Amount” column, or separate “Money in” / “Money out” columns (like a bank statement). Without a Type column, money in = income and money out = expense.</div>
      </details>
      ${pendingList.length ? `<h2>Match names (${pendingList.length})</h2>
        <div class="hint" style="margin:0 16px 8px">These words in your file don't exactly match anything in the app. Pick the right one from each list${unresolved.length ? ' — our best guess is pre-selected' : ''}.</div>
        <div class="list">${pendingList.map(({ field, key, info }) => `<div class="row match-row"><div class="grow"><div class="small muted">${esc(MATCH_LABELS[field])}${info.ctx ? ' · ' + esc(propName(info.ctx)) : ''} · ${plural(info.count, 'row', 'rows')}</div><div class="t">“${esc(info.text)}”</div></div>${impSel(`data-match="${field}" data-key="${esc(key)}"`, matchOptions(field, info, IMP.map[field]?.[key]))}</div>`).join('')}</div>` : ''}
      <div class="stats" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat"><div class="k">Ready</div><div class="v pos" style="font-size:18px">${ready.length}</div></div>
        <div class="stat"><div class="k">Problems</div><div class="v ${bad.length ? 'neg' : ''}" style="font-size:18px">${bad.length}</div><div class="x">not imported</div></div>
        <div class="stat"><div class="k">Duplicates?</div><div class="v ${dups.length ? 'warn' : ''}" style="font-size:18px">${dups.length}</div><div class="x">${IMP.skipDup ? 'skipped' : 'imported'}</div></div>
      </div>
      ${dups.length ? `<label class="check" style="margin:4px 16px 8px"><input type="checkbox" id="impSkipDup" ${IMP.skipDup ? 'checked' : ''}> Skip entries that look like ones already in the app</label>` : ''}
      ${Object.keys(built.newAccounts).length ? `<div class="hint" style="margin:0 16px 8px">Will also create: ${esc(Object.values(built.newAccounts).join(', '))} (for entries with a blank “Paid from / received into”).</div>` : ''}
      <div class="btns"><button class="btn block" id="impGo" ${ready.length && colsOk ? '' : 'disabled'}>Import ${plural(ready.length, 'entry', 'entries')}</button></div>
      <div class="filters">${impSel('id="impFilter"', opt('all', `All rows (${built.rows.length})`, IMP.filter) + opt('ok', `Will be imported (${ready.length})`, IMP.filter) + opt('bad', `Problems (${bad.length})`, IMP.filter) + opt('dup', `Possible duplicates (${dups.length})`, IMP.filter) + opt('warn', `Warnings (${built.rows.filter((x) => x.warnings.length && !x.errors.length).length})`, IMP.filter))}</div>
      <div class="list">${shown.slice(0, 300).map((x) => { const t = x.txn; const skip = x.errors.length || (x.dup && IMP.skipDup); return `<div class="row imp-row${skip ? ' skip' : ''}"><div class="grow">
          <div class="t">${x.errors.length ? '<span class="chip bad">Problem</span> ' : x.dup ? '<span class="chip warn">Duplicate?</span> ' : '<span class="chip ok">✓</span> '}${esc(t.date ? fmtDate(t.date) : '—')} · ${esc(t.kind && !x.errors.some((e) => /type/i.test(e)) ? (t.category || KINDS[t.kind].short) : '?')}</div>
          <div class="s">Row ${x.rowNo} · ${esc(txLine(t))}</div>
          ${t.description ? `<div class="d">${esc(t.description)}</div>` : ''}
          ${[...x.errors.map((e) => `<div class="small err">✗ ${esc(e)}</div>`), x.dup ? `<div class="small warn">${esc(x.dup)}</div>` : '', ...x.warnings.map((w) => `<div class="small warn">⚠ ${esc(w)}</div>`)].join('')}
        </div><div class="r amt ${KINDS[t.kind]?.dir === 'in' ? 'pos' : KINDS[t.kind]?.dir === 'out' ? 'neg' : ''}">${t.amount ? money(t.amount) : '—'}</div></div>`; }).join('') || '<div class="empty">No rows</div>'}
        ${shown.length > 300 ? `<div class="empty small">…and ${shown.length - 300} more</div>` : ''}</div>
      ${past}`,
    bind(main) {
      const on = (sel, fn) => { const el = $(sel, main); if (el) el.onchange = fn; };
      on('#impSheet', (e) => { selectSheet(+e.target.value); render(); });
      on('#impHead', (e) => { IMP.headerRow = +e.target.value; resetColumns(); render(); });
      on('#impOrder', (e) => { IMP.order = e.target.value; IMP.orderSure = true; render(); });
      on('#impSkipDup', (e) => { IMP.skipDup = e.target.checked; render(); });
      on('#impFilter', (e) => { IMP.filter = e.target.value; render(); });
      on('#impDefProp', (e) => { IMP.defProp = e.target.value; render(); });
      on('#impDefVia', (e) => { IMP.defVia = e.target.value; render(); });
      const cd = $('#impCols', main);
      if (cd) cd.addEventListener('toggle', () => { IMP.colsOpen = cd.open; });
      $$('[data-col]', main).forEach((el) => (el.onchange = () => {
        const k = el.dataset.col;
        IMP.colsOpen = true;
        if (el.value === '') delete IMP.colMap[k];
        else { for (const [f, c] of Object.entries(IMP.colMap)) if (c === +el.value) delete IMP.colMap[f]; IMP.colMap[k] = +el.value; }
        if (k === 'date') { const d = detectDateOrder(impDataRows().map(({ r }) => r[IMP.colMap.date])); IMP.order = d.order; IMP.orderSure = d.sure; }
        render();
      }));
      $$('[data-match]', main).forEach((el) => (el.onchange = () => { (IMP.map[el.dataset.match] = IMP.map[el.dataset.match] || {})[el.dataset.key] = el.value; render(); }));
      const go = $('#impGo', main);
      if (go) go.onclick = async () => {
        const b = buildImport();
        const n = b.rows.filter((x) => !x.errors.length && !(x.dup && IMP.skipDup)).length;
        const nb = b.rows.filter((x) => x.errors.length).length;
        if (!confirm(`Import ${plural(n, 'entry', 'entries')}?${nb ? `\n\n${plural(nb, 'row has', 'rows have')} problems and will NOT be imported.` : ''}\n\nYou can undo this later from More › Import.`)) return;
        go.disabled = true;
        try { await commitImport(b); } catch (err) { go.disabled = false; alert('Import failed: ' + err.message); }
      };
    },
  };
};

Object.assign(ACTIONS, {
  importTemplate: async () => {
    try { offerFile(await buildImportTemplate(), 'EstateLedger_import_template.xlsx', null, 'Dropdowns list your current properties, units, tenants, partners and accounts.'); }
    catch (e) { alert('Could not build the template: ' + e.message); }
  },
  importReset: () => { IMP = null; render(); },
  undoImport: (d) => undoImport(d.id),
});
