'use strict';
/* Estate Ledger — offline real estate, rental & partnership ledger.
   Everything is stored in this browser's IndexedDB on the device. No network calls. */

// ---------------------------------------------------------------- state
const S = { settings: {}, partners: [], properties: [], units: [], tenants: [], leases: [], accounts: [], txns: [], files: [] };
const DATA_STORES = ['partners', 'properties', 'units', 'tenants', 'leases', 'accounts', 'txns', 'files'];

const KINDS = {
  income: { label: 'Income', short: 'Income', dir: 'in', cats: ['Rent', 'Late fee', 'Parking', 'Utilities reimbursement', 'Maintenance charge', 'Other income'] },
  expense: { label: 'Expense', short: 'Expense', dir: 'out', cats: ['Repairs & maintenance', 'Property tax', 'Insurance', 'Mortgage / loan EMI', 'Loan interest', 'Utilities', 'HOA / society fees', 'Management fees', 'Cleaning', 'Legal & professional', 'Brokerage / advertising', 'Furnishing & appliances', 'Capital improvement', 'Bank charges', 'Travel', 'Other expense'] },
  deposit_in: { label: 'Security deposit received', short: 'Deposit in', dir: 'in', cats: ['Security deposit'] },
  deposit_out: { label: 'Security deposit refunded', short: 'Deposit refund', dir: 'out', cats: ['Deposit refund'] },
  deposit_apply: { label: 'Deposit kept (applied to rent/damages)', short: 'Deposit applied', dir: 'none', cats: ['Rent', 'Damages', 'Cleaning', 'Other'] },
  contribution: { label: 'Partner put money into common account', short: 'Contribution', dir: 'none', cats: ['Capital contribution', 'Loan to partnership'] },
  withdrawal: { label: 'Partner took money from common account', short: 'Withdrawal', dir: 'none', cats: ['Personal use', 'Profit distribution', 'Loan repayment', 'Other'] },
  settlement: { label: 'Partner paid another partner', short: 'Settlement', dir: 'none', cats: ['Settlement'] },
  transfer: { label: 'Transfer between accounts', short: 'Transfer', dir: 'none', cats: ['Transfer'] },
};
const PROPERTY_TYPES = ['Apartment building', 'House', 'Condo / flat', 'Townhouse', 'Commercial', 'Shop', 'Land', 'Other'];

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f = (x) => x) => r2(arr.reduce((a, x) => a + (Number(f(x)) || 0), 0));
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => ymd(new Date());
const thisMonth = () => today().slice(0, 7);
const byId = (store, id) => (id ? S[store].find((x) => x.id === id) : undefined);

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
let _nf = null;
function money(n, signed = false) {
  if (!_nf) {
    try { _nf = new Intl.NumberFormat(undefined, { style: 'currency', currency: S.settings.currency || 'USD', maximumFractionDigits: 2 }); }
    catch { _nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  }
  const v = r2(n);
  const s = _nf.format(Math.abs(v));
  if (v < 0) return '−' + s;
  return signed && v > 0 ? '+' + s : s;
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function guessCurrency() {
  const region = (navigator.language || 'en-US').split('-')[1] || 'US';
  const map = { US: 'USD', IN: 'INR', GB: 'GBP', CA: 'CAD', AU: 'AUD', AE: 'AED', SG: 'SGD', NZ: 'NZD', ZA: 'ZAR', JP: 'JPY', CN: 'CNY', CH: 'CHF', SA: 'SAR', QA: 'QAR', KE: 'KES', NG: 'NGN', MX: 'MXN', BR: 'BRL', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR', MY: 'MYR', PH: 'PHP', ID: 'IDR', TH: 'THB', HK: 'HKD' };
  const eu = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'GR'];
  return map[region] || (eu.includes(region) ? 'EUR' : 'USD');
}
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- persistence
async function save(store, obj) {
  obj.updatedAt = new Date().toISOString();
  if (!obj.createdAt) obj.createdAt = obj.updatedAt;
  await DB.put(store, obj);
  const arr = S[store];
  const i = arr.findIndex((x) => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
  markDirty();
}
async function remove(store, id) {
  await DB.del(store, id);
  S[store] = S[store].filter((x) => x.id !== id);
  if (store === 'files') await DB.del('blobs', id);
  markDirty();
}
async function saveSettings() {
  await DB.put('settings', { id: 'main', ...S.settings });
}
function markDirty() {
  S.settings.lastChangeAt = new Date().toISOString();
  saveSettings();
}
async function loadAll() {
  const st = await DB.get('settings', 'main');
  S.settings = st || {};
  for (const s of DATA_STORES) S[s] = await DB.getAll(s);
  if (!S.settings.currency) S.settings.currency = guessCurrency();
  if (S.settings.compressPhotos === undefined) S.settings.compressPhotos = true;
  if (!S.partners.some((p) => p.isSelf)) {
    const me = { id: uid(), name: 'Me', isSelf: true };
    await save('partners', me);
  }
  _nf = null;
  await saveSettings();
}

// ---------------------------------------------------------------- names
const selfPartner = () => S.partners.find((p) => p.isSelf);
const partnerName = (id) => byId('partners', id)?.name || '(deleted partner)';
const accountName = (id) => byId('accounts', id)?.name || '(deleted account)';
const propName = (id) => byId('properties', id)?.name || '';
const unitName = (id) => byId('units', id)?.name || '';
const tenantName = (id) => byId('tenants', id)?.name || '';
function viaLabel(v) {
  if (!v || !v.id) return '';
  return v.t === 'a' ? accountName(v.id) : partnerName(v.id) + ' (personally)';
}
function leaseLabel(l) {
  if (!l) return '';
  return `${tenantName(l.tenantId) || 'Tenant'} · ${unitName(l.unitId)}${l.status === 'ended' ? ' (ended)' : ''}`;
}
function txnTitle(t) {
  const k = KINDS[t.kind];
  switch (t.kind) {
    case 'contribution': return `${partnerName(t.partnerId)} → ${accountName(t.accountId)}`;
    case 'withdrawal': return `${partnerName(t.partnerId)} took from ${accountName(t.accountId)}`;
    case 'settlement': return `${partnerName(t.partnerId)} paid ${partnerName(t.toPartnerId)}`;
    case 'transfer': return `${accountName(t.accountId)} → ${accountName(t.toAccountId)}`;
    default: return t.category || k.label;
  }
}
function txnSubtitle(t) {
  const bits = [];
  bits.push(KINDS[t.kind]?.short);
  if (t.propertyId) bits.push(propName(t.propertyId));
  if (t.unitId) bits.push(unitName(t.unitId));
  if (t.leaseId) { const l = byId('leases', t.leaseId); if (l) bits.push(tenantName(l.tenantId)); }
  if (t.period && isRentPayment(t)) bits.push('for ' + monthLabel(t.period));
  if (t.via && t.via.id) bits.push((KINDS[t.kind].dir === 'out' ? 'paid from ' : 'into ') + viaLabel(t.via));
  if (t.handledBy && t.via?.t === 'a') bits.push((KINDS[t.kind].dir === 'out' ? 'paid by ' : 'collected by ') + partnerName(t.handledBy));
  return bits.filter(Boolean).join(' · ');
}
// Partners who own a property (in the order they are listed), or [] if none / no property.
function ownerIds(propertyId) {
  const p = byId('properties', propertyId);
  return p ? [...new Set((p.owners || []).map((o) => o.partnerId).filter((id) => byId('partners', id)))] : [];
}
// Partners to offer for an entry: the property's owners when it has any, otherwise everyone.
// `keep` ids stay in the list (e.g. values already saved on an entry being edited).
function partnersFor(propertyId, keep = []) {
  const own = ownerIds(propertyId);
  if (!own.length) return S.partners;
  const ids = new Set([...own, ...keep.filter(Boolean)]);
  return S.partners.filter((p) => ids.has(p.id));
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const findByName = (store, name, exceptId) => S[store].find((x) => x.id !== exceptId && normName(x.name) === normName(name));
// Accounts to offer for a property: that property's own accounts first, then shared ones.
function accountsFor(propertyId) {
  const own = propertyId ? S.accounts.filter((a) => a.propertyId === propertyId) : [];
  const shared = S.accounts.filter((a) => !a.propertyId);
  const other = S.accounts.filter((a) => a.propertyId && a.propertyId !== propertyId);
  return { own, shared, other };
}
// Signed amount from the business point of view (income +, expense −, others shown neutral)
function txnSigned(t) {
  const d = KINDS[t.kind]?.dir;
  return d === 'in' ? t.amount : d === 'out' ? -t.amount : 0;
}

// ---------------------------------------------------------------- ledger math
function normShares(list) {
  const out = {};
  const tot = list.reduce((a, x) => a + (Number(x.pct) || 0), 0);
  if (!tot) return out;
  for (const x of list) if (Number(x.pct)) out[x.partnerId] = (out[x.partnerId] || 0) + Number(x.pct) / tot;
  return out;
}
// Who shares this transaction (fractions summing to 1)?
function sharesFor(t) {
  if (t.split && t.split.length) { const s = normShares(t.split); if (Object.keys(s).length) return s; }
  const p = byId('properties', t.propertyId);
  if (p && p.owners && p.owners.length) { const s = normShares(p.owners); if (Object.keys(s).length) return s; }
  const accId = t.via?.t === 'a' ? t.via.id : t.accountId;
  const a = byId('accounts', accId);
  if (a && a.owners && a.owners.length) { const s = normShares(a.owners); if (Object.keys(s).length) return s; }
  const pid = t.via?.t === 'p' ? t.via.id : t.partnerId;
  if (pid) return { [pid]: 1 };
  const me = selfPartner();
  return me ? { [me.id]: 1 } : {};
}
/* Effects of a transaction:
   cash[accountId]  : change in a common/bank account balance
   cap[partnerId]   : change in partner's capital (what the partnership owes that partner)
   shares           : ownership fractions used to split it
   Rules: income/deposit received — landed in account (+cash) or with a partner personally (partner holds it: −cap);
          every owner gets their share (+cap). Expense/deposit refund is the mirror image.
          Contribution: partner +cap, account +cash. Withdrawal: partner −cap, account −cash.
          Settlement: payer +cap, receiver −cap. Transfer: only cash moves. */
function effects(t) {
  const a = r2(t.amount);
  const cash = {}, cap = {};
  const addCash = (id, v) => { if (id) cash[id] = (cash[id] || 0) + v; };
  const addCap = (id, v) => { if (id) cap[id] = (cap[id] || 0) + v; };
  const shares = sharesFor(t);
  switch (t.kind) {
    case 'income':
    case 'deposit_in':
      if (t.via?.t === 'a') addCash(t.via.id, a); else if (t.via?.t === 'p') addCap(t.via.id, -a);
      for (const [pid, f] of Object.entries(shares)) addCap(pid, a * f);
      break;
    case 'expense':
    case 'deposit_out':
      if (t.via?.t === 'a') addCash(t.via.id, -a); else if (t.via?.t === 'p') addCap(t.via.id, a);
      for (const [pid, f] of Object.entries(shares)) addCap(pid, -a * f);
      break;
    case 'contribution': addCash(t.accountId, a); addCap(t.partnerId, a); break;
    case 'withdrawal': addCash(t.accountId, -a); addCap(t.partnerId, -a); break;
    case 'settlement': addCap(t.partnerId, a); addCap(t.toPartnerId, -a); break;
    case 'transfer': addCash(t.accountId, -a); addCash(t.toAccountId, a); break;
    default: break; // deposit_apply: no cash or capital movement (already split when received)
  }
  return { cash, cap, shares };
}
/* Net position per partner: positive = others owe this partner; negative = this partner owes.
   For each transaction: partner's capital change minus their ownership share of the total capital change. */
function partnerPositions(txns) {
  const pos = {}, br = {};
  const b = (pid) => (br[pid] = br[pid] || { paidPersonally: 0, receivedPersonally: 0, contributed: 0, withdrawn: 0, settledPaid: 0, settledReceived: 0, shareIncome: 0, shareExpense: 0 });
  for (const t of txns) {
    const { cap, shares } = effects(t);
    const total = Object.values(cap).reduce((x, y) => x + y, 0);
    const ids = new Set([...Object.keys(cap), ...Object.keys(shares)]);
    for (const pid of ids) pos[pid] = (pos[pid] || 0) + (cap[pid] || 0) - (shares[pid] || 0) * total;
    const a = r2(t.amount);
    if (t.kind === 'income' || t.kind === 'deposit_in') {
      if (t.via?.t === 'p') b(t.via.id).receivedPersonally += a;
      for (const [pid, f] of Object.entries(shares)) b(pid).shareIncome += a * f;
    } else if (t.kind === 'expense' || t.kind === 'deposit_out') {
      if (t.via?.t === 'p') b(t.via.id).paidPersonally += a;
      for (const [pid, f] of Object.entries(shares)) b(pid).shareExpense += a * f;
    } else if (t.kind === 'contribution') b(t.partnerId).contributed += a;
    else if (t.kind === 'withdrawal') b(t.partnerId).withdrawn += a;
    else if (t.kind === 'settlement') { b(t.partnerId).settledPaid += a; b(t.toPartnerId).settledReceived += a; }
  }
  for (const k of Object.keys(pos)) pos[k] = r2(pos[k]);
  for (const k of Object.keys(br)) for (const f of Object.keys(br[k])) br[k][f] = r2(br[k][f]);
  return { pos, br };
}
// Minimal list of payments that settles everybody.
function settlePlan(pos) {
  const cred = [], debt = [];
  for (const [pid, v] of Object.entries(pos)) {
    if (v > 0.005) cred.push({ pid, v }); else if (v < -0.005) debt.push({ pid, v: -v });
  }
  cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
  const plan = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].v, cred[j].v);
    if (x > 0.005) plan.push({ from: debt[i].pid, to: cred[j].pid, amount: r2(x) });
    debt[i].v -= x; cred[j].v -= x;
    if (debt[i].v < 0.005) i++;
    if (cred[j].v < 0.005) j++;
  }
  return plan;
}
function accountBalance(accId) {
  const a = byId('accounts', accId);
  let bal = Number(a?.openingBalance) || 0;
  for (const t of S.txns) bal += effects(t).cash[accId] || 0;
  return r2(bal);
}

// ---------------------------------------------------------------- rent math
function isRentPayment(t) {
  return (t.kind === 'income' || t.kind === 'deposit_apply') && t.leaseId && /rent/i.test(t.category || '');
}
function daysIn(y, m) { return new Date(y, m, 0).getDate(); }
// Due date of the rent for a lease in month ym (YYYY-MM), or null if the lease doesn't cover it.
function dueDate(l, ym) {
  const [y, m] = ym.split('-').map(Number);
  let d = `${ym}-${pad2(Math.min(Number(l.dueDay) || 1, daysIn(y, m)))}`;
  if (!l.startDate || ym < l.startDate.slice(0, 7)) return null;
  if (d < l.startDate) d = l.startDate;
  const end = l.status === 'ended' ? (l.endDate || l.endedOn) : l.endDate;
  if (end && d > end) return null;
  return d;
}
function leaseDueMonths(l, upTo = today()) {
  const out = [];
  if (!l.startDate) return out;
  let ym = l.startDate.slice(0, 7);
  const last = upTo.slice(0, 7);
  let guard = 0;
  while (ym <= last && guard++ < 600) {
    const d = dueDate(l, ym);
    if (d && d <= upTo) out.push(ym);
    ym = addMonths(ym, 1);
  }
  return out;
}
function leaseStats(l) {
  const tx = S.txns.filter((t) => t.leaseId === l.id);
  const months = leaseDueMonths(l);
  const rentDue = r2(months.length * (Number(l.rent) || 0) + (Number(l.adjustment) || 0));
  const rentPaid = sum(tx.filter(isRentPayment), (t) => t.amount);
  const depIn = sum(tx.filter((t) => t.kind === 'deposit_in'), (t) => t.amount);
  const depOut = sum(tx.filter((t) => t.kind === 'deposit_out'), (t) => t.amount);
  const depApplied = sum(tx.filter((t) => t.kind === 'deposit_apply'), (t) => t.amount);
  return { months, rentDue, rentPaid, balance: r2(rentDue - rentPaid), depIn, depOut, depApplied, depHeld: r2(depIn - depOut - depApplied), depPending: r2((Number(l.deposit) || 0) - depIn) };
}
function paidForPeriod(l, ym) {
  return sum(S.txns.filter((t) => t.leaseId === l.id && isRentPayment(t) && (t.period || t.date.slice(0, 7)) === ym), (t) => t.amount);
}
function leaseIsActiveOn(l, date) {
  if (l.status === 'ended') return false;
  return l.startDate <= date && (!l.endDate || l.endDate >= date);
}
function currentLease(unitId) {
  const d = today();
  return S.leases.find((l) => l.unitId === unitId && leaseIsActiveOn(l, d)) || S.leases.find((l) => l.unitId === unitId && l.status !== 'ended' && l.startDate > d);
}
function propertyStats(p, year) {
  const units = S.units.filter((u) => u.propertyId === p.id);
  const occupied = units.filter((u) => { const l = currentLease(u.id); return l && leaseIsActiveOn(l, today()); }).length;
  const tx = S.txns.filter((t) => t.propertyId === p.id && (!year || t.date.startsWith(year)));
  const income = sum(tx.filter((t) => t.kind === 'income' || t.kind === 'deposit_apply'), (t) => t.amount);
  const expense = sum(tx.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const leases = S.leases.filter((l) => units.some((u) => u.id === l.unitId));
  const depHeld = sum(leases, (l) => leaseStats(l).depHeld);
  const outstanding = sum(leases, (l) => Math.max(0, leaseStats(l).balance));
  return { units: units.length, occupied, income, expense, net: r2(income - expense), depHeld, outstanding };
}

// ---------------------------------------------------------------- sheets (modal forms)
let sheetOnClose = null;
function openSheet(title, html, bind, onClose) {
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.innerHTML = html;
  body.scrollTop = 0;
  $('#sheetBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  sheetOnClose = onClose || null;
  if (bind) bind(body);
  return body;
}
function closeSheet() {
  $('#sheetBackdrop').hidden = true;
  document.body.style.overflow = '';
  $('#sheetBody').innerHTML = '';
  const f = sheetOnClose; sheetOnClose = null;
  if (f) f();
}
function readForm(root) {
  const o = {};
  $$('[name]', root).forEach((el) => {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type !== 'file') o[el.name] = el.value.trim();
  });
  return o;
}
const opt = (value, label, sel) => `<option value="${esc(value)}"${String(sel ?? '') === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
const field = (label, inner, hint) => `<label class="field"><span>${esc(label)}</span>${inner}</label>${hint ? `<div class="hint">${hint}</div>` : ''}`;
const inp = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
function moneyInput(name, value, attrs = '') {
  return `<input name="${name}" type="text" inputmode="decimal" autocomplete="off" value="${value === undefined || value === null || value === '' ? '' : esc(value)}" ${attrs}>`;
}
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[, ]/g, '')); return isFinite(n) ? n : 0; };

function partnerOptions(sel, withBlank, list = S.partners) {
  return (withBlank ? opt('', withBlank, sel) : '') + list.map((p) => opt(p.id, p.name + (p.isSelf ? ' (me)' : ''), sel)).join('');
}
function accountOptions(sel, withBlank) {
  return (withBlank ? opt('', withBlank, sel) : '') + S.accounts.map((a) => opt(a.id, a.name + (a.propertyId && !normName(a.name).includes(normName(propName(a.propertyId))) ? ` (${propName(a.propertyId)})` : ''), sel)).join('');
}
function propertyOptions(sel, withBlank) {
  return (withBlank ? opt('', withBlank, sel) : '') + [...S.properties].sort((a, b) => a.name.localeCompare(b.name)).map((p) => opt(p.id, p.name, sel)).join('');
}
function viaOptions(sel) {
  let h = '';
  if (S.accounts.length) h += '<optgroup label="Common / bank accounts">' + S.accounts.map((a) => opt('a:' + a.id, a.name, sel)).join('') + '</optgroup>';
  h += '<optgroup label="A partner personally">' + S.partners.map((p) => opt('p:' + p.id, p.name + (p.isSelf ? ' (me)' : '') + ' – personally', sel)).join('') + '</optgroup>';
  return h;
}
const viaKey = (v) => (v && v.id ? v.t + ':' + v.id : '');
const parseVia = (s) => (s && s.includes(':') ? { t: s.split(':')[0], id: s.slice(2) } : null);

// Owners editor (used by property & account forms)
function ownersEditor(owners) {
  return `<div id="owners">${owners.map((o, i) => `
    <div class="owner-row">
      <select name="owner_p_${i}">${partnerOptions(o.partnerId)}</select>
      <input name="owner_pct_${i}" inputmode="decimal" value="${esc(o.pct)}" placeholder="%">
      <button type="button" data-owner-del="${i}" aria-label="Remove">×</button>
    </div>`).join('')}</div>
    <div class="btns" style="margin:0 0 12px"><button type="button" class="btn sec sm" id="addOwner">+ Owner</button><button type="button" class="btn sec sm" id="newPartner">+ New partner</button></div>
    <div class="hint" id="ownerSum"></div>`;
}
function readOwners(root) {
  const out = [];
  $$('.owner-row', root).forEach((row, i) => {
    const pid = $(`[name="owner_p_${i}"]`, row)?.value;
    const pct = num($(`[name="owner_pct_${i}"]`, row)?.value);
    if (pid && pct > 0) out.push({ partnerId: pid, pct });
  });
  return out;
}
// Names of partners picked in more than one owner row.
function duplicateOwners(owners) {
  const seen = new Set(), dup = new Set();
  for (const o of owners) (seen.has(o.partnerId) ? dup : seen).add(o.partnerId);
  return [...dup].map(partnerName);
}
function bindOwners(root, getOwners) {
  let owners = getOwners();
  const rerender = () => {
    const wrap = $('#owners', root).parentElement;
    const tmp = document.createElement('div');
    tmp.innerHTML = ownersEditor(owners);
    $('#owners', root).replaceWith($('#owners', tmp));
    upd();
    bindRows();
  };
  const upd = () => {
    const tot = r2(sum(readOwners(root), (o) => o.pct));
    const dup = duplicateOwners($$('.owner-row select', root).map((el) => ({ partnerId: el.value })));
    $('#ownerSum', root).innerHTML = (dup.length ? `<span class="err">${esc(dup.join(', '))} is listed more than once — remove the extra row.</span><br>` : '') +
      (tot === 100 ? `Total ${tot}% ✓` : `<span class="err">Total is ${tot}% — should be 100%</span>`);
  };
  const snapshot = () => { owners = $$('.owner-row', root).map((row, i) => ({ partnerId: $(`[name="owner_p_${i}"]`, row).value, pct: $(`[name="owner_pct_${i}"]`, row).value })); };
  const bindRows = () => {
    $$('[data-owner-del]', root).forEach((b) => (b.onclick = () => { snapshot(); owners.splice(+b.dataset.ownerDel, 1); rerender(); }));
    $$('.owner-row input, .owner-row select', root).forEach((el) => (el.oninput = upd));
  };
  $('#addOwner', root).onclick = () => {
    snapshot();
    const used = new Set(owners.map((o) => o.partnerId));
    const next = S.partners.find((p) => !used.has(p.id));
    if (!next) return toast('Every partner is already listed. Use “+ New partner” to add someone new.');
    const rest = Math.max(0, r2(100 - sum(owners, (o) => num(o.pct))));
    owners.push({ partnerId: next.id, pct: rest });
    rerender();
  };
  $('#newPartner', root).onclick = async () => {
    const name = prompt('New partner name');
    if (!name || !name.trim()) return;
    snapshot();
    let p = findByName('partners', name);
    if (p) {
      if (owners.some((o) => o.partnerId === p.id)) return toast(`${p.name} is already an owner here`);
      toast(`${p.name} already exists — added the existing partner`);
    } else {
      p = { id: uid(), name: name.trim().replace(/\s+/g, ' ') };
      await save('partners', p);
    }
    const rest = Math.max(0, r2(100 - sum(owners, (o) => num(o.pct))));
    owners.push({ partnerId: p.id, pct: rest });
    rerender();
  };
  bindRows();
  upd();
}

// ---------------------------------------------------------------- attachments
const urlCache = new Map();
async function blobFor(fileId) {
  const rec = await DB.get('blobs', fileId);
  if (!rec) return null;
  const meta = byId('files', fileId);
  return rec.buf ? new Blob([rec.buf], { type: rec.type || meta?.type || 'application/octet-stream' }) : rec.blob;
}
async function urlFor(fileId) {
  if (urlCache.has(fileId)) return urlCache.get(fileId);
  const b = await blobFor(fileId);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(fileId, u);
  return u;
}
async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('Cannot read image')); };
    img.src = u;
  });
}
async function prepareUpload(file) {
  let blob = file, name = file.name || 'file', type = file.type || 'application/octet-stream';
  if (S.settings.compressPhotos && /^image\/(jpeg|png|webp|heic|heif)$/i.test(type) && file.size > 350 * 1024) {
    try {
      const img = await loadImage(file);
      const w = img.width, h = img.height, max = 2000;
      const k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      if (out && out.size < file.size) { blob = out; type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
    } catch { /* keep original */ }
  }
  return { blob, name, type };
}
async function storeFiles(files, link) {
  for (const f of files) {
    const { blob, name, type } = await prepareUpload(f);
    const id = uid();
    await DB.put('blobs', { id, buf: await blob.arrayBuffer(), type });
    await save('files', { id, name, type, size: blob.size, linkType: link.linkType, linkId: link.linkId || null, propertyId: link.propertyId || null, note: link.note || '' });
  }
}
function filesFor(linkType, linkId) {
  return S.files.filter((f) => f.linkType === linkType && f.linkId === linkId);
}
function thumbHtml(f, removable) {
  const isImg = /^image\//.test(f.type);
  return `<div class="thumb" data-view-file="${f.id}" title="${esc(f.name)}">${isImg ? `<img data-thumb="${f.id}" alt="">` : `<span>${esc((f.name.split('.').pop() || 'file').toUpperCase())}<br>${esc(f.name.slice(0, 18))}</span>`}${removable ? `<button type="button" class="x" data-del-file="${f.id}" aria-label="Remove">×</button>` : ''}</div>`;
}
async function hydrateThumbs(root) {
  for (const img of $$('img[data-thumb]', root)) {
    const u = await urlFor(img.dataset.thumb);
    if (u) img.src = u;
  }
}
// Attachment block inside forms. pending = array of File objects not yet saved.
function attachBlock(existing, pending) {
  return `<div class="field"><span>Attachments (statements, receipts, photos, PDFs)</span>
    <div class="thumbs" id="thumbs">${existing.map((f) => thumbHtml(f, true)).join('')}${pending.map((f, i) => `<div class="thumb"><span>NEW<br>${esc(f.name.slice(0, 18))}</span><button type="button" class="x" data-del-pending="${i}">×</button></div>`).join('')}</div>
    <input type="file" id="fileInput" multiple accept="image/*,application/pdf,.pdf,.csv,.xlsx,.xls,.doc,.docx,.txt" hidden>
    <button type="button" class="btn sec sm" id="addFiles">+ Add files / photos</button></div>`;
}
function bindAttach(root, pending, rerender) {
  $('#addFiles', root).onclick = () => $('#fileInput', root).click();
  $('#fileInput', root).onchange = (e) => { pending.push(...e.target.files); rerender(); };
  $$('[data-del-pending]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); pending.splice(+b.dataset.delPending, 1); rerender(); }));
  $$('[data-del-file]', root).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this attachment?')) return;
    await remove('files', b.dataset.delFile);
    rerender();
  }));
  hydrateThumbs(root);
}
function fileLinkLabel(f) {
  switch (f.linkType) {
    case 'txn': { const t = byId('txns', f.linkId); return t ? `Transaction: ${txnTitle(t)} (${fmtDate(t.date)})` : 'Transaction (deleted)'; }
    case 'property': return 'Property: ' + propName(f.linkId);
    case 'lease': return 'Lease: ' + leaseLabel(byId('leases', f.linkId));
    case 'tenant': return 'Tenant: ' + tenantName(f.linkId);
    default: return f.propertyId ? 'Document · ' + propName(f.propertyId) : 'General document';
  }
}
async function viewFile(id, after) {
  const f = byId('files', id);
  if (!f) return;
  const u = await urlFor(id);
  const isImg = /^image\//.test(f.type);
  openSheet(f.name, `<div class="viewer">
      ${isImg ? `<img src="${u}" alt="">` : `<div class="card pad" style="margin:0 0 12px">${esc(f.type || 'File')} · ${fmtSize(f.size)}</div>`}
      <div class="small muted" style="margin-bottom:10px">${esc(fileLinkLabel(f))}<br>Added ${fmtDate((f.createdAt || '').slice(0, 10))} · ${fmtSize(f.size)}</div>
      ${field('Note', `<textarea name="note">${esc(f.note || '')}</textarea>`)}
      <div class="btns" style="margin:0 0 10px">
        <a class="btn sec" href="${u}" target="_blank" rel="noopener">Open</a>
        <button class="btn sec" id="shareFile">Share / Save</button>
      </div>
      <button class="btn block" id="saveNote">Save note</button>
      <button class="btn danger block" id="delFile" style="margin-top:8px">Delete file</button>
    </div>`, (b) => {
    $('#shareFile', b).onclick = async () => shareBlob(await blobFor(id), f.name);
    $('#saveNote', b).onclick = async () => { f.note = $('[name=note]', b).value.trim(); await save('files', f); closeSheet(); toast('Saved'); };
    $('#delFile', b).onclick = async () => { if (!confirm('Delete this file?')) return; await remove('files', id); closeSheet(); render(); };
  }, after);
}
async function shareBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
// Two-step delivery so the share sheet is opened directly from a tap (required by iOS).
function offerFile(blob, filename, onDone, note) {
  openSheet('File ready', `<div class="card pad" style="margin:0 0 14px"><div class="t" style="font-weight:600;word-break:break-all">${esc(filename)}</div><div class="small muted">${fmtSize(blob.size)}</div>${note ? `<div class="small pos" style="margin-top:4px">${esc(note)}</div>` : ''}</div>
    <button class="btn block" id="doShare">Share / Save to Files</button>
    <div class="hint" style="margin-top:10px">In the share sheet choose <b>Save to Files</b> (On My iPhone or iCloud Drive), AirDrop, Mail, WhatsApp, etc.</div>`, (b) => {
    $('#doShare', b).onclick = async () => { const ok = await shareBlob(blob, filename); if (ok) { if (onDone) onDone(); closeSheet(); } };
  });
}

// ---------------------------------------------------------------- forms: property / unit / partner / account / tenant
function propertyForm(id) {
  const p = id ? { ...byId('properties', id) } : { id: uid(), name: '', type: PROPERTY_TYPES[0], owners: [{ partnerId: selfPartner().id, pct: 100 }] };
  const isNew = !id;
  openSheet(isNew ? 'New property' : 'Edit property', `<form class="form" id="f">
    ${field('Name', inp('name', p.name, 'required placeholder="e.g. Maple Street Duplex"'))}
    ${field('Address', `<textarea name="address">${esc(p.address || '')}</textarea>`)}
    ${field('Type', `<select name="type">${PROPERTY_TYPES.map((t) => opt(t, t, p.type)).join('')}</select>`)}
    <div class="two">${field('Purchase date', inp('purchaseDate', p.purchaseDate, 'type="date"'))}${field('Purchase price', moneyInput('purchasePrice', p.purchasePrice))}</div>
    ${field('Current value (estimate)', moneyInput('currentValue', p.currentValue))}
    ${isNew ? field('Number of rentable units', inp('unitCount', 1, 'type="number" min="0" max="200" inputmode="numeric"'), 'Units are created as Unit 1, Unit 2… — rename them later. Use 1 for a single house.') : ''}
    <label class="field"><span>Owners &amp; ownership %</span></label>
    ${ownersEditor(p.owners || [])}
    <div class="hint">Expenses and income for this property are split between owners by these percentages.</div>
    ${field('Notes', `<textarea name="notes">${esc(p.notes || '')}</textarea>`)}
    <button class="btn block">Save</button>
    ${isNew ? '' : '<button type="button" class="btn danger block" id="del">Delete property</button>'}
  </form>`, (b) => {
    bindOwners(b, () => p.owners || []);
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (!d.name) return toast('Name is required');
      const owners = readOwners(b);
      if (!owners.length) return toast('Add at least one owner');
      const dup = duplicateOwners($$('.owner-row select', b).map((el) => ({ partnerId: el.value })));
      if (dup.length) return toast(`${dup.join(', ')} is listed more than once`);
      const tot = r2(sum(owners, (o) => o.pct));
      if (tot !== 100 && !confirm(`Ownership adds up to ${tot}%, not 100%. Shares will be scaled proportionally. Continue?`)) return;
      Object.assign(p, { name: d.name, address: d.address, type: d.type, purchaseDate: d.purchaseDate, purchasePrice: d.purchasePrice ? num(d.purchasePrice) : '', currentValue: d.currentValue ? num(d.currentValue) : '', notes: d.notes, owners });
      await save('properties', p);
      if (isNew) {
        const n = Math.min(200, Math.max(0, parseInt(d.unitCount, 10) || 0));
        for (let i = 1; i <= n; i++) await save('units', { id: uid(), propertyId: p.id, name: n === 1 ? 'Main' : `Unit ${i}` });
      }
      closeSheet();
      if (isNew) location.hash = '#/property/' + p.id; else render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      const n = S.txns.filter((t) => t.propertyId === p.id).length;
      if (n) return alert(`This property has ${n} transactions. Delete or move them first.`);
      const units = S.units.filter((u) => u.propertyId === p.id);
      if (S.leases.some((l) => units.some((u) => u.id === l.unitId))) return alert('Delete the leases of this property first.');
      if (!confirm('Delete this property and its units?')) return;
      for (const u of units) await remove('units', u.id);
      for (const f of filesFor('property', p.id)) await remove('files', f.id);
      await remove('properties', p.id);
      closeSheet();
      location.hash = '#/properties';
    };
  });
}

function unitForm(id, propertyId) {
  const u = id ? { ...byId('units', id) } : { id: uid(), propertyId, name: '' };
  openSheet(id ? 'Edit unit' : 'New unit', `<form class="form" id="f">
    ${field('Property', `<select name="propertyId">${propertyOptions(u.propertyId)}</select>`)}
    ${field('Unit name / number', inp('name', u.name, 'required placeholder="e.g. Flat 101, Upstairs, Shop 2"'))}
    <div class="two">${field('Type / layout', inp('layout', u.layout, 'placeholder="2 bed / 1 bath"'))}${field('Size', inp('size', u.size, 'placeholder="850 sq ft"'))}</div>
    <div class="two">${field('Typical rent', moneyInput('marketRent', u.marketRent))}${field('Typical deposit', moneyInput('defaultDeposit', u.defaultDeposit))}</div>
    ${field('Notes', `<textarea name="notes">${esc(u.notes || '')}</textarea>`)}
    <button class="btn block">Save</button>
    ${id ? '<button type="button" class="btn danger block" id="del">Delete unit</button>' : ''}
  </form>`, (b) => {
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (!d.name) return toast('Name is required');
      Object.assign(u, { propertyId: d.propertyId, name: d.name, layout: d.layout, size: d.size, marketRent: d.marketRent ? num(d.marketRent) : '', defaultDeposit: d.defaultDeposit ? num(d.defaultDeposit) : '', notes: d.notes });
      await save('units', u);
      closeSheet(); render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      if (S.leases.some((l) => l.unitId === u.id)) return alert('This unit has leases. Delete them first.');
      if (S.txns.some((t) => t.unitId === u.id)) return alert('This unit has transactions. Delete or edit them first.');
      if (!confirm('Delete this unit?')) return;
      await remove('units', u.id);
      closeSheet();
      location.hash = '#/property/' + u.propertyId;
    };
  });
}

function partnerForm(id) {
  const p = id ? { ...byId('partners', id) } : { id: uid(), name: '' };
  openSheet(id ? 'Edit partner' : 'New partner', `<form class="form" id="f">
    ${field('Name', inp('name', p.name, 'required'))}
    <div class="two">${field('Phone', inp('phone', p.phone, 'type="tel"'))}${field('Email', inp('email', p.email, 'type="email"'))}</div>
    ${field('Notes', `<textarea name="notes">${esc(p.notes || '')}</textarea>`)}
    <button class="btn block">Save</button>
    ${id && S.partners.length > 1 ? '<button type="button" class="btn sec block" id="merge" style="margin-top:8px">Merge into another partner…</button><div class="hint" style="margin-top:6px">Use this if the same person was added twice.</div>' : ''}
    ${id && !p.isSelf ? '<button type="button" class="btn danger block" id="del">Delete partner</button>' : ''}
  </form>`, (b) => {
    const mg = $('#merge', b);
    if (mg) mg.onclick = () => mergeForm('partners', p.id);
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (!d.name) return toast('Name is required');
      const same = findByName('partners', d.name, p.id);
      if (same && !confirm(`A partner called “${same.name}” already exists. Two partners with the same name will look like duplicates.\n\nSave anyway? (To combine them, use “Merge into another partner” instead.)`)) return;
      Object.assign(p, d);
      await save('partners', p);
      closeSheet(); render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      const used = S.properties.some((x) => x.owners?.some((o) => o.partnerId === p.id)) || S.accounts.some((x) => x.owners?.some((o) => o.partnerId === p.id)) ||
        S.txns.some((t) => t.partnerId === p.id || t.toPartnerId === p.id || t.via?.id === p.id || t.split?.some((s) => s.partnerId === p.id));
      if (used) return alert('This partner is used in properties, accounts or transactions and cannot be deleted.');
      if (!confirm('Delete partner?')) return;
      await remove('partners', p.id); closeSheet(); render();
    };
  });
}

function accountForm(id, preset = {}) {
  const a = id ? { ...byId('accounts', id) } : { id: uid(), name: '', openingBalance: 0, openingDate: today(), ...preset };
  if (!id && !a.owners) a.owners = ownerIds(a.propertyId).length ? byId('properties', a.propertyId).owners.map((o) => ({ ...o })) : S.partners.map((p) => ({ partnerId: p.id, pct: r2(100 / S.partners.length) }));
  const draw = () => {
    const b = $('#sheetBody');
    b.innerHTML = `<form class="form" id="f">
    ${field('Account name', inp('name', a.name, 'required placeholder="e.g. Joint bank account, Cash box"'))}
    ${field('Bank / details', inp('details', a.details, 'placeholder="Bank name, last 4 digits"'))}
    ${field('Property', `<select name="propertyId" id="accProp">${propertyOptions(a.propertyId, 'Shared by all properties')}</select>`, 'Link a property\'s rent / mortgage account to it, so entries for that property pick it automatically.')}
    <div class="two">${field('Opening balance', moneyInput('openingBalance', a.openingBalance ?? 0))}${field('As of', inp('openingDate', a.openingDate || today(), 'type="date"'))}</div>
    <label class="field"><span>Who owns this account &amp; %</span></label>
    ${ownersEditor(a.owners || [])}
    <div class="hint">Entries that belong to a property are always split by that property's owners. These % are only used for entries with no property (e.g. bank charges on a joint account).</div>
    ${field('Notes', `<textarea name="notes">${esc(a.notes || '')}</textarea>`)}
    <button class="btn block">Save</button>
    ${id ? '<button type="button" class="btn danger block" id="del">Delete account</button>' : ''}
  </form>`;
    bindOwners(b, () => a.owners || []);
    $('#accProp', b).onchange = (e) => {
      const d = readForm(b);
      Object.assign(a, { name: d.name, details: d.details, openingBalance: d.openingBalance, openingDate: d.openingDate, notes: d.notes, owners: readOwners(b), propertyId: e.target.value });
      const po = byId('properties', a.propertyId)?.owners;
      if (po?.length) a.owners = po.map((o) => ({ ...o }));
      if (!a.name && a.propertyId) a.name = propName(a.propertyId) + ' account';
      draw();
    };
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (!d.name) return toast('Name is required');
      const owners = readOwners(b);
      const dup = duplicateOwners($$('.owner-row select', b).map((el) => ({ partnerId: el.value })));
      if (dup.length) return toast(`${dup.join(', ')} is listed more than once`);
      if (findByName('accounts', d.name, a.id) && !confirm(`An account called “${d.name}” already exists. Save another one with the same name?`)) return;
      Object.assign(a, { name: d.name, details: d.details, propertyId: d.propertyId || '', openingBalance: num(d.openingBalance), openingDate: d.openingDate, notes: d.notes, owners });
      await save('accounts', a);
      closeSheet(); render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      if (S.txns.some((t) => t.accountId === a.id || t.toAccountId === a.id || (t.via?.t === 'a' && t.via.id === a.id))) return alert('This account has transactions and cannot be deleted.');
      if (!confirm('Delete account?')) return;
      await remove('accounts', a.id); closeSheet(); render();
    };
  };
  openSheet(id ? 'Edit account' : 'New common account', '', draw);
}

function tenantForm(id, onSaved) {
  const t = id ? { ...byId('tenants', id) } : { id: uid(), name: '' };
  const pending = [];
  const draw = () => {
    const d = $('#f') ? readForm($('#sheetBody')) : null;
    if (d) Object.assign(t, d);
    const b = $('#sheetBody');
    b.innerHTML = `<form class="form" id="f">
      ${field('Full name', inp('name', t.name, 'required'))}
      <div class="two">${field('Phone', inp('phone', t.phone, 'type="tel"'))}${field('Email', inp('email', t.email, 'type="email"'))}</div>
      ${field('ID / reference', inp('idRef', t.idRef, 'placeholder="ID document no., previous address…"'))}
      ${field('Emergency contact', inp('emergency', t.emergency))}
      ${field('Notes', `<textarea name="notes">${esc(t.notes || '')}</textarea>`)}
      ${attachBlock(id ? filesFor('tenant', id) : [], pending)}
      <button class="btn block">Save</button>
      ${id && S.tenants.length > 1 ? '<button type="button" class="btn sec block" id="merge" style="margin-top:8px">Merge into another tenant…</button>' : ''}
      ${id ? '<button type="button" class="btn danger block" id="del">Delete tenant</button>' : ''}
    </form>`;
    bindAttach(b, pending, draw);
    const mg = $('#merge', b);
    if (mg) mg.onclick = () => mergeForm('tenants', t.id);
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(t, readForm(b));
      if (!t.name) return toast('Name is required');
      const same = findByName('tenants', t.name, t.id);
      if (same && !confirm(`A tenant called “${same.name}” already exists${tenantWhere(same.id) ? ' (' + tenantWhere(same.id) + ')' : ''}.\n\nSave another tenant with the same name?`)) return;
      await save('tenants', t);
      await storeFiles(pending, { linkType: 'tenant', linkId: t.id });
      closeSheet();
      if (onSaved) onSaved(t); else render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      if (S.leases.some((l) => l.tenantId === t.id)) return alert('This tenant has leases. Delete them first.');
      if (!confirm('Delete tenant?')) return;
      for (const f of filesFor('tenant', t.id)) await remove('files', f.id);
      await remove('tenants', t.id); closeSheet(); location.hash = '#/rentals/tenants';
    };
  };
  openSheet(id ? 'Edit tenant' : 'New tenant', '', draw);
}

// Where a tenant rents: "Unit · Property" of their current (or latest) lease.
function tenantWhere(tenantId) {
  const ls = S.leases.filter((l) => l.tenantId === tenantId).sort((a, b) => (a.status === 'ended') - (b.status === 'ended') || b.startDate.localeCompare(a.startDate));
  return ls[0] ? `${unitName(ls[0].unitId)} · ${propName(byId('units', ls[0].unitId)?.propertyId)}${ls[0].status === 'ended' ? ' (past)' : ''}` : '';
}
const tenantPropertyIds = (tenantId) => new Set(S.leases.filter((l) => l.tenantId === tenantId).map((l) => byId('units', l.unitId)?.propertyId).filter(Boolean));

// Move every reference from one partner to another, then delete the first one.
async function mergePartners(fromId, toId) {
  const from = byId('partners', fromId), to = byId('partners', toId);
  const mergeOwners = (owners) => {
    const out = [];
    for (const o of owners || []) {
      const pid = o.partnerId === fromId ? toId : o.partnerId;
      const hit = out.find((x) => x.partnerId === pid);
      if (hit) hit.pct = r2(num(hit.pct) + num(o.pct)); else out.push({ ...o, partnerId: pid });
    }
    return out;
  };
  for (const store of ['properties', 'accounts']) {
    for (const x of S[store].filter((x) => x.owners?.some((o) => o.partnerId === fromId))) { x.owners = mergeOwners(x.owners); await save(store, x); }
  }
  for (const t of S.txns) {
    let ch = false;
    for (const k of ['partnerId', 'toPartnerId', 'handledBy']) if (t[k] === fromId) { t[k] = toId; ch = true; }
    if (t.via?.t === 'p' && t.via.id === fromId) { t.via = { t: 'p', id: toId }; ch = true; }
    if (t.split?.some((x) => x.partnerId === fromId)) { t.split = mergeOwners(t.split); ch = true; }
    if (ch) await save('txns', t);
  }
  if (from.isSelf) { to.isSelf = true; }
  for (const k of ['phone', 'email', 'notes']) if (!to[k] && from[k]) to[k] = from[k];
  await save('partners', to);
  await remove('partners', fromId);
}
async function mergeTenants(fromId, toId) {
  const from = byId('tenants', fromId), to = byId('tenants', toId);
  for (const l of S.leases.filter((l) => l.tenantId === fromId)) { l.tenantId = toId; await save('leases', l); }
  for (const f of S.files.filter((f) => f.linkType === 'tenant' && f.linkId === fromId)) { f.linkId = toId; await save('files', f); }
  for (const k of ['phone', 'email', 'idRef', 'emergency', 'notes']) if (!to[k] && from[k]) to[k] = from[k];
  await save('tenants', to);
  await remove('tenants', fromId);
}
function mergeForm(store, fromId, after) {
  const isP = store === 'partners';
  const from = byId(store, fromId);
  const others = S[store].filter((x) => x.id !== fromId).sort((a, b) => (normName(b.name) === normName(from.name)) - (normName(a.name) === normName(from.name)) || a.name.localeCompare(b.name));
  const label = (x) => x.name + (isP ? (x.isSelf ? ' (me)' : '') : (tenantWhere(x.id) ? ' — ' + tenantWhere(x.id) : ''));
  openSheet(isP ? 'Merge partner' : 'Merge tenant', `<form class="form" id="f">
    <div class="card pad" style="margin:0 0 12px">Merge <b>${esc(label(from))}</b> into another ${isP ? 'partner' : 'tenant'}. Everything recorded under ${esc(from.name)} (${isP ? 'property & account ownership, entries, splits' : 'leases and documents'}) moves to the one you choose, and this duplicate is removed.</div>
    ${field('Keep this one', `<select name="to">${others.map((x) => opt(x.id, label(x), others[0]?.id)).join('')}</select>`)}
    <button class="btn block">Merge</button>
  </form>`, (b) => {
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const toId = readForm(b).to;
      const to = byId(store, toId);
      if (!to) return;
      if (!confirm(`Merge “${from.name}” into “${to.name}”? This cannot be undone (make a backup first if unsure).`)) return;
      if (isP) await mergePartners(fromId, toId); else await mergeTenants(fromId, toId);
      closeSheet();
      toast('Merged');
      if (after) after(); else if (!isP && location.hash.includes(fromId)) location.hash = '#/tenant/' + toId; else render();
    };
  });
}

// Tenants for a lease picker: those at this property first, then new ones, then everyone else.
function tenantOptionsGrouped(sel, propertyId) {
  const sorted = [...S.tenants].sort((a, b) => a.name.localeCompare(b.name));
  const here = [], none = [], other = [];
  for (const t of sorted) {
    const props = tenantPropertyIds(t.id);
    (propertyId && props.has(propertyId) ? here : !props.size ? none : other).push(t);
  }
  const grp = (label, list, withWhere) => (list.length ? `<optgroup label="${esc(label)}">${list.map((t) => opt(t.id, t.name + (withWhere && tenantWhere(t.id) ? ' — ' + tenantWhere(t.id) : ''), sel)).join('')}</optgroup>` : '');
  return grp(propertyId ? 'At ' + propName(propertyId) : 'Tenants', here, false) + grp('Not renting yet', none, false) + grp(propertyId ? 'At other properties' : 'Renting', other, true);
}

function unitOptionsGrouped(sel) {
  return [...S.properties].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const us = S.units.filter((u) => u.propertyId === p.id);
    return us.length ? `<optgroup label="${esc(p.name)}">${us.map((u) => opt(u.id, `${u.name} — ${p.name}`, sel)).join('')}</optgroup>` : '';
  }).join('');
}

function leaseForm(id, preset = {}) {
  const l = id ? { ...byId('leases', id) } : { id: uid(), status: 'active', startDate: today(), dueDay: 1, ...preset };
  if (!id && l.unitId) {
    const u = byId('units', l.unitId);
    if (u && l.rent === undefined) l.rent = u.marketRent || '';
    if (u && l.deposit === undefined) l.deposit = u.defaultDeposit || '';
  }
  if (!S.units.length) return alert('Add a property with at least one unit first.');
  const pending = [];
  const draw = (skipRead) => {
    const b = $('#sheetBody');
    if ($('#f', b) && skipRead !== true) Object.assign(l, readForm(b));
    b.innerHTML = `<form class="form" id="f">
      ${field('Unit', `<select name="unitId" required>${opt('', 'Choose unit…', l.unitId)}${unitOptionsGrouped(l.unitId)}</select>`)}
      ${field('Tenant', `<select name="tenantId" id="tenantSel">${opt('', 'Choose tenant…', l.tenantId)}${tenantOptionsGrouped(l.tenantId, byId('units', l.unitId)?.propertyId)}${opt('__new', '+ New tenant…', '')}</select>`)}
      <div class="two">${field('Start date', inp('startDate', l.startDate, 'type="date" required'))}${field('End date (optional)', inp('endDate', l.endDate, 'type="date"'))}</div>
      <div class="two">${field('Monthly rent', moneyInput('rent', l.rent, 'required'))}${field('Rent due day', inp('dueDay', l.dueDay, 'type="number" min="1" max="31" inputmode="numeric"'))}</div>
      ${field('Security deposit (agreed)', moneyInput('deposit', l.deposit))}
      ${field('Balance adjustment', moneyInput('adjustment', l.adjustment), 'Optional. Positive = tenant owes extra (e.g. arrears carried over); negative = credit (e.g. prorated first month, waived rent).')}
      ${field('Notes / terms', `<textarea name="notes">${esc(l.notes || '')}</textarea>`)}
      ${attachBlock(id ? filesFor('lease', id) : [], pending)}
      <div class="hint">Attach the lease agreement, ID copies, move-in photos…</div>
      <button class="btn block">Save lease</button>
      ${id ? '<button type="button" class="btn danger block" id="del">Delete lease</button>' : ''}
    </form>`;
    bindAttach(b, pending, draw);
    $('#tenantSel', b).onchange = (e) => {
      if (e.target.value !== '__new') return;
      Object.assign(l, readForm(b));
      l.tenantId = '';
      const name = prompt('New tenant name');
      if (!name || !name.trim()) { draw(true); return; }
      const same = findByName('tenants', name);
      if (same && confirm(`“${same.name}” already exists${tenantWhere(same.id) ? ' (' + tenantWhere(same.id) + ')' : ''}.\n\nOK = use the existing tenant\nCancel = create a new tenant with the same name`)) { l.tenantId = same.id; draw(true); return; }
      const phone = prompt('Phone (optional)') || '';
      const t = { id: uid(), name: name.trim(), phone: phone.trim() };
      save('tenants', t).then(() => { l.tenantId = t.id; draw(true); });
    };
    $('[name=unitId]', b).onchange = (e) => {
      const u = byId('units', e.target.value);
      if (u?.propertyId !== byId('units', l.unitId)?.propertyId) { Object.assign(l, readForm(b)); if (u && !l.rent && u.marketRent) l.rent = u.marketRent; if (u && !l.deposit && u.defaultDeposit) l.deposit = u.defaultDeposit; draw(true); return; }
      l.unitId = e.target.value;
      if (u && !$('[name=rent]', b).value && u.marketRent) $('[name=rent]', b).value = u.marketRent;
      if (u && !$('[name=deposit]', b).value && u.defaultDeposit) $('[name=deposit]', b).value = u.defaultDeposit;
    };
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (!d.unitId) return toast('Choose a unit');
      if (!d.tenantId || d.tenantId === '__new') return toast('Choose a tenant');
      if (!d.startDate) return toast('Start date is required');
      if (d.endDate && d.endDate < d.startDate) return toast('End date is before start date');
      if (!(num(d.rent) >= 0)) return toast('Enter the rent');
      Object.assign(l, { unitId: d.unitId, tenantId: d.tenantId, startDate: d.startDate, endDate: d.endDate, rent: num(d.rent), dueDay: Math.min(31, Math.max(1, parseInt(d.dueDay, 10) || 1)), deposit: num(d.deposit), adjustment: num(d.adjustment), notes: d.notes });
      const clash = S.leases.find((x) => x.id !== l.id && x.unitId === l.unitId && x.status !== 'ended' && (!x.endDate || x.endDate >= l.startDate) && (!l.endDate || l.endDate >= x.startDate));
      if (clash && !confirm(`This unit already has an overlapping lease (${tenantName(clash.tenantId)}). Save anyway?`)) return;
      await save('leases', l);
      // keep linked transactions pointing at the right property/unit
      for (const t of S.txns.filter((t) => t.leaseId === l.id && t.unitId !== l.unitId)) {
        t.unitId = l.unitId; t.propertyId = byId('units', l.unitId)?.propertyId; await save('txns', t);
      }
      await storeFiles(pending, { linkType: 'lease', linkId: l.id, propertyId: byId('units', l.unitId)?.propertyId });
      closeSheet();
      if (!id) location.hash = '#/lease/' + l.id; else render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      const n = S.txns.filter((t) => t.leaseId === l.id).length;
      if (n) return alert(`This lease has ${n} transactions (rent/deposit). Delete them first, or use "End lease" instead.`);
      if (!confirm('Delete this lease?')) return;
      for (const f of filesFor('lease', l.id)) await remove('files', f.id);
      await remove('leases', l.id); closeSheet(); location.hash = '#/rentals/leases';
    };
  };
  openSheet(id ? 'Edit lease' : 'New lease', '', draw);
}

function endLeaseForm(id) {
  const l = byId('leases', id);
  const st = leaseStats(l);
  openSheet('End lease', `<form class="form" id="f">
    ${field('Move-out / end date', inp('endDate', l.endDate && l.endDate < today() ? l.endDate : today(), 'type="date" required'))}
    <div class="card pad" style="margin:0 0 12px">
      <div>Rent balance: <b class="${st.balance > 0 ? 'neg' : ''}">${money(st.balance)}</b></div>
      <div>Deposit held: <b>${money(st.depHeld)}</b></div>
      <div class="small muted" style="margin-top:6px">After ending, use "Keep deposit" for deductions (unpaid rent, damages) and "Refund deposit" for the amount returned.</div>
    </div>
    <button class="btn block">End lease</button>
  </form>`, (b) => {
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(b);
      if (d.endDate < l.startDate) return toast('End date is before start date');
      Object.assign(l, { endDate: d.endDate, status: 'ended' });
      await save('leases', l); closeSheet(); render();
    };
  });
}

// ---------------------------------------------------------------- transaction form
const VIA_KINDS = ['income', 'expense', 'deposit_in', 'deposit_out'];
const SPLIT_KINDS = ['income', 'expense', 'deposit_in', 'deposit_out', 'contribution', 'withdrawal'];
const LEASE_KINDS = ['deposit_in', 'deposit_out', 'deposit_apply'];
const NEW_ACCOUNT = '__new';
// Default for new entries: the property's own account, else the last shared account used, else a shared
// account, else a new account for this property. Paying/keeping money personally is never the default.
// Is this "paid from / received into" choice valid for an entry of this property?
function viaFits(v, propertyId) {
  if (!v || !v.id) return false;
  if (v.t === 'a') {
    if (v.id === NEW_ACCOUNT) { const { own, shared } = accountsFor(propertyId); return !own.length && !shared.length; }
    const a = byId('accounts', v.id);
    return !!a && (!a.propertyId || !propertyId || a.propertyId === propertyId);
  }
  return !!byId('partners', v.id) && partnersFor(propertyId).some((p) => p.id === v.id);
}
function defaultVia(kind, propertyId) {
  const dir = KINDS[kind]?.dir === 'out' ? 'out' : 'in';
  const { own, shared } = accountsFor(propertyId);
  if (own.length) return { t: 'a', id: own[0].id };
  const saved = parseVia(S.settings.lastVia?.[dir]);
  if (saved?.t === 'a' && saved.id !== NEW_ACCOUNT && viaFits(saved, propertyId)) return saved;
  if (shared.length) return { t: 'a', id: shared[0].id };
  if (S.partners.length > 1 || S.accounts.length) return { t: 'a', id: NEW_ACCOUNT };
  const me = selfPartner();
  const ps = partnersFor(propertyId);
  return { t: 'p', id: (ps.some((p) => p.id === me.id) ? me : ps[0] || me).id };
}
// Creates the common account chosen as "Common account (new)" in an entry.
async function createDefaultAccount(propertyId) {
  const p = byId('properties', propertyId);
  const a = { id: uid(), name: p ? p.name + ' account' : 'Common account', propertyId: p ? p.id : '', openingBalance: 0, openingDate: today(),
    owners: p?.owners?.length ? p.owners.map((o) => ({ ...o })) : S.partners.map((x) => ({ partnerId: x.id, pct: r2(100 / S.partners.length) })) };
  await save('accounts', a);
  return a;
}
// "Received into / Paid from" block: common account vs. a partner personally, plus who handled it.
function viaFields(t, k) {
  const out = KINDS[k].dir === 'out';
  const mode = t.via?.t === 'p' ? 'p' : 'a';
  const { own, shared, other } = accountsFor(t.propertyId);
  const accSel = mode === 'a' ? t.via?.id : '';
  const newOpt = opt(NEW_ACCOUNT, `${t.propertyId ? propName(t.propertyId) + ' account' : 'Common account'} (new — created when you save)`, accSel);
  const accOpts = (!own.length && !shared.length ? newOpt : '') + (S.accounts.length
    ? (own.length ? `<optgroup label="${esc(propName(t.propertyId))}">${own.map((a) => opt(a.id, a.name, accSel)).join('')}</optgroup>` : '') +
      (shared.length ? `<optgroup label="Shared accounts">${shared.map((a) => opt(a.id, a.name, accSel)).join('')}</optgroup>` : '') +
      (!t.propertyId && other.length ? `<optgroup label="Property accounts">${other.map((a) => opt(a.id, `${a.name} (${propName(a.propertyId)})`, accSel)).join('')}</optgroup>`
        : other.filter((a) => a.id === accSel).map((a) => opt(a.id, `${a.name} (${propName(a.propertyId)})`, accSel)).join(''))
    : '');
  const owners = ownerIds(t.propertyId);
  const people = partnersFor(t.propertyId, [mode === 'p' ? t.via?.id : '', t.handledBy]).map((p) => (owners.length && !owners.includes(p.id) ? { ...p, name: p.name + ' (not an owner)' } : p));
  const pSel = mode === 'p' ? t.via?.id : '';
  const whoName = pSel ? partnerName(pSel) : 'This partner';
  const shareWord = t.split?.length ? 'split' : 'ownership %';
  return `<div class="field"><span>${out ? 'Paid from' : 'Money went into'}</span>
      <div class="seg seg-in">
        <label class="${mode === 'a' ? 'on' : ''}"><input type="radio" name="viaMode" value="a" data-rr ${mode === 'a' ? 'checked' : ''}>Common / property account</label>
        <label class="${mode === 'p' ? 'on' : ''}"><input type="radio" name="viaMode" value="p" data-rr ${mode === 'p' ? 'checked' : ''}>A partner personally</label>
      </div></div>
    ${mode === 'a' ? `
      ${field('Account', `<select name="viaAcc" data-rr>${accOpts}</select>`)}
      ${field(out ? 'Paid / arranged by (optional)' : 'Collected by (optional)', `<select name="handledBy">${partnerOptions(t.handledBy, '—', people)}</select>`)}
      <div class="hint">${out ? 'Paid from the common money, so it is shared by the owners\' ' + shareWord + '. Nobody owes anyone for it.' : 'The money is in the common account, so it belongs to all owners by ' + shareWord + '. Nobody owes anyone for it — even if one partner collected it.'} If a partner later takes money out for personal use, record “Partner took money from common account”.</div>`
    : `
      ${field(out ? 'Which partner paid?' : 'Which partner kept the money?', `<select name="viaPartner" data-rr>${partnerOptions(pSel, 'Choose…', people)}</select>`)}
      <div class="hint">${out ? `${esc(whoName)} paid from their own pocket. The other owners owe ${pSel ? esc(whoName) : 'them'} their share.` : `${esc(whoName)} kept the money personally (not deposited in a common account). ${pSel ? esc(whoName) : 'They'} owe${pSel ? 's' : ''} the other owners their share.`}</div>`}`;
}
function sharesText(shares) {
  const ents = Object.entries(shares);
  if (!ents.length) return '—';
  return ents.map(([pid, f]) => `${esc(partnerName(pid))} ${r2(f * 100)}%`).join(' · ');
}

function applyLeaseDefaults(t) {
  const l = byId('leases', t.leaseId);
  if (!l) return;
  t.unitId = l.unitId; t.propertyId = byId('units', l.unitId)?.propertyId || '';
  const st = leaseStats(l);
  if (t.kind === 'income' && !t.category) t.category = 'Rent';
  if (!t.amount) {
    if (t.kind === 'income' && /rent/i.test(t.category || '')) t.amount = l.rent;
    if (t.kind === 'deposit_in') t.amount = Math.max(0, st.depPending) || '';
    if (t.kind === 'deposit_out') t.amount = Math.max(0, st.depHeld) || '';
  }
}

function txnForm(id, preset = {}) {
  const isNew = !id;
  const t = id ? JSON.parse(JSON.stringify(byId('txns', id))) : { id: uid(), kind: 'expense', date: today(), amount: '', ...preset };
  if (isNew && !t.category && KINDS[t.kind].cats.length === 1) t.category = KINDS[t.kind].cats[0];
  if (isNew && t.leaseId) applyLeaseDefaults(t);
  if (isNew && VIA_KINDS.includes(t.kind) && !viaFits(t.via, t.propertyId)) t.via = defaultVia(t.kind, t.propertyId);
  let custom = !!(t.split && t.split.length);
  const pending = [];

  const pull = (b) => {
    const d = readForm(b);
    if (!('kind' in d)) return;
    const prev = { kind: t.kind, propertyId: t.propertyId, unitId: t.unitId, leaseId: t.leaseId, accountId: t.accountId };
    t.kind = d.kind; t.date = d.date; t.amount = d.amount; t.category = d.category ?? t.category; t.description = d.description;
    if ('propertyId' in d) t.propertyId = d.propertyId || '';
    if ('unitId' in d) t.unitId = d.unitId || '';
    if ('leaseId' in d) t.leaseId = d.leaseId || '';
    if ('period' in d) t.period = d.period;
    const prevVia = t.via;
    if ('viaMode' in d) {
      if (d.viaMode === 'p') t.via = { t: 'p', id: d.viaPartner ?? (prevVia?.t === 'p' ? prevVia.id : '') };
      else t.via = { t: 'a', id: d.viaAcc ?? (prevVia?.t === 'a' ? prevVia.id : '') };
      if (d.viaMode !== (prevVia?.t || 'a')) {
        // switched between common account and partner: pick a sensible default on the new side
        if (d.viaMode === 'p') { const ps = partnersFor(t.propertyId); t.via.id = (ps.find((x) => x.id === t.handledBy) || ps.find((x) => x.isSelf) || ps[0])?.id || ''; }
        else { const dv = defaultVia(t.kind, t.propertyId); t.via.id = dv.t === 'a' ? dv.id : NEW_ACCOUNT; }
      }
    }
    if ('handledBy' in d) t.handledBy = d.handledBy;
    if ('partnerId' in d) t.partnerId = d.partnerId;
    if ('toPartnerId' in d) t.toPartnerId = d.toPartnerId;
    if ('accountId' in d) t.accountId = d.accountId;
    if ('toAccountId' in d) t.toAccountId = d.toAccountId;
    custom = !!d.customSplit;
    if (custom) t.split = S.partners.map((p) => ({ partnerId: p.id, pct: num(d['split_' + p.id]) })).filter((x) => x.pct > 0);
    // cascade linked fields
    if (t.kind !== prev.kind) {
      if (!KINDS[t.kind].cats.includes(t.category) && KINDS[prev.kind].cats.includes(t.category)) t.category = KINDS[t.kind].cats.length === 1 ? KINDS[t.kind].cats[0] : '';
      if (VIA_KINDS.includes(t.kind)) {
        const wasDir = KINDS[prev.kind].dir, nowDir = KINDS[t.kind].dir;
        if (!t.via || !t.via.id || (wasDir !== nowDir && t.via.t === 'a' && viaKey(t.via) === viaKey(defaultVia(prev.kind, t.propertyId)))) t.via = defaultVia(t.kind, t.propertyId);
      }
      if (t.kind === 'contribution' || t.kind === 'withdrawal') {
        if (!t.partnerId) t.partnerId = selfPartner().id;
        if (!t.accountId && S.accounts[0]) t.accountId = S.accounts[0].id;
      }
    }
    if (t.leaseId && t.leaseId !== prev.leaseId) {
      applyLeaseDefaults(t);
    } else if (t.unitId && t.unitId !== prev.unitId) {
      t.propertyId = byId('units', t.unitId)?.propertyId || t.propertyId;
      const l = byId('leases', t.leaseId);
      if (l && l.unitId !== t.unitId) t.leaseId = '';
      if (!t.leaseId) { const cl = currentLease(t.unitId); if (cl && (t.kind === 'income' || LEASE_KINDS.includes(t.kind))) t.leaseId = cl.id; }
    } else if (t.propertyId !== prev.propertyId) {
      const u = byId('units', t.unitId);
      if (u && u.propertyId !== t.propertyId) { t.unitId = ''; t.leaseId = ''; }
    }
    // An account that belongs to a property implies that property.
    const acc = t.via?.t === 'a' ? byId('accounts', t.via.id) : (t.kind === 'contribution' || t.kind === 'withdrawal') ? byId('accounts', t.accountId) : null;
    if (acc?.propertyId && !t.propertyId && (viaKey(t.via) !== viaKey(prevVia) || t.accountId !== prev.accountId || t.kind !== prev.kind)) t.propertyId = acc.propertyId;
    if (t.propertyId !== prev.propertyId) {
      // keep people & accounts consistent with the property that is now selected
      if (VIA_KINDS.includes(t.kind) && t.via && !viaFits(t.via, t.propertyId)) {
        if (t.via.t === 'a') t.via = defaultVia(t.kind, t.propertyId);
        else { const ps = partnersFor(t.propertyId); t.via = { t: 'p', id: (ps.find((x) => x.isSelf) || ps[0])?.id || '' }; }
      }
      const ids = new Set(partnersFor(t.propertyId).map((x) => x.id));
      if (t.handledBy && !ids.has(t.handledBy)) t.handledBy = '';
      if (custom && t.split) t.split = t.split.filter((x) => ids.has(x.partnerId));
    }
  };

  const draw = () => {
    const b = $('#sheetBody');
    if ($('#f', b)) pull(b);
    const k = t.kind;
    const needsLease = LEASE_KINDS.includes(k);
    const propScoped = VIA_KINDS.includes(k) || k === 'deposit_apply';
    const units = S.units.filter((u) => !t.propertyId || u.propertyId === t.propertyId);
    const leases = S.leases.filter((l) => (t.unitId ? l.unitId === t.unitId : !t.propertyId || units.some((u) => u.id === l.unitId)));
    const periodable = (k === 'income' || k === 'deposit_apply') && !!t.leaseId;
    const isRentCat = (c) => /rent/i.test(c || '');
    if (periodable && !t.period) t.period = (t.date || today()).slice(0, 7);
    const autoShares = sharesFor({ ...t, split: null });
    const kindHelp = {
      income: 'Money received (rent, fees…). Choose where it went — the common / property account, or a partner who kept it personally.',
      expense: 'Money spent for a property (mortgage, repairs, tax…). Choose who paid — the common / property account, or a partner from their own pocket. It is split between the owners.',
      deposit_in: 'Tenant paid a security deposit. It is tracked as owed back to the tenant.',
      deposit_out: 'Deposit returned to the tenant.',
      deposit_apply: 'Part of the deposit is kept (for unpaid rent, damages…). It becomes income; no money moves.',
      contribution: 'A partner puts their own money into a common account.',
      withdrawal: 'A partner takes money out of a common account for personal use or as profit share. It counts against that partner.',
      settlement: 'One partner pays another directly to settle up balances.',
      transfer: 'Move money between two common accounts.',
    }[k];
    b.innerHTML = `<form class="form" id="f">
      ${field('Type', `<select name="kind" data-rr>${Object.entries(KINDS).map(([key, v]) => opt(key, v.label, k)).join('')}</select>`)}
      <div class="hint">${kindHelp}</div>
      <div class="two">${field('Date', inp('date', t.date, 'type="date" required'))}${field('Amount', moneyInput('amount', t.amount, 'required placeholder="0.00"'))}</div>
      ${propScoped ? `
        ${field('Property', `<select name="propertyId" data-rr>${propertyOptions(t.propertyId, needsLease ? 'Choose…' : 'Not property-specific')}</select>`)}
        <div class="two">
          ${field('Unit', `<select name="unitId" data-rr>${opt('', units.length ? 'Whole property / none' : '—', t.unitId)}${units.map((u) => opt(u.id, u.name + (t.propertyId ? '' : ' — ' + propName(u.propertyId)), t.unitId)).join('')}</select>`)}
          ${field(needsLease ? 'Lease (required)' : 'Tenant / lease', `<select name="leaseId" data-rr>${opt('', leases.length ? 'None' : '—', t.leaseId)}${leases.map((l) => opt(l.id, leaseLabel(l), t.leaseId)).join('')}</select>`)}
        </div>` : ''}
      ${k === 'contribution' || k === 'withdrawal' ? `
        <div class="two">
          ${field('Partner', `<select name="partnerId">${partnerOptions(t.partnerId, 'Choose…', partnersFor(t.propertyId || byId('accounts', t.accountId)?.propertyId, [t.partnerId]))}</select>`)}
          ${field(k === 'contribution' ? 'Into account' : 'From account', `<select name="accountId" data-rr>${accountOptions(t.accountId, S.accounts.length ? 'Choose…' : 'No accounts yet — add one in More › Accounts')}</select>`)}
        </div>
        ${field('Property (optional)', `<select name="propertyId" data-rr>${propertyOptions(t.propertyId, 'Not property-specific')}</select>`, 'Set this if the money was for / from one property, so the right owners share it.')}` : ''}
      ${k === 'settlement' ? `
        <div class="two">
          ${field('Paid by', `<select name="partnerId">${partnerOptions(t.partnerId, 'Choose…', partnersFor(t.propertyId, [t.partnerId, t.toPartnerId]))}</select>`)}
          ${field('Paid to', `<select name="toPartnerId">${partnerOptions(t.toPartnerId, 'Choose…', partnersFor(t.propertyId, [t.partnerId, t.toPartnerId]))}</select>`)}
        </div>
        ${field('Property (optional)', `<select name="propertyId" data-rr>${propertyOptions(t.propertyId, 'Not property-specific')}</select>`, 'Choose the property this settles, so it clears that property\'s balances.')}` : ''}
      ${k === 'transfer' ? `
        <div class="two">
          ${field('From account', `<select name="accountId">${accountOptions(t.accountId, 'Choose…')}</select>`)}
          ${field('To account', `<select name="toAccountId">${accountOptions(t.toAccountId, 'Choose…')}</select>`)}
        </div>` : ''}
      ${field('Category', `<input name="category" list="cats" value="${esc(t.category || '')}" placeholder="Choose or type your own"><datalist id="cats">${KINDS[k].cats.map((c) => `<option value="${esc(c)}">`).join('')}${[...new Set(S.txns.filter((x) => x.kind === k).map((x) => x.category).filter((c) => c && !KINDS[k].cats.includes(c)))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`)}
      ${periodable ? `<div id="periodWrap"${isRentCat(t.category) ? '' : ' hidden'}>${field('Rent for month', inp('period', t.period, 'type="month"'))}</div>` : ''}
      ${VIA_KINDS.includes(k) ? viaFields(t, k) : ''}
      ${SPLIT_KINDS.includes(k) ? `
        <div class="card pad" style="margin:0 0 12px">
          <div class="small muted">Shared between</div>
          <div>${custom ? 'Custom split below' : sharesText(autoShares)}</div>
          <label class="check" style="margin:8px 0 0"><input type="checkbox" name="customSplit" data-rr ${custom ? 'checked' : ''}> Custom split for this entry</label>
          ${custom ? `<div class="split-grid" style="margin-top:10px">${partnersFor(t.propertyId, (t.split || []).map((x) => x.partnerId)).map((p) => {
            const cur = t.split?.find((s) => s.partnerId === p.id)?.pct ?? r2((autoShares[p.id] || 0) * 100);
            return `<span>${esc(p.name)}</span><input name="split_${p.id}" inputmode="decimal" value="${esc(cur || '')}" placeholder="%">`;
          }).join('')}</div><div class="hint" style="margin:0">Percentages; e.g. 100 for a single partner if this cost is only theirs.</div>` : ''}
        </div>` : ''}
      ${field('Description / reference', `<textarea name="description" placeholder="Invoice no., cheque no., details…">${esc(t.description || '')}</textarea>`)}
      ${attachBlock(isNew ? [] : filesFor('txn', t.id), pending)}
      <button class="btn block">${isNew ? 'Save' : 'Save changes'}</button>
      ${isNew ? '' : '<div class="btns" style="margin:10px 0 0"><button type="button" class="btn sec" id="dup">Duplicate</button><button type="button" class="btn danger" id="del">Delete</button></div>'}
    </form>`;
    $$('[data-rr]', b).forEach((el) => (el.onchange = draw));
    const pw = $('#periodWrap', b);
    if (pw) $('[name=category]', b).oninput = (e) => { pw.hidden = !isRentCat(e.target.value); };
    bindAttach(b, pending, draw);
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      pull(b);
      const amt = r2(num(t.amount));
      if (!(amt > 0)) return toast('Enter an amount greater than 0');
      if (!t.date) return toast('Enter a date');
      if (needsLease && !t.leaseId) return toast('Choose the lease this deposit belongs to');
      if (VIA_KINDS.includes(k) && !t.via?.id) return toast(t.via?.t === 'p' ? (KINDS[k].dir === 'out' ? 'Choose which partner paid' : 'Choose which partner kept the money') : 'Choose the account');
      if (VIA_KINDS.includes(k) && t.via.id !== NEW_ACCOUNT && !(t.via.t === 'a' ? byId('accounts', t.via.id) : byId('partners', t.via.id))) return toast('Choose the account or partner again');
      if ((k === 'contribution' || k === 'withdrawal') && (!t.partnerId || !t.accountId)) return toast('Choose the partner and the account');
      if (k === 'settlement' && (!t.partnerId || !t.toPartnerId || t.partnerId === t.toPartnerId)) return toast('Choose two different partners');
      if (k === 'transfer' && (!t.accountId || !t.toAccountId || t.accountId === t.toAccountId)) return toast('Choose two different accounts');
      if (custom && !(t.split && sum(t.split, (s) => s.pct) > 0)) return toast('Enter the custom split percentages');
      const out = { id: t.id, kind: k, date: t.date, amount: amt, category: t.category || '', description: t.description || '', createdAt: t.createdAt };
      if (propScoped || k === 'contribution' || k === 'withdrawal' || k === 'settlement') out.propertyId = t.propertyId || '';
      if (propScoped) { out.unitId = t.unitId || ''; out.leaseId = t.leaseId || ''; }
      if (periodable && isRentCat(t.category)) out.period = t.period || t.date.slice(0, 7);
      if (VIA_KINDS.includes(k)) {
        if (t.via.t === 'a' && t.via.id === NEW_ACCOUNT) { const a = await createDefaultAccount(out.propertyId); t.via = { t: 'a', id: a.id }; toast(`Created “${a.name}”`); }
        out.via = { t: t.via.t, id: t.via.id };
        if (t.via.t === 'a' && t.handledBy) out.handledBy = t.handledBy;
      }
      if (k === 'deposit_apply') { const src = S.txns.find((x) => x.leaseId === t.leaseId && x.kind === 'deposit_in'); if (src) out.via = src.via; }
      if (k === 'contribution' || k === 'withdrawal' || k === 'settlement') out.partnerId = t.partnerId;
      if (k === 'settlement') out.toPartnerId = t.toPartnerId;
      if (k === 'contribution' || k === 'withdrawal' || k === 'transfer') out.accountId = t.accountId;
      if (k === 'transfer') out.toAccountId = t.toAccountId;
      if (custom && SPLIT_KINDS.includes(k)) out.split = t.split;
      await save('txns', out);
      await storeFiles(pending, { linkType: 'txn', linkId: out.id, propertyId: out.propertyId });
      if (VIA_KINDS.includes(k)) { S.settings.lastVia = { ...(S.settings.lastVia || {}), [KINDS[k].dir]: viaKey(out.via) }; saveSettings(); }
      closeSheet();
      toast('Saved');
      render();
    };
    const del = $('#del', b);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this transaction and its attachments?')) return;
      for (const f of filesFor('txn', t.id)) await remove('files', f.id);
      await remove('txns', t.id);
      closeSheet(); render();
    };
    const dup = $('#dup', b);
    if (dup) dup.onclick = () => {
      const src = byId('txns', t.id);
      const copy = JSON.parse(JSON.stringify(src));
      delete copy.id; delete copy.createdAt; delete copy.updatedAt;
      copy.date = today();
      if (copy.period) copy.period = thisMonth();
      closeSheet();
      txnForm(null, copy);
    };
  };
  openSheet(isNew ? 'New entry' : 'Edit entry', '', draw);
}

// ---------------------------------------------------------------- view helpers
function txnRow(t) {
  const s = txnSigned(t);
  const nFiles = S.files.filter((f) => f.linkType === 'txn' && f.linkId === t.id).length;
  const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'muted';
  return `<div class="row nav" data-act="txn" data-id="${t.id}">
    <div class="grow"><div class="t">${esc(txnTitle(t))}${nFiles ? ` <span class="chip">📎${nFiles}</span>` : ''}</div><div class="s">${esc(fmtDate(t.date))} · ${esc(txnSubtitle(t))}</div>${t.description ? `<div class="d">${esc(t.description)}</div>` : ''}</div>
    <div class="r amt ${cls}">${s ? money(s, true) : money(t.amount)}</div></div>`;
}
function txnList(txns, limit) {
  const sorted = [...txns].sort((a, b) => (b.date + (b.createdAt || '')).localeCompare(a.date + (a.createdAt || '')));
  const shown = limit ? sorted.slice(0, limit) : sorted;
  if (!shown.length) return '<div class="list"><div class="empty">No transactions yet</div></div>';
  return `<div class="list">${shown.map(txnRow).join('')}</div>`;
}
function rentStatus(l, ym) {
  const paid = paidForPeriod(l, ym);
  const rent = Number(l.rent) || 0;
  const due = dueDate(l, ym);
  if (rent > 0 && paid >= rent - 0.005) return { paid, chip: '<span class="chip ok">Paid</span>', state: 'paid' };
  if (paid > 0) return { paid, chip: '<span class="chip warn">Partial</span>', state: 'partial' };
  if (due && due < today()) return { paid, chip: '<span class="chip bad">Overdue</span>', state: 'overdue' };
  if (due && due === today()) return { paid, chip: '<span class="chip warn">Due today</span>', state: 'due' };
  return { paid, chip: '<span class="chip">Upcoming</span>', state: 'upcoming' };
}
function rentRollRows(ym, propertyId) {
  const rows = S.leases.filter((l) => dueDate(l, ym) && (!propertyId || byId('units', l.unitId)?.propertyId === propertyId)).map((l) => ({ l, st: rentStatus(l, ym) }));
  const order = { overdue: 0, due: 1, partial: 2, upcoming: 3, paid: 4 };
  rows.sort((a, b) => order[a.st.state] - order[b.st.state] || propName(byId('units', a.l.unitId)?.propertyId).localeCompare(propName(byId('units', b.l.unitId)?.propertyId)));
  return rows;
}
function rentRollHtml(ym, propertyId) {
  const rows = rentRollRows(ym, propertyId);
  if (!rows.length) return '<div class="list"><div class="empty">No rent due this month</div></div>';
  return `<div class="list">${rows.map(({ l, st }) => {
    const u = byId('units', l.unitId);
    return `<div class="row">
      <a class="grow" href="#/lease/${l.id}" style="color:inherit"><div class="t">${esc(tenantName(l.tenantId))} ${st.chip}</div><div class="s">${esc(u?.name || '')} · ${esc(propName(u?.propertyId))} · due ${esc(fmtDate(dueDate(l, ym)))}</div></a>
      <div class="r"><div class="amt">${money(st.paid)}</div><div class="s small muted">of ${money(l.rent)}</div></div>
      ${st.state !== 'paid' ? `<button class="btn sm" data-act="rent" data-id="${l.id}" data-period="${ym}">Record</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}
function daysSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity; }
function backupBanner() {
  const hasData = S.properties.length || S.txns.length;
  const st = S.settings;
  if (!hasData) return '';
  const wait = { changes: 0, daily: 1, weekly: 7 }[st.backupReminder || 'daily'] ?? 1;
  if (st.lastBackupAt && (!st.lastChangeAt || st.lastChangeAt <= st.lastBackupAt || daysSince(st.lastBackupAt) < wait)) return '';
  const days = Math.floor(daysSince(st.lastBackupAt));
  const msg = !st.lastBackupAt ? 'You have not made a backup yet.' : `You have changes since your last backup (${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}).`;
  return `<div class="banner"><div class="grow">${msg} Your data lives only on this iPhone — save a backup to Files/iCloud.</div><button class="btn sm" data-act="backup">Back up now</button></div>`;
}

// ---------------------------------------------------------------- views
const V = {};

V.home = () => {
  const ym = thisMonth();
  const y = today().slice(0, 4);
  const rows = rentRollRows(ym);
  const expected = sum(rows, (r) => r.l.rent);
  const collected = sum(rows, (r) => Math.min(r.st.paid, r.l.rent));
  const allStats = S.leases.map(leaseStats);
  const outstanding = sum(allStats, (s) => Math.max(0, s.balance));
  const depHeld = sum(allStats, (s) => s.depHeld);
  const occupied = S.units.filter((u) => { const l = currentLease(u.id); return l && leaseIsActiveOn(l, today()); }).length;
  const yt = S.txns.filter((t) => t.date.startsWith(y));
  const net = r2(sum(yt.filter((t) => t.kind === 'income' || t.kind === 'deposit_apply'), (t) => t.amount) - sum(yt.filter((t) => t.kind === 'expense'), (t) => t.amount));
  const cash = sum(S.accounts, (a) => accountBalance(a.id));
  if (!S.properties.length) {
    return {
      title: 'Estate Ledger',
      html: `${backupBanner()}<div class="card pad" style="margin-top:14px">
        <h3 style="margin:0 0 6px">Welcome 👋</h3>
        <p class="muted" style="margin:0 0 12px">Track properties, units, tenants, rent, deposits and partner expenses — fully offline. Everything is stored only on this device.</p>
        <ol class="small" style="padding-left:18px;margin:0 0 12px">
          <li>Add partners (if you co-own) in <b>More › Partners</b>. You are already added as “Me”.</li>
          <li>Add a common/joint account in <b>More › Accounts</b> (optional).</li>
          <li>Add a property with its units and ownership %.</li>
          <li>Create leases for tenants, then record rent, deposits & expenses.</li>
        </ol>
        <div class="btns" style="margin:0"><button class="btn" data-act="newProperty">Add first property</button><a class="btn sec" href="#/help">Install on iPhone</a></div>
      </div>
      <div class="card pad"><h3 style="margin:0 0 6px">Already have data?</h3>
        <p class="muted small" style="margin:0 0 12px">If you cleared Safari data, reinstalled the app or got a new iPhone, restore your latest backup .zip from Files / iCloud Drive.</p>
        <input type="file" id="welcomeRestore" accept=".zip,application/zip" hidden>
        <button class="btn block" id="welcomeRestoreBtn">Restore from backup…</button></div>`,
      bind(main) {
        $('#welcomeRestoreBtn', main).onclick = () => $('#welcomeRestore', main).click();
        $('#welcomeRestore', main).onchange = (e) => e.target.files[0] && restoreBackup(e.target.files[0]);
      },
    };
  }
  return {
    title: 'Estate Ledger',
    actions: [{ label: 'Back up', act: 'backup' }],
    html: `${backupBanner()}${(() => { const n = dataIssues().length; return n ? `<a class="banner" href="#/check"><div class="grow">${n} thing${n === 1 ? '' : 's'} to review — duplicate names or partners used outside their property.</div><span class="btn sm">Review</span></a>` : ''; })()}
      <div class="stats">
        <div class="stat"><div class="k">Rent ${esc(monthLabel(ym))}</div><div class="v">${money(collected)}</div><div class="x">of ${money(expected)} expected</div></div>
        <div class="stat"><div class="k">Outstanding rent</div><div class="v ${outstanding > 0 ? 'neg' : ''}">${money(outstanding)}</div><div class="x">all leases</div></div>
        <div class="stat"><div class="k">Occupancy</div><div class="v">${occupied}/${S.units.length}</div><div class="x">${S.properties.length} properties</div></div>
        <div class="stat"><div class="k">Deposits held</div><div class="v">${money(depHeld)}</div><div class="x">owed to tenants</div></div>
        <div class="stat"><div class="k">Net ${y}</div><div class="v ${net < 0 ? 'neg' : 'pos'}">${money(net)}</div><div class="x">income − expenses</div></div>
        <div class="stat"><div class="k">Common accounts</div><div class="v">${money(cash)}</div><div class="x">${S.accounts.length} account(s)</div></div>
      </div>
      <h2>Rent this month <a class="h-act" href="#/rentals">All</a></h2>
      ${rentRollHtml(ym)}
      <h2>Recent transactions <a class="h-act" href="#/ledger">Ledger</a></h2>
      ${txnList(S.txns, 8)}`,
  };
};

V.properties = () => ({
  title: 'Properties',
  actions: [{ label: '+ Add', act: 'newProperty' }],
  html: S.properties.length ? `<div class="list" style="margin-top:12px">${[...S.properties].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const st = propertyStats(p);
    return `<a class="row" href="#/property/${p.id}"><div class="grow"><div class="t">${esc(p.name)}</div>
      <div class="s">${esc(p.address || p.type || '')}</div>
      <div class="s">${st.occupied}/${st.units} occupied · ${(p.owners || []).map((o) => `${esc(partnerName(o.partnerId))} ${o.pct}%`).join(', ')}</div></div>
      ${st.outstanding > 0 ? `<div class="r"><span class="chip bad">${money(st.outstanding)} due</span></div>` : ''}</a>`;
  }).join('')}</div>` : `<div class="empty">No properties yet.<br><br><button class="btn" data-act="newProperty">Add property</button></div>`,
});

V.property = (id) => {
  const p = byId('properties', id);
  if (!p) return { title: 'Not found', html: '<div class="empty">Property not found</div>', back: '#/properties' };
  const y = today().slice(0, 4);
  const st = propertyStats(p, y);
  const units = S.units.filter((u) => u.propertyId === id);
  const tx = S.txns.filter((t) => t.propertyId === id);
  const { pos } = partnerPositions(tx);
  const plan = settlePlan(pos);
  const owners = ownerIds(id);
  const balIds = [...owners, ...Object.keys(pos).filter((pid) => !owners.includes(pid) && Math.abs(pos[pid]) > 0.005)];
  const outsiders = balIds.filter((pid) => !owners.includes(pid));
  const accs = S.accounts.filter((a) => a.propertyId === id);
  const nTenants = S.tenants.filter((t) => tenantPropertyIds(t.id).has(id)).length;
  return {
    title: p.name, back: '#/properties',
    actions: [{ label: 'Edit', act: 'editProperty', id }],
    html: `<div class="card pad" style="margin-top:12px">
        ${p.address ? `<div>${esc(p.address)}</div>` : ''}
        <div class="small muted">${esc(p.type || '')}${p.purchaseDate ? ' · bought ' + fmtDate(p.purchaseDate) : ''}${p.purchasePrice ? ' for ' + money(p.purchasePrice) : ''}${p.currentValue ? ' · value ' + money(p.currentValue) : ''}</div>
        <div style="margin-top:6px">${(p.owners || []).map((o) => `<span class="chip">${esc(partnerName(o.partnerId))} ${o.pct}%</span>`).join('')}</div>
        ${p.notes ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(p.notes)}</div>` : ''}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Income ${y}</div><div class="v pos">${money(st.income)}</div></div>
        <div class="stat"><div class="k">Expenses ${y}</div><div class="v neg">${money(st.expense)}</div></div>
        <div class="stat"><div class="k">Net ${y}</div><div class="v">${money(st.net)}</div></div>
        <div class="stat"><div class="k">Rent outstanding</div><div class="v ${st.outstanding > 0 ? 'neg' : ''}">${money(st.outstanding)}</div><div class="x">Deposits held ${money(st.depHeld)}</div></div>
      </div>
      <div class="btns"><button class="btn" data-act="newTxn" data-kind="income" data-property-id="${id}">+ Income</button><button class="btn" data-act="newTxn" data-kind="expense" data-property-id="${id}">+ Expense</button></div>
      <h2>Units (${units.length}) <a class="h-act" href="javascript:void 0" data-act="newUnit" data-id="${id}">+ Unit</a></h2>
      ${units.length ? `<div class="list">${units.map((u) => {
        const l = currentLease(u.id);
        const active = l && leaseIsActiveOn(l, today());
        return `<a class="row" href="#/unit/${u.id}"><div class="grow"><div class="t">${esc(u.name)} ${active ? '<span class="chip ok">Occupied</span>' : l ? '<span class="chip warn">Upcoming lease</span>' : '<span class="chip">Vacant</span>'}</div>
          <div class="s">${l ? esc(tenantName(l.tenantId)) + ' · ' + money(l.rent) + '/mo' : esc([u.layout, u.size].filter(Boolean).join(' · ') || 'No tenant')}</div></div>
          ${l && leaseStats(l).balance > 0 ? `<span class="chip bad">${money(leaseStats(l).balance)} due</span>` : ''}</a>`;
      }).join('')}</div>` : '<div class="list"><div class="empty">No units</div></div>'}
      <div class="btns"><a class="btn sec" href="#/rentals/tenants?p=${id}">Tenants (${nTenants})</a><a class="btn sec" href="#/rentals/leases?p=${id}">Leases</a></div>
      <h2>Common account${accs.length === 1 ? '' : 's'} <a class="h-act" href="javascript:void 0" data-act="newAccount" data-property-id="${id}">+ Account</a></h2>
      ${accs.length ? `<div class="list">${accs.map((a) => `<a class="row" href="#/ledger?v=a:${a.id}"><div class="grow"><div class="t">${esc(a.name)}</div><div class="s">${esc(a.details || 'Rent in, mortgage & expenses out')}</div></div><div class="r amt">${money(accountBalance(a.id))}</div></a>`).join('')}</div>`
        : `<div class="list"><div class="empty small">No account for this property yet. Add one (e.g. the bank account rent goes into and the mortgage is paid from), so its income and expenses are shared by the owners automatically.</div></div>`}
      ${owners.length > 1 || balIds.length > 1 ? `
        <h2>Partner balances (this property) <a class="h-act" href="#/partners?p=${id}">Details</a></h2>
        <div class="list">${balIds.map((pid) => { const v = pos[pid] || 0; return `<div class="row"><div class="grow">${esc(partnerName(pid))}${owners.includes(pid) ? '' : ' <span class="chip warn-owner">not an owner</span>'}</div><div class="r amt ${v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : ''}">${v > 0.005 ? 'is owed ' + money(v) : v < -0.005 ? 'owes ' + money(-v) : 'settled ✓'}</div></div>`; }).join('')}
        ${outsiders.length ? `<a class="row small" href="#/ledger?p=${id}&amp;v=p:${outsiders[0]}"><div class="grow warn">${esc(outsiders.map(partnerName).join(', '))} ${outsiders.length > 1 ? 'are' : 'is'} not an owner of this property but appear${outsiders.length > 1 ? '' : 's'} in its entries. Tap to review them.</div></a>` : ''}
        ${plan.map((x) => `<div class="row small"><div class="grow">➜ ${esc(partnerName(x.from))} pays ${esc(partnerName(x.to))}</div><div class="amt">${money(x.amount)}</div></div>`).join('')}</div>` : ''}
      <h2>Transactions <a class="h-act" href="#/ledger?p=${id}">All ${tx.length}</a></h2>
      ${txnList(tx, 10)}
      <h2>Documents <a class="h-act" href="javascript:void 0" data-act="uploadDoc" data-link-type="property" data-id="${id}">+ Upload</a></h2>
      ${docsList(filesFor('property', id).concat(S.files.filter((f) => f.linkType === 'general' && f.propertyId === id)))}`,
  };
};

function docsList(files) {
  if (!files.length) return '<div class="list"><div class="empty">No documents</div></div>';
  return `<div class="card pad"><div class="thumbs" style="margin:0">${files.map((f) => thumbHtml(f, false)).join('')}</div></div>`;
}

V.unit = (id) => {
  const u = byId('units', id);
  if (!u) return { title: 'Not found', html: '<div class="empty">Unit not found</div>', back: '#/properties' };
  const leases = S.leases.filter((l) => l.unitId === id).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const cur = currentLease(id);
  return {
    title: u.name, back: '#/property/' + u.propertyId,
    actions: [{ label: 'Edit', act: 'editUnit', id }],
    html: `<div class="card pad" style="margin-top:12px"><div class="t">${esc(propName(u.propertyId))}</div>
        <div class="small muted">${esc([u.layout, u.size].filter(Boolean).join(' · '))}${u.marketRent ? ' · typical rent ' + money(u.marketRent) : ''}${u.defaultDeposit ? ' · deposit ' + money(u.defaultDeposit) : ''}</div>
        ${u.notes ? `<div class="small" style="white-space:pre-wrap;margin-top:6px">${esc(u.notes)}</div>` : ''}</div>
      <div class="btns">${cur ? `<a class="btn" href="#/lease/${cur.id}">Current lease</a>` : ''}<button class="btn ${cur ? 'sec' : ''}" data-act="newLease" data-unit-id="${id}">+ New lease</button><button class="btn sec" data-act="newTxn" data-kind="expense" data-property-id="${u.propertyId}" data-unit-id="${id}">+ Expense</button></div>
      <h2>Leases</h2>
      ${leases.length ? `<div class="list">${leases.map((l) => `<a class="row" href="#/lease/${l.id}"><div class="grow"><div class="t">${esc(tenantName(l.tenantId))} ${l.status === 'ended' ? '<span class="chip">Ended</span>' : leaseIsActiveOn(l, today()) ? '<span class="chip ok">Active</span>' : '<span class="chip warn">Upcoming</span>'}</div><div class="s">${fmtDate(l.startDate)} – ${l.endDate ? fmtDate(l.endDate) : 'open'} · ${money(l.rent)}/mo</div></div></a>`).join('')}</div>` : '<div class="list"><div class="empty">No leases yet</div></div>'}
      <h2>Transactions</h2>
      ${txnList(S.txns.filter((t) => t.unitId === id), 20)}`,
  };
};

const leaseProp = (l) => byId('units', l.unitId)?.propertyId;
V.rentals = (sub, q) => {
  const tab = sub || 'roll';
  const pf = q.get('p') || '';
  const keep = (extra = '') => { const nq = new URLSearchParams(extra); if (pf) nq.set('p', pf); const s = nq.toString(); return s ? '?' + s : ''; };
  const seg = `<div class="seg">${[['roll', 'Rent roll'], ['leases', 'Leases'], ['tenants', 'Tenants']].map(([k, l]) => `<button data-act="go" data-href="#/rentals/${k}${keep()}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${S.properties.length > 1 ? `<div class="filters"><select id="rpf">${propertyOptions(pf, 'All properties')}</select></div>` : ''}`;
  const bind = (main) => { const el = $('#rpf', main); if (el) el.onchange = (e) => { const nq = new URLSearchParams(q); if (e.target.value) nq.set('p', e.target.value); else nq.delete('p'); location.hash = `#/rentals/${tab}?${nq}`; }; };
  const inProp = (l) => !pf || leaseProp(l) === pf;
  if (tab === 'leases') {
    const show = q.get('s') || 'active';
    const list = S.leases.filter((l) => inProp(l) && (show === 'ended' ? l.status === 'ended' : l.status !== 'ended')).sort((a, b) => propName(leaseProp(a)).localeCompare(propName(leaseProp(b))) || leaseLabel(a).localeCompare(leaseLabel(b)));
    return {
      title: 'Rentals', actions: [{ label: '+ Lease', act: 'newLease' }], bind,
      html: `${seg}<div class="seg">${[['active', 'Active'], ['ended', 'Ended']].map(([k, l]) => `<button data-act="go" data-href="#/rentals/leases${keep('s=' + k)}" class="${show === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${list.length ? `<div class="list">${list.map((l) => {
          const st = leaseStats(l); const u = byId('units', l.unitId);
          return `<a class="row" href="#/lease/${l.id}"><div class="grow"><div class="t">${esc(tenantName(l.tenantId))}</div><div class="s">${esc(u?.name || '')} · ${esc(propName(u?.propertyId))} · ${money(l.rent)}/mo</div><div class="s">${fmtDate(l.startDate)} – ${l.endDate ? fmtDate(l.endDate) : 'open'}</div></div>
            <div class="r">${st.balance > 0.005 ? `<span class="chip bad">${money(st.balance)} due</span>` : st.balance < -0.005 ? `<span class="chip ok">${money(-st.balance)} credit</span>` : '<span class="chip ok">Up to date</span>'}${st.depHeld ? `<div class="s small muted">Dep. ${money(st.depHeld)}</div>` : ''}</div></a>`;
        }).join('')}</div>` : '<div class="empty">No leases</div>'}`,
    };
  }
  if (tab === 'tenants') {
    const tenantRow = (t, propId) => {
      const ls = S.leases.filter((l) => l.tenantId === t.id && (!propId || leaseProp(l) === propId));
      const act = ls.find((l) => l.status !== 'ended');
      return `<a class="row" href="#/tenant/${t.id}"><div class="grow"><div class="t">${esc(t.name)}</div><div class="s">${esc([t.phone || t.email, act ? unitName(act.unitId) : ls.length ? 'past tenant' : ''].filter(Boolean).join(' · '))}</div></div></a>`;
    };
    const sorted = [...S.tenants].sort((a, b) => a.name.localeCompare(b.name));
    const groups = [];
    for (const p of [...S.properties].sort((a, b) => a.name.localeCompare(b.name))) {
      if (pf && p.id !== pf) continue;
      const list = sorted.filter((t) => tenantPropertyIds(t.id).has(p.id));
      if (list.length) groups.push([p.name, list.map((t) => tenantRow(t, p.id))]);
    }
    const noLease = sorted.filter((t) => !tenantPropertyIds(t.id).size);
    if (noLease.length && !pf) groups.push(['No lease yet', noLease.map((t) => tenantRow(t))]);
    return {
      title: 'Rentals', actions: [{ label: '+ Tenant', act: 'newTenant' }], bind,
      html: `${seg}${groups.length ? groups.map(([h, rows]) => `<h2>${esc(h)} (${rows.length})</h2><div class="list">${rows.join('')}</div>`).join('') : '<div class="empty">No tenants</div>'}`,
    };
  }
  const ym = q.get('m') || thisMonth();
  const rows = rentRollRows(ym, pf);
  const expected = sum(rows, (r) => r.l.rent);
  const collected = sum(rows, (r) => r.st.paid);
  return {
    title: 'Rentals', actions: [{ label: '+ Lease', act: 'newLease' }], bind,
    html: `${seg}
      <div class="card pad" style="display:flex;align-items:center;gap:8px">
        <a class="btn sec sm" href="#/rentals/roll${keep('m=' + addMonths(ym, -1))}">‹</a>
        <div style="flex:1;text-align:center"><div style="font-weight:600">${esc(monthLabel(ym))}</div><div class="small muted">${money(collected)} collected of ${money(expected)}</div></div>
        <a class="btn sec sm" href="#/rentals/roll${keep('m=' + addMonths(ym, 1))}">›</a>
      </div>
      ${rentRollHtml(ym, pf)}`,
  };
};

V.lease = (id) => {
  const l = byId('leases', id);
  if (!l) return { title: 'Not found', html: '<div class="empty">Lease not found</div>', back: '#/rentals/leases' };
  const u = byId('units', l.unitId);
  const st = leaseStats(l);
  const tx = S.txns.filter((t) => t.leaseId === id);
  const months = [...st.months];
  const cm = thisMonth();
  if (!months.includes(cm) && dueDate(l, cm)) months.push(cm);
  const periodsPaid = [...new Set(tx.filter(isRentPayment).map((t) => t.period || t.date.slice(0, 7)))].filter((m) => !months.includes(m));
  const allMonths = [...months, ...periodsPaid].sort().reverse();
  const P = { 'data-property-id': u?.propertyId, 'data-unit-id': l.unitId, 'data-lease-id': id };
  const attrs = Object.entries(P).map(([k, v]) => `${k}="${esc(v || '')}"`).join(' ');
  return {
    title: tenantName(l.tenantId) || 'Lease', back: '#/rentals/leases',
    actions: [{ label: 'Edit', act: 'editLease', id }],
    html: `<div class="card pad" style="margin-top:12px">
        <div class="t"><a href="#/tenant/${l.tenantId}">${esc(tenantName(l.tenantId))}</a> ${l.status === 'ended' ? '<span class="chip">Ended</span>' : leaseIsActiveOn(l, today()) ? '<span class="chip ok">Active</span>' : '<span class="chip warn">Upcoming</span>'}</div>
        <div class="small"><a href="#/unit/${l.unitId}">${esc(u?.name || '')}</a> · <a href="#/property/${u?.propertyId}">${esc(propName(u?.propertyId))}</a></div>
        <div class="small muted">${fmtDate(l.startDate)} – ${l.endDate ? fmtDate(l.endDate) : 'open-ended'} · ${money(l.rent)}/month, due on day ${l.dueDay}</div>
        ${l.adjustment ? `<div class="small muted">Balance adjustment: ${money(l.adjustment)}</div>` : ''}
        ${l.notes ? `<div class="small" style="white-space:pre-wrap;margin-top:6px">${esc(l.notes)}</div>` : ''}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Rent balance</div><div class="v ${st.balance > 0.005 ? 'neg' : 'pos'}">${st.balance < -0.005 ? money(-st.balance) + ' cr' : money(st.balance)}</div><div class="x">${money(st.rentPaid)} paid of ${money(st.rentDue)}</div></div>
        <div class="stat"><div class="k">Deposit held</div><div class="v">${money(st.depHeld)}</div><div class="x">${st.depPending > 0.005 ? money(st.depPending) + ' still to collect' : 'agreed ' + money(l.deposit || 0)}</div></div>
      </div>
      <div class="btns">
        <button class="btn" data-act="rent" data-id="${id}" data-period="${cm}">+ Rent payment</button>
        <button class="btn sec" data-act="newTxn" data-kind="income" data-category="" ${attrs}>+ Other income</button>
      </div>
      <div class="btns">
        <button class="btn sec" data-act="newTxn" data-kind="deposit_in" data-category="Security deposit" ${attrs}>Deposit received</button>
        <button class="btn sec" data-act="newTxn" data-kind="deposit_apply" data-category="Damages" ${attrs}>Keep deposit</button>
        <button class="btn sec" data-act="newTxn" data-kind="deposit_out" data-category="Deposit refund" ${attrs}>Refund deposit</button>
        ${l.status !== 'ended' ? `<button class="btn sec" data-act="endLease" data-id="${id}">End lease</button>` : `<button class="btn sec" data-act="reopenLease" data-id="${id}">Reopen lease</button>`}
      </div>
      <h2>Month by month</h2>
      <div class="card scroll-x"><table class="t"><thead><tr><th>Month</th><th class="n">Rent</th><th class="n">Paid</th><th></th></tr></thead><tbody>
        ${allMonths.map((m) => { const s = rentStatus(l, m); const due = dueDate(l, m);
          return `<tr><td>${esc(monthLabel(m))}</td><td class="n">${due ? money(l.rent) : '—'}</td><td class="n">${money(s.paid)}</td><td>${due ? s.chip : '<span class="chip">Extra</span>'}${s.state !== 'paid' && due ? ` <button class="btn sm sec" data-act="rent" data-id="${id}" data-period="${m}">Record</button>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="4" class="muted">No months due yet</td></tr>'}
      </tbody></table></div>
      <h2>Transactions</h2>
      ${txnList(tx)}
      <h2>Documents <a class="h-act" href="javascript:void 0" data-act="uploadDoc" data-link-type="lease" data-id="${id}">+ Upload</a></h2>
      ${docsList(filesFor('lease', id))}`,
  };
};

V.tenant = (id) => {
  const t = byId('tenants', id);
  if (!t) return { title: 'Not found', html: '<div class="empty">Tenant not found</div>', back: '#/rentals/tenants' };
  const ls = S.leases.filter((l) => l.tenantId === id);
  return {
    title: t.name, back: '#/rentals/tenants',
    actions: [{ label: 'Edit', act: 'editTenant', id }],
    html: `<div class="card pad" style="margin-top:12px">
        ${tenantWhere(id) ? `<div class="small muted">${esc(tenantWhere(id))}</div>` : ''}
        ${t.phone ? `<div>📞 <a href="tel:${esc(t.phone.replace(/[^+\d]/g, ''))}">${esc(t.phone)}</a> · <a href="sms:${esc(t.phone.replace(/[^+\d]/g, ''))}">SMS</a></div>` : ''}
        ${t.email ? `<div>✉️ <a href="mailto:${esc(t.email)}">${esc(t.email)}</a></div>` : ''}
        ${t.idRef ? `<div class="small muted">ID: ${esc(t.idRef)}</div>` : ''}
        ${t.emergency ? `<div class="small muted">Emergency: ${esc(t.emergency)}</div>` : ''}
        ${t.notes ? `<div class="small" style="white-space:pre-wrap;margin-top:6px">${esc(t.notes)}</div>` : ''}
      </div>
      <div class="btns"><button class="btn" data-act="newLease" data-tenant-id="${id}">+ New lease</button></div>
      <h2>Leases</h2>
      ${ls.length ? `<div class="list">${ls.map((l) => { const st = leaseStats(l); return `<a class="row" href="#/lease/${l.id}"><div class="grow"><div class="t">${esc(unitName(l.unitId))} · ${esc(propName(byId('units', l.unitId)?.propertyId))}</div><div class="s">${fmtDate(l.startDate)} – ${l.endDate ? fmtDate(l.endDate) : 'open'} · ${money(l.rent)}/mo</div></div>${st.balance > 0.005 ? `<span class="chip bad">${money(st.balance)} due</span>` : ''}</a>`; }).join('')}</div>` : '<div class="list"><div class="empty">No leases</div></div>'}
      <h2>Documents</h2>
      ${docsList(filesFor('tenant', id))}`,
  };
};

// ---------------------------------------------------------------- ledger
function ledgerFilter(q) {
  const p = q.get('p') || '', k = q.get('k') || '', v = q.get('v') || '', per = q.get('per') || 'all', s = (q.get('q') || '').toLowerCase(), imp = q.get('imp') || '';
  let from = '', to = '';
  const d = today(), y = d.slice(0, 4), m = d.slice(0, 7);
  if (per === 'm') { from = m + '-01'; to = m + '-31'; }
  else if (per === 'lm') { const lm = addMonths(m, -1); from = lm + '-01'; to = lm + '-31'; }
  else if (per === 'y') { from = y + '-01-01'; to = y + '-12-31'; }
  else if (per === 'ly') { from = (y - 1) + '-01-01'; to = (y - 1) + '-12-31'; }
  else if (per === 'custom') { from = q.get('from') || ''; to = q.get('to') || ''; }
  const vv = parseVia(v);
  const list = S.txns.filter((t) => {
    if (p && t.propertyId !== p) return false;
    if (imp && t.importId !== imp) return false;
    if (k === 'in' && KINDS[t.kind].dir !== 'in') return false;
    if (k === 'out' && KINDS[t.kind].dir !== 'out') return false;
    if (k === 'partner' && !['contribution', 'withdrawal', 'settlement'].includes(t.kind)) return false;
    if (k && KINDS[k] && t.kind !== k) return false;
    if (vv) {
      const hit = vv.t === 'a' ? (viaKey(t.via) === v || t.accountId === vv.id || t.toAccountId === vv.id)
        : (viaKey(t.via) === v || t.partnerId === vv.id || t.toPartnerId === vv.id || t.handledBy === vv.id || (t.split || []).some((x) => x.partnerId === vv.id));
      if (!hit) return false;
    }
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (s && !(`${txnTitle(t)} ${txnSubtitle(t)} ${t.description || ''} ${t.amount}`.toLowerCase().includes(s))) return false;
    return true;
  });
  return { list, p, k, v, per, from, to, s };
}
V.ledger = (sub, q) => {
  const f = ledgerFilter(q);
  const inc = sum(f.list.filter((t) => KINDS[t.kind].dir === 'in'), (t) => t.amount);
  const out = sum(f.list.filter((t) => KINDS[t.kind].dir === 'out'), (t) => t.amount);
  const groups = {};
  [...f.list].sort((a, b) => (b.date + (b.createdAt || '')).localeCompare(a.date + (a.createdAt || ''))).forEach((t) => (groups[t.date] = groups[t.date] || []).push(t));
  return {
    title: 'Ledger',
    actions: [{ label: 'Export', act: 'exportLedger' }],
    html: `<div class="filters">
        <select data-q="p">${propertyOptions(f.p, 'All properties')}</select>
        <select data-q="k">${opt('', 'All types', f.k)}${opt('in', 'Money in', f.k)}${opt('out', 'Money out', f.k)}${opt('partner', 'Partner money', f.k)}${Object.entries(KINDS).map(([key, v]) => opt(key, v.short, f.k)).join('')}</select>
        <select data-q="v">${opt('', 'All accounts & partners', f.v)}${viaOptions(f.v)}</select>
        <select data-q="per">${opt('all', 'All dates', f.per)}${opt('m', 'This month', f.per)}${opt('lm', 'Last month', f.per)}${opt('y', 'This year', f.per)}${opt('ly', 'Last year', f.per)}${opt('custom', 'Custom dates…', f.per)}</select>
        ${f.per === 'custom' ? `<div class="date-range"><label>From<input type="date" data-date="from" value="${esc(f.from)}"></label><label>To<input type="date" data-date="to" value="${esc(f.to)}"></label><button type="button" class="btn sm" id="applyDates">Apply</button></div>` : ''}
        <input type="search" data-q="q" value="${esc(f.s)}" placeholder="Search">
      </div>
      <div class="stats" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat"><div class="k">In</div><div class="v pos" style="font-size:16px">${money(inc)}</div></div>
        <div class="stat"><div class="k">Out</div><div class="v neg" style="font-size:16px">${money(out)}</div></div>
        <div class="stat"><div class="k">Net</div><div class="v" style="font-size:16px">${money(inc - out)}</div></div>
      </div>
      ${f.list.length ? Object.entries(groups).map(([d, ts]) => `<div class="date-head">${esc(fmtDate(d))}</div><div class="list">${ts.map(txnRow).join('')}</div>`).join('') : '<div class="empty">No transactions match</div>'}`,
    bind(main) {
      // Date pickers: iOS fires "change" on every turn of the wheel, so only apply when the picker is done
      // (focus leaves both date fields) or when Apply is tapped — never re-render while one is open.
      const dates = $$('[data-date]', main);
      const applyDates = () => {
        const nq = new URLSearchParams(location.hash.split('?')[1] || '');
        let from = dates[0].value, to = dates[1].value;
        if (from && to && from > to) [from, to] = [to, from];
        for (const [k, v] of [['from', from], ['to', to]]) if (v) nq.set(k, v); else nq.delete(k);
        const h = '#/ledger?' + nq.toString();
        if (h !== location.hash) { history.replaceState(null, '', h); render(); }
      };
      dates.forEach((el) => el.addEventListener('blur', () => setTimeout(() => { if (!dates.includes(document.activeElement) && $('#applyDates')) applyDates(); }, 150)));
      const ab = $('#applyDates', main);
      if (ab) ab.onclick = applyDates;
      $$('[data-q]', main).forEach((el) => {
        const ev = el.type === 'search' ? 'input' : 'change';
        el.addEventListener(ev, () => {
          const nq = new URLSearchParams(q);
          if (el.value) nq.set(el.dataset.q, el.value); else nq.delete(el.dataset.q);
          if (el.dataset.q === 'per' && el.value === 'custom' && !nq.get('from') && !nq.get('to')) { nq.set('from', thisMonth() + '-01'); nq.set('to', today()); }
          history.replaceState(null, '', '#/ledger?' + nq.toString());
          if (el.type === 'search') { clearTimeout(V._st); V._st = setTimeout(() => { render(); const s = $('[data-q=q]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 350); }
          else render();
        });
      });
    },
  };
};

// ---------------------------------------------------------------- partners
V.partners = (sub, q) => {
  const p = q.get('p') || '';
  const tx = p ? S.txns.filter((t) => t.propertyId === p) : S.txns;
  const { pos, br } = partnerPositions(tx);
  const plan = settlePlan(pos);
  const owners = ownerIds(p);
  const ids = S.partners.map((x) => x.id).filter((id) => (p ? owners.includes(id) || Math.abs(pos[id] || 0) > 0.005 : pos[id] !== undefined || br[id]));
  const owns = (pid) => S.properties.filter((x) => x.owners?.some((o) => o.partnerId === pid)).map((x) => `${x.name} ${sum(x.owners.filter((o) => o.partnerId === pid), (o) => num(o.pct))}%`);
  const shown = p ? S.partners.filter((x) => owners.includes(x.id)) : S.partners;
  const rows = [
    ['Paid expenses personally', 'paidPersonally'], ['Received income personally', 'receivedPersonally'],
    ['Put into common account', 'contributed'], ['Took from common account', 'withdrawn'],
    ['Settlements paid', 'settledPaid'], ['Settlements received', 'settledReceived'],
    ['Share of income &amp; deposits in', 'shareIncome'], ['Share of expenses &amp; refunds', 'shareExpense'],
  ];
  return {
    title: 'Partners', back: '#/more',
    actions: [{ label: '+ Partner', act: 'newPartner' }],
    html: `<div class="filters"><select id="pf">${propertyOptions(p, 'All properties')}</select></div>
      <h2>Who owes whom</h2>
      <div class="list">${ids.length ? ids.map((id) => { const v = pos[id] || 0; return `<div class="row"><div class="grow"><div class="t">${esc(partnerName(id))}${p && !owners.includes(id) ? ' <span class="chip warn-owner">not an owner</span>' : ''}</div></div><div class="r amt ${v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : ''}">${v > 0.005 ? 'is owed ' + money(v) : v < -0.005 ? 'owes ' + money(-v) : 'settled ✓'}</div></div>`; }).join('') : '<div class="empty">No partner activity yet</div>'}</div>
      ${plan.length ? `<h2>Suggested settlement</h2><div class="list">${plan.map((x) => `<div class="row"><div class="grow">${esc(partnerName(x.from))} → ${esc(partnerName(x.to))}</div><div class="amt">${money(x.amount)}</div><button class="btn sm" data-act="newTxn" data-kind="settlement" data-partner-id="${x.from}" data-to-partner-id="${x.to}" data-amount="${x.amount}" data-property-id="${p}">Record</button></div>`).join('')}</div>` : ''}
      <div class="hint" style="margin:8px 16px">Balances compare what each partner actually paid, received, put in or took out against their ownership share. “Is owed” means the others should pay this partner. Record a settlement (or a contribution/withdrawal) to square up.</div>
      ${ids.length ? `<h2>Breakdown</h2><div class="card scroll-x"><table class="t"><thead><tr><th></th>${ids.map((id) => `<th class="n">${esc(partnerName(id))}</th>`).join('')}</tr></thead><tbody>
        ${rows.map(([label, key]) => `<tr><td>${label}</td>${ids.map((id) => `<td class="n">${money(br[id]?.[key] || 0)}</td>`).join('')}</tr>`).join('')}
        <tr class="tot"><td>Net position</td>${ids.map((id) => `<td class="n ${pos[id] > 0.005 ? 'pos' : pos[id] < -0.005 ? 'neg' : ''}">${money(pos[id] || 0, true)}</td>`).join('')}</tr>
      </tbody></table></div>` : ''}
      <h2>${p ? 'Owners of ' + esc(propName(p)) : 'All partners'}</h2>
      <div class="list">${shown.map((x) => `<div class="row nav" data-act="editPartner" data-id="${x.id}"><div class="grow"><div class="t">${esc(x.name)}${x.isSelf ? ' <span class="chip">me</span>' : ''}${S.partners.some((y) => y.id !== x.id && normName(y.name) === normName(x.name)) ? ' <span class="chip warn-owner">duplicate name</span>' : ''}</div><div class="s">${esc(owns(x.id).join(' · ') || 'Owns no property')}${x.phone || x.email ? ' · ' + esc([x.phone, x.email].filter(Boolean).join(' · ')) : ''}</div></div></div>`).join('') || '<div class="empty">No owners set</div>'}</div>
      <div class="btns"><a class="btn sec" href="#/ledger?k=partner${p ? '&p=' + p : ''}">Partner transactions</a></div>`,
    bind(main) {
      $('#pf', main).onchange = (e) => { location.hash = '#/partners' + (e.target.value ? '?p=' + e.target.value : ''); };
    },
  };
};

V.accounts = () => ({
  title: 'Accounts', back: '#/more',
  actions: [{ label: '+ Account', act: 'newAccount' }],
  html: `<div class="hint" style="margin:14px 16px 8px">Common accounts are shared money pots: a joint bank account, a property's rent account, or a cash box. Partners' personal money is not an account — choose the partner instead when recording.</div>
    ${S.accounts.length ? `<div class="list">${S.accounts.map((a) => { const bal = accountBalance(a.id); return `<div class="row"><div class="grow" data-act="editAccount" data-id="${a.id}"><div class="t">${esc(a.name)}</div><div class="s">${esc([a.propertyId ? propName(a.propertyId) : 'Shared', a.details].filter(Boolean).join(' · '))} · ${(a.owners || []).map((o) => esc(partnerName(o.partnerId)) + ' ' + o.pct + '%').join(', ')}</div></div><div class="r amt ${bal < 0 ? 'neg' : ''}">${money(bal)}</div><a class="btn sm sec" href="#/ledger?v=a:${a.id}">Ledger</a></div>`; }).join('')}</div>` : '<div class="empty">No accounts yet</div>'}
    <div class="btns"><button class="btn sec" data-act="newTxn" data-kind="contribution">Partner puts money in</button><button class="btn sec" data-act="newTxn" data-kind="withdrawal">Partner takes money out</button><button class="btn sec" data-act="newTxn" data-kind="transfer">Transfer</button></div>`,
});

V.documents = (sub, q) => {
  const p = q.get('p') || '';
  const list = S.files.filter((f) => !p || f.propertyId === p || (f.linkType === 'property' && f.linkId === p)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const total = sum(S.files, (f) => f.size);
  return {
    title: 'Documents', back: '#/more',
    actions: [{ label: '+ Upload', act: 'uploadDoc', linkType: 'general' }],
    html: `<div class="filters"><select id="df">${propertyOptions(p, 'All properties')}</select></div>
      <div class="small muted" style="margin:0 16px 8px">${S.files.length} files · ${fmtSize(total)}</div>
      ${list.length ? `<div class="list">${list.map((f) => `<div class="row nav" data-view-file="${f.id}">
        <div style="width:44px;height:44px;flex-shrink:0;border-radius:6px;overflow:hidden;background:var(--chip);display:flex;align-items:center;justify-content:center;font-size:10px">${/^image\//.test(f.type) ? `<img data-thumb="${f.id}" style="width:100%;height:100%;object-fit:cover" alt="">` : esc((f.name.split('.').pop() || '').toUpperCase())}</div>
        <div class="grow"><div class="t">${esc(f.name)}</div><div class="s">${esc(fileLinkLabel(f))}</div><div class="s">${fmtDate((f.createdAt || '').slice(0, 10))} · ${fmtSize(f.size)}${f.note ? ' · ' + esc(f.note) : ''}</div></div></div>`).join('')}</div>` : '<div class="empty">No documents. Upload bank statements, screenshots, receipts, agreements…</div>'}`,
    bind(main) { $('#df', main).onchange = (e) => { location.hash = '#/documents' + (e.target.value ? '?p=' + e.target.value : ''); }; },
  };
};

function uploadDocForm(linkType, linkId) {
  const pending = [];
  let meta = { propertyId: linkType === 'property' ? linkId : linkType === 'lease' ? byId('units', byId('leases', linkId)?.unitId)?.propertyId : '', note: '' };
  const draw = () => {
    const b = $('#sheetBody');
    if ($('#f', b)) meta = { ...meta, ...readForm(b) };
    b.innerHTML = `<form class="form" id="f">
      ${linkType === 'general' ? field('Property (optional)', `<select name="propertyId">${propertyOptions(meta.propertyId, 'Not property-specific')}</select>`) : `<div class="card pad" style="margin:0 0 12px">${esc(linkType === 'property' ? 'Property: ' + propName(linkId) : linkType === 'lease' ? 'Lease: ' + leaseLabel(byId('leases', linkId)) : '')}</div>`}
      ${field('Note (optional)', inp('note', meta.note, 'placeholder="e.g. HDFC statement Aug 2026"'))}
      ${attachBlock([], pending)}
      <button class="btn block">Upload ${pending.length || ''} file${pending.length === 1 ? '' : 's'}</button>
    </form>`;
    bindAttach(b, pending, draw);
    $('#f', b).onsubmit = async (e) => {
      e.preventDefault();
      if (!pending.length) return toast('Choose at least one file');
      const d = readForm(b);
      toast('Saving…');
      await storeFiles(pending, { linkType, linkId: linkType === 'general' ? null : linkId, propertyId: d.propertyId || meta.propertyId || null, note: d.note });
      closeSheet(); toast('Uploaded'); render();
    };
  };
  openSheet('Upload documents', '', draw);
}

// ---------------------------------------------------------------- reports
function plData(year, propertyId) {
  const tx = S.txns.filter((t) => t.date.startsWith(year) && (!propertyId || t.propertyId === propertyId));
  const inc = {}, exp = {}, monthly = {};
  for (let i = 1; i <= 12; i++) monthly[`${year}-${pad2(i)}`] = { inc: 0, exp: 0 };
  for (const t of tx) {
    const m = t.date.slice(0, 7);
    if (t.kind === 'income' || t.kind === 'deposit_apply') {
      const c = (t.kind === 'deposit_apply' ? 'Deposit kept: ' : '') + (t.category || 'Other income');
      inc[c] = r2((inc[c] || 0) + t.amount); monthly[m].inc += t.amount;
    } else if (t.kind === 'expense') {
      const c = t.category || 'Other expense';
      exp[c] = r2((exp[c] || 0) + t.amount); monthly[m].exp += t.amount;
    }
  }
  const shares = {};
  for (const t of tx) {
    const sign = t.kind === 'income' || t.kind === 'deposit_apply' ? 1 : t.kind === 'expense' ? -1 : 0;
    if (!sign) continue;
    for (const [pid, f] of Object.entries(sharesFor(t))) shares[pid] = r2((shares[pid] || 0) + sign * t.amount * f);
  }
  const totalInc = sum(Object.values(inc)), totalExp = sum(Object.values(exp));
  return { inc, exp, monthly, shares, totalInc, totalExp, net: r2(totalInc - totalExp) };
}
V.reports = (sub, q) => {
  const years = [...new Set(S.txns.map((t) => t.date.slice(0, 4)).concat(today().slice(0, 4)))].sort().reverse();
  const y = q.get('y') || years[0];
  const p = q.get('p') || '';
  const d = plData(y, p);
  const catTable = (obj, cls) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="n ${cls}">${money(v)}</td></tr>`).join('') || '<tr><td class="muted" colspan="2">None</td></tr>';
  return {
    title: 'Reports', back: '#/more',
    actions: [{ label: 'Export', act: 'exportAll' }],
    html: `<div class="filters"><select id="ry">${years.map((x) => opt(x, x, y)).join('')}</select><select id="rp">${propertyOptions(p, 'All properties')}</select></div>
      <div class="stats" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat"><div class="k">Income</div><div class="v pos" style="font-size:16px">${money(d.totalInc)}</div></div>
        <div class="stat"><div class="k">Expenses</div><div class="v neg" style="font-size:16px">${money(d.totalExp)}</div></div>
        <div class="stat"><div class="k">Net</div><div class="v" style="font-size:16px">${money(d.net)}</div></div>
      </div>
      <h2>Income by category</h2><div class="card"><table class="t"><tbody>${catTable(d.inc, 'pos')}<tr class="tot"><td>Total</td><td class="n">${money(d.totalInc)}</td></tr></tbody></table></div>
      <h2>Expenses by category</h2><div class="card"><table class="t"><tbody>${catTable(d.exp, 'neg')}<tr class="tot"><td>Total</td><td class="n">${money(d.totalExp)}</td></tr></tbody></table></div>
      <h2>Each partner's share of net profit</h2><div class="card"><table class="t"><tbody>${Object.entries(d.shares).map(([pid, v]) => `<tr><td>${esc(partnerName(pid))}</td><td class="n ${v < 0 ? 'neg' : ''}">${money(v)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table></div>
      <h2>By month</h2><div class="card scroll-x"><table class="t"><thead><tr><th>Month</th><th class="n">Income</th><th class="n">Expenses</th><th class="n">Net</th></tr></thead><tbody>
        ${Object.entries(d.monthly).map(([m, v]) => `<tr><td>${esc(monthLabel(m))}</td><td class="n">${money(v.inc)}</td><td class="n">${money(v.exp)}</td><td class="n ${v.inc - v.exp < 0 ? 'neg' : ''}">${money(v.inc - v.exp)}</td></tr>`).join('')}
      </tbody></table></div>`,
    bind(main) {
      const go = () => { location.hash = `#/reports?y=${$('#ry', main).value}${$('#rp', main).value ? '&p=' + $('#rp', main).value : ''}`; };
      $('#ry', main).onchange = go; $('#rp', main).onchange = go;
    },
  };
};

// ---------------------------------------------------------------- data check
// Partner ids an entry refers to (who paid/received, who is split, who handled it).
function txnPartnerRefs(t) {
  const ids = [t.partnerId, t.toPartnerId, t.via?.t === 'p' ? t.via.id : '', t.via?.t === 'a' ? t.handledBy : '', ...(t.split || []).map((x) => x.partnerId)];
  return [...new Set(ids.filter(Boolean))];
}
function dataIssues() {
  const out = [];
  const dupGroups = (store) => {
    const g = {};
    for (const x of S[store]) (g[normName(x.name)] = g[normName(x.name)] || []).push(x);
    return Object.values(g).filter((l) => l.length > 1);
  };
  for (const grp of dupGroups('partners')) {
    out.push({ kind: 'dup', title: `Partner “${grp[0].name}” exists ${grp.length} times`,
      copies: grp.map((x) => {
        const n = S.txns.filter((t) => txnPartnerRefs(t).includes(x.id)).length;
        const owns = S.properties.filter((p) => p.owners?.some((o) => o.partnerId === x.id)).map((p) => p.name).join(', ');
        return { id: x.id, store: 'partners', mergeable: !x.isSelf, text: `${x.name}${x.isSelf ? ' (me)' : ''} — ${owns ? 'owns ' + owns : 'owns no property'} · ${plural(n, 'entry', 'entries')}` };
      }) });
  }
  for (const grp of dupGroups('tenants')) {
    out.push({ kind: 'dup', title: `Tenant “${grp[0].name}” exists ${grp.length} times`,
      copies: grp.map((x) => ({ id: x.id, store: 'tenants', mergeable: true, text: `${x.name} — ${tenantWhere(x.id) || 'no lease'}${x.phone ? ' · ' + x.phone : ''}` })) });
  }
  for (const p of S.properties) {
    const dup = duplicateOwners(p.owners || []);
    if (dup.length) out.push({ kind: 'dupOwner', title: `${p.name}: ${dup.join(', ')} listed as owner more than once`, detail: 'The rows will be combined into one (their % added together).', btns: `<button class="btn sm" data-act="fixOwners" data-id="${p.id}">Combine</button>` });
    const tot = r2(sum(p.owners || [], (o) => num(o.pct)));
    if ((p.owners || []).length && tot !== 100) out.push({ kind: 'pct', title: `${p.name}: ownership adds up to ${tot}%`, detail: 'Shares are scaled to 100% when splitting, but you may want to correct the %.', btns: `<button class="btn sm sec" data-act="editProperty" data-id="${p.id}">Edit property</button>` });
    const own = ownerIds(p.id);
    if (!own.length) continue;
    const odd = S.txns.filter((t) => t.propertyId === p.id && txnPartnerRefs(t).some((pid) => !own.includes(pid)));
    if (odd.length) {
      const who = [...new Set(odd.flatMap((t) => txnPartnerRefs(t).filter((pid) => !own.includes(pid))))].map(partnerName);
      out.push({ kind: 'outsider', title: `${p.name}: ${odd.length} entr${odd.length === 1 ? 'y uses' : 'ies use'} ${who.join(', ')}, who ${who.length > 1 ? 'are' : 'is'} not an owner`,
        detail: 'Open each entry and choose an owner of this property (or the common account), unless this was intended.',
        list: odd.sort((a, b) => b.date.localeCompare(a.date)) });
    }
  }
  return out;
}
V.check = () => {
  const issues = dataIssues();
  return {
    title: 'Data check', back: '#/more',
    html: `<div class="hint" style="margin:14px 16px 8px">Looks for duplicate names, owners listed twice, and entries that use a partner who does not own that property.</div>
      ${issues.length ? issues.map((x) => `<div class="card pad"><div class="t" style="font-weight:600">${esc(x.title)}</div>${x.detail ? `<div class="small muted" style="margin-top:4px">${esc(x.detail)}</div>` : ''}${x.btns ? `<div class="btns" style="margin:10px 0 0">${x.btns}</div>` : ''}</div>
        ${x.copies ? `<div class="list">${x.copies.map((c) => `<div class="row"><div class="grow"><div class="s" style="white-space:normal;color:var(--text)">${esc(c.text)}</div></div>${c.mergeable ? `<button class="btn sm sec" data-act="merge" data-store="${c.store}" data-id="${c.id}">Merge into…</button>` : '<span class="chip">keep</span>'}</div>`).join('')}</div>` : ''}
        ${x.list ? txnList(x.list, 50) : ''}`).join('')
        : '<div class="card pad" style="text-align:center">✓ No problems found</div>'}`,
  };
};

// ---------------------------------------------------------------- more / data / settings / help
V.more = () => ({
  title: 'More',
  html: `<h2>Manage</h2><div class="list">
      <a class="row" href="#/partners"><div class="grow"><div class="t">👥 Partners &amp; balances</div><div class="s">Who owes whom, settlements</div></div></a>
      <a class="row" href="#/accounts"><div class="grow"><div class="t">🏦 Common accounts</div><div class="s">Joint bank accounts, cash</div></div></a>
      <a class="row" href="#/rentals/tenants"><div class="grow"><div class="t">🧑 Tenants</div></div></a>
      <a class="row" href="#/documents"><div class="grow"><div class="t">📎 Documents</div><div class="s">Statements, screenshots, receipts</div></div></a>
      <a class="row" href="#/reports"><div class="grow"><div class="t">📊 Reports</div><div class="s">Profit &amp; loss by year and property</div></div></a>
      <a class="row" href="#/import"><div class="grow"><div class="t">📥 Import transactions</div><div class="s">Bulk-add past entries from Excel / CSV</div></div></a>
      <a class="row" href="#/check"><div class="grow"><div class="t">🩺 Data check</div><div class="s">${(() => { const n = dataIssues().length; return n ? `${n} thing${n === 1 ? '' : 's'} to review` : 'Duplicates, owners, mixed-up partners'; })()}</div></div></a>
    </div>
    <h2>Data</h2><div class="list">
      <a class="row" href="#/data"><div class="grow"><div class="t">💾 Excel export, backup &amp; restore</div><div class="s">${S.settings.lastBackupAt ? 'Last backup ' + fmtDate(S.settings.lastBackupAt.slice(0, 10)) : 'No backup yet'}</div></div></a>
      <a class="row" href="#/settings"><div class="grow"><div class="t">⚙️ Settings</div></div></a>
      <a class="row" href="#/help"><div class="grow"><div class="t">❓ Help &amp; install on iPhone</div></div></a>
    </div>`,
});

V.data = () => ({
  title: 'Export & backup', back: '#/more',
  html: `<h2>Excel</h2>
    <div class="card pad"><div class="small muted" style="margin-bottom:10px">One .xlsx workbook with sheets for summary, properties, units, tenants, leases, the full ledger (with each partner's split), partner balances, accounts, rent roll and yearly P&amp;L. Opens in Excel, Numbers and Google Sheets.</div>
      <button class="btn block" data-act="exportAll">Export everything to Excel</button></div>
    <h2>Import</h2>
    <div class="card pad"><div class="small muted" style="margin-bottom:10px">Add many past transactions at once from an Excel template with dropdown lists, or from your own spreadsheet / bank export (CSV).</div>
      <a class="btn sec block" href="#/import">Import transactions…</a></div>
    <h2>Backup</h2>
    <div class="card pad"><div class="small muted" style="margin-bottom:10px">A backup is a single .zip with all your data and uploaded documents. Save it to Files / iCloud Drive, or send it to yourself. You can restore it on this or another iPhone/computer.</div>
      <button class="btn block" data-act="backup">Create full backup (with documents)</button>
      <button class="btn sec block" style="margin-top:8px" data-act="backupLite">Backup without documents (smaller)</button>
      <div class="small muted" style="margin-top:10px">Last backup: ${S.settings.lastBackupAt ? fmtDate(S.settings.lastBackupAt.slice(0, 10)) : 'never'}</div></div>
    <h2>Restore</h2>
    <div class="card pad"><div class="small muted" style="margin-bottom:10px">Replaces everything in the app with the contents of a backup file.</div>
      <input type="file" id="restoreFile" accept=".zip,application/zip" hidden>
      <button class="btn sec block" id="restoreBtn">Restore from backup…</button></div>
    <h2>Storage</h2>
    <div class="card pad small" id="storageInfo">Checking…</div>`,
  async bind(main) {
    $('#restoreBtn', main).onclick = () => $('#restoreFile', main).click();
    $('#restoreFile', main).onchange = (e) => e.target.files[0] && restoreBackup(e.target.files[0]);
    let txt = `${S.properties.length} properties · ${S.units.length} units · ${S.leases.length} leases · ${S.txns.length} transactions · ${S.files.length} files`;
    try {
      if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); txt += `<br>Using ${fmtSize(est.usage || 0)} of about ${fmtSize(est.quota || 0)} available.`; }
      if (navigator.storage?.persisted) txt += `<br>Persistent storage: ${(await navigator.storage.persisted()) ? 'yes ✓' : 'not granted (add the app to your Home Screen to protect data)'}`;
    } catch { /* ignore */ }
    const el = $('#storageInfo', main); if (el) el.innerHTML = txt;
  },
});

const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'AED', 'SAR', 'QAR', 'SGD', 'HKD', 'JPY', 'CNY', 'CHF', 'ZAR', 'KES', 'NGN', 'MXN', 'BRL', 'PKR', 'BDT', 'LKR', 'NPR', 'MYR', 'PHP', 'IDR', 'THB'];
V.settings = () => ({
  title: 'Settings', back: '#/more',
  html: `<form class="form card pad" id="sf" style="margin-top:12px">
      ${field('Currency', `<select name="currency">${[...new Set([S.settings.currency, ...CURRENCIES])].map((c) => opt(c, c, S.settings.currency)).join('')}</select>`)}
      ${field('Your name (shown instead of “Me”)', inp('myName', selfPartner()?.name))}
      ${field('Backup reminder', `<select name="backupReminder">${opt('changes', 'Every time there are unsaved changes', S.settings.backupReminder || 'daily')}${opt('daily', 'Daily, if something changed', S.settings.backupReminder || 'daily')}${opt('weekly', 'Weekly, if something changed', S.settings.backupReminder || 'daily')}</select>`)}
      <label class="check"><input type="checkbox" name="compressPhotos" ${S.settings.compressPhotos ? 'checked' : ''}> Shrink large photos when uploading (saves space)</label>
      <button class="btn block">Save settings</button>
    </form>
    <h2>Danger zone</h2>
    <div class="card pad"><button class="btn danger block" data-act="eraseAll">Erase all data on this device</button></div>
    <div class="small muted" style="margin:16px;text-align:center">Estate Ledger · works offline · your data never leaves this device unless you export it.</div>`,
  bind(main) {
    $('#sf', main).onsubmit = async (e) => {
      e.preventDefault();
      const d = readForm(main);
      S.settings.currency = d.currency; S.settings.compressPhotos = d.compressPhotos; S.settings.backupReminder = d.backupReminder; _nf = null;
      await saveSettings();
      const me = selfPartner();
      if (d.myName && me.name !== d.myName) { me.name = d.myName; await save('partners', me); }
      toast('Settings saved'); render();
    };
  },
});

V.help = () => ({
  title: 'Help', back: '#/more',
  html: `<div class="help">
    <h3>Install on your iPhone (no App Store, no Mac)</h3>
    <ol>
      <li>Open this page in <b>Safari</b> once while online.</li>
      <li>Tap the <b>Share</b> button → <b>Add to Home Screen</b> → <b>Add</b>.</li>
      <li>Open <b>Estate Ledger</b> from your Home Screen. From now on it works with no internet (try Airplane Mode).</li>
    </ol>
    <h3>Backups — protect your data</h3>
    <ul>
      <li>Your data is stored inside the app on this iPhone only. Nothing is uploaded anywhere.</li>
      <li>A backup (.zip) contains <b>everything</b>: all records, settings and every uploaded document. The app itself doesn't need backing up — it re-downloads from its web address.</li>
      <li>Tap <b>Back up</b> on the Home screen, then <b>Save to Files</b> → <b>iCloud Drive</b> (so it survives even losing the phone). Each backup is checked right after it's made.</li>
      <li>iPhone does not let web apps save files silently, so each backup needs that one tap. The app reminds you whenever you have unsaved changes (change how often in Settings).</li>
      <li><b>Before clearing Safari history/website data or deleting the app, make a backup.</b> Afterwards: open the app's web address in Safari (needs internet once), Add to Home Screen, then tap <b>Restore from backup</b> on the welcome screen.</li>
    </ul>
    <h3>How partner splitting works</h3>
    <ul>
      <li>Each property has owners with a %. Income and expenses for that property are split by those %.</li>
      <li><b>Common / property account</b>: rent deposited into the common account, or the mortgage paid from it, is shared by all owners by % and nobody owes anyone — even if one partner physically collected or paid it. You can note who collected it (“Collected by”); that does not change any balance.</li>
      <li><b>A partner personally</b>: if a partner paid from their own pocket, the other owners owe them their share. If a partner kept rent personally (did not deposit it), they owe the other owners their share.</li>
      <li>Link a common account to its property (More › Accounts, or the property page) so that property's entries pick it automatically.</li>
      <li>Only the owners of a property are offered when you record its entries. <b>More › Data check</b> finds duplicate names (merge them) and entries that use someone who isn't an owner.</li>
      <li><b>Partner took money from common account</b> (personal use): counts against that partner — they owe the others their share of it.</li>
      <li><b>Partner put money in</b>: counts in their favour.</li>
      <li>Use <b>Custom split</b> on any entry to override the % (e.g. 100% for one partner).</li>
      <li>More › Partners shows who owes whom and a suggested settlement. Record the settlement payment to clear it.</li>
    </ul>
    <h3>Rent &amp; deposits</h3>
    <ul>
      <li>Each lease charges its monthly rent on the due day. Rent payments (income with category “Rent” linked to the lease) reduce the balance.</li>
      <li>Security deposits are tracked separately as money owed back to the tenant: record received, kept (deductions) and refunded.</li>
    </ul>
    <h3>Importing past entries</h3>
    <ul>
      <li><b>More › Import transactions › Download template</b>. It's an Excel file whose columns have dropdown lists with your own properties, units, tenants, partners and accounts, so you pick instead of typing. Add those in the app first.</li>
      <li>Fill it in (Excel, Numbers or Google Sheets), save as .xlsx or CSV, then <b>Choose file to import</b>.</li>
      <li>You get a preview. Anything the app can't match exactly (a typo, a different spelling) is listed under <b>Match names</b> with a dropdown to pick the right one. Rows with problems are shown and not imported. Entries already in the app are detected as duplicates.</li>
      <li>Your own spreadsheet or a bank export works too: match its columns with the dropdowns, and use “For empty cells, use” to set the property and account for every row.</li>
      <li>Changed your mind? <b>Undo</b> removes everything from that import.</li>
    </ul>
    <h3>Tips</h3>
    <ul>
      <li>The + button adds any entry. Attach statements, screenshots and receipts to entries.</li>
      <li>Excel export includes every sheet you need for your accountant.</li>
    </ul>
  </div>`,
});

// ---------------------------------------------------------------- Excel export
function ledgerSheet(txns, name = 'Ledger') {
  const ps = S.partners;
  const columns = [
    { header: 'Date', type: 'date' }, { header: 'Type' }, { header: 'Category' }, { header: 'Property' }, { header: 'Unit' }, { header: 'Tenant' }, { header: 'Rent month' },
    { header: 'Description' }, { header: 'Money in', type: 'money' }, { header: 'Money out', type: 'money' }, { header: 'Amount', type: 'money' },
    { header: 'Paid from / received into' }, { header: 'Collected / paid by' }, { header: 'Partner' }, { header: 'To partner' }, { header: 'Account' }, { header: 'To account' }, { header: 'Split' },
    ...ps.map((p) => ({ header: `${p.name} share`, type: 'money' })),
    ...ps.map((p) => ({ header: `${p.name} owed(+)/owes(−)`, type: 'money' })),
    { header: 'Attachments', type: 'number' }, { header: 'Entry ID' },
  ];
  const rows = [...txns].sort((a, b) => a.date.localeCompare(b.date)).map((t) => {
    const dir = KINDS[t.kind].dir;
    const shares = sharesFor(t);
    const { cap } = effects(t);
    const total = Object.values(cap).reduce((x, y) => x + y, 0);
    const splitAmt = (pid) => (SPLIT_KINDS.includes(t.kind) && shares[pid] ? r2(t.amount * shares[pid]) : '');
    const l = byId('leases', t.leaseId);
    return [
      t.date, KINDS[t.kind].short, t.category, propName(t.propertyId), unitName(t.unitId), l ? tenantName(l.tenantId) : '', t.period || '',
      t.description, dir === 'in' ? t.amount : '', dir === 'out' ? t.amount : '', t.amount,
      viaLabel(t.via), t.handledBy && t.via?.t === 'a' ? partnerName(t.handledBy) : '', t.partnerId ? partnerName(t.partnerId) : '', t.toPartnerId ? partnerName(t.toPartnerId) : '', t.accountId ? accountName(t.accountId) : '', t.toAccountId ? accountName(t.toAccountId) : '',
      SPLIT_KINDS.includes(t.kind) ? Object.entries(shares).map(([pid, f]) => `${partnerName(pid)} ${r2(f * 100)}%`).join(', ') + (t.split ? ' (custom)' : '') : '',
      ...ps.map((p) => splitAmt(p.id)),
      ...ps.map((p) => { const v = r2((cap[p.id] || 0) - (shares[p.id] || 0) * total); return v ? v : ''; }),
      S.files.filter((f) => f.linkType === 'txn' && f.linkId === t.id).length, t.id,
    ];
  });
  rows.push({ bold: true, cells: ['', 'TOTAL', '', '', '', '', '', '', sum(txns.filter((t) => KINDS[t.kind].dir === 'in'), (t) => t.amount), sum(txns.filter((t) => KINDS[t.kind].dir === 'out'), (t) => t.amount)] });
  return { name, columns, rows };
}
function buildWorkbookSheets() {
  const y = today().slice(0, 4);
  const sheets = [];
  sheets.push({
    name: 'Summary',
    columns: [{ header: 'Property' }, { header: 'Units', type: 'number' }, { header: 'Occupied', type: 'number' }, { header: `Income ${y}`, type: 'money' }, { header: `Expenses ${y}`, type: 'money' }, { header: `Net ${y}`, type: 'money' }, { header: 'Income all time', type: 'money' }, { header: 'Expenses all time', type: 'money' }, { header: 'Net all time', type: 'money' }, { header: 'Rent outstanding', type: 'money' }, { header: 'Deposits held', type: 'money' }],
    rows: S.properties.map((p) => { const a = propertyStats(p, y), b = propertyStats(p); return [p.name, a.units, a.occupied, a.income, a.expense, a.net, b.income, b.expense, b.net, b.outstanding, b.depHeld]; }),
  });
  sheets.push({
    name: 'Properties',
    columns: [{ header: 'Name' }, { header: 'Type' }, { header: 'Address' }, { header: 'Purchase date', type: 'date' }, { header: 'Purchase price', type: 'money' }, { header: 'Current value', type: 'money' }, { header: 'Owners' }, { header: 'Notes' }],
    rows: S.properties.map((p) => [p.name, p.type, p.address, p.purchaseDate, p.purchasePrice, p.currentValue, (p.owners || []).map((o) => `${partnerName(o.partnerId)} ${o.pct}%`).join(', '), p.notes]),
  });
  sheets.push({
    name: 'Units',
    columns: [{ header: 'Property' }, { header: 'Unit' }, { header: 'Layout' }, { header: 'Size' }, { header: 'Typical rent', type: 'money' }, { header: 'Status' }, { header: 'Current tenant' }, { header: 'Current rent', type: 'money' }, { header: 'Notes' }],
    rows: S.units.map((u) => { const l = currentLease(u.id); const act = l && leaseIsActiveOn(l, today()); return [propName(u.propertyId), u.name, u.layout, u.size, u.marketRent, act ? 'Occupied' : l ? 'Upcoming lease' : 'Vacant', l ? tenantName(l.tenantId) : '', l ? l.rent : '', u.notes]; }),
  });
  sheets.push({
    name: 'Tenants',
    columns: [{ header: 'Name' }, { header: 'Phone' }, { header: 'Email' }, { header: 'ID / reference' }, { header: 'Emergency contact' }, { header: 'Notes' }],
    rows: S.tenants.map((t) => [t.name, t.phone, t.email, t.idRef, t.emergency, t.notes]),
  });
  sheets.push({
    name: 'Leases',
    columns: [{ header: 'Tenant' }, { header: 'Property' }, { header: 'Unit' }, { header: 'Start', type: 'date' }, { header: 'End', type: 'date' }, { header: 'Status' }, { header: 'Monthly rent', type: 'money' }, { header: 'Due day', type: 'number' }, { header: 'Rent charged to date', type: 'money' }, { header: 'Rent paid', type: 'money' }, { header: 'Rent balance', type: 'money' }, { header: 'Deposit agreed', type: 'money' }, { header: 'Deposit received', type: 'money' }, { header: 'Deposit kept', type: 'money' }, { header: 'Deposit refunded', type: 'money' }, { header: 'Deposit held', type: 'money' }, { header: 'Notes' }],
    rows: S.leases.map((l) => { const st = leaseStats(l); const u = byId('units', l.unitId); return [tenantName(l.tenantId), propName(u?.propertyId), u?.name, l.startDate, l.endDate, l.status === 'ended' ? 'Ended' : leaseIsActiveOn(l, today()) ? 'Active' : 'Upcoming', l.rent, l.dueDay, st.rentDue, st.rentPaid, st.balance, l.deposit, st.depIn, st.depApplied, st.depOut, st.depHeld, l.notes]; }),
  });
  sheets.push(ledgerSheet(S.txns));
  // partner balances
  const pbRows = [];
  const scopes = [['All properties', S.txns], ...S.properties.map((p) => [p.name, S.txns.filter((t) => t.propertyId === p.id)])];
  for (const [scope, tx] of scopes) {
    const { pos, br } = partnerPositions(tx);
    const ids = Object.keys({ ...pos, ...br });
    if (!ids.length) continue;
    for (const id of ids) { const b = br[id] || {}; pbRows.push([scope, partnerName(id), b.paidPersonally || 0, b.receivedPersonally || 0, b.contributed || 0, b.withdrawn || 0, b.settledPaid || 0, b.settledReceived || 0, b.shareIncome || 0, b.shareExpense || 0, pos[id] || 0, (pos[id] || 0) > 0.005 ? 'is owed' : (pos[id] || 0) < -0.005 ? 'owes' : 'settled']); }
    for (const x of settlePlan(pos)) pbRows.push({ bold: true, cells: [scope, `Suggested: ${partnerName(x.from)} pays ${partnerName(x.to)}`, '', '', '', '', '', '', '', '', x.amount, ''] });
  }
  sheets.push({
    name: 'Partner balances',
    columns: [{ header: 'Scope' }, { header: 'Partner' }, { header: 'Paid expenses personally', type: 'money' }, { header: 'Received income personally', type: 'money' }, { header: 'Put into common account', type: 'money' }, { header: 'Took from common account', type: 'money' }, { header: 'Settlements paid', type: 'money' }, { header: 'Settlements received', type: 'money' }, { header: 'Share of income & deposits received', type: 'money' }, { header: 'Share of expenses & deposit refunds', type: 'money' }, { header: 'Net position (+ owed / − owes)', type: 'money' }, { header: 'Status' }],
    rows: pbRows,
  });
  sheets.push({
    name: 'Accounts',
    columns: [{ header: 'Account' }, { header: 'Details' }, { header: 'Owners' }, { header: 'Opening balance', type: 'money' }, { header: 'Opening date', type: 'date' }, { header: 'Total in', type: 'money' }, { header: 'Total out', type: 'money' }, { header: 'Balance', type: 'money' }],
    rows: S.accounts.map((a) => {
      let tin = 0, tout = 0;
      for (const t of S.txns) { const c = effects(t).cash[a.id] || 0; if (c > 0) tin += c; else tout -= c; }
      return [a.name, a.details, (a.owners || []).map((o) => `${partnerName(o.partnerId)} ${o.pct}%`).join(', '), a.openingBalance || 0, a.openingDate, r2(tin), r2(tout), accountBalance(a.id)];
    }),
  });
  const rr = [];
  for (const l of S.leases) {
    const u = byId('units', l.unitId);
    const months = new Set([...leaseDueMonths(l), ...S.txns.filter((t) => t.leaseId === l.id && isRentPayment(t)).map((t) => t.period || t.date.slice(0, 7))]);
    for (const m of [...months].sort()) {
      const due = dueDate(l, m);
      const st = rentStatus(l, m);
      rr.push([m, tenantName(l.tenantId), propName(u?.propertyId), u?.name, due || '', due ? l.rent : 0, st.paid, due ? r2(l.rent - st.paid) : -st.paid, due ? st.state : 'extra payment']);
    }
  }
  rr.sort((a, b) => a[0].localeCompare(b[0]));
  sheets.push({ name: 'Rent roll', columns: [{ header: 'Month' }, { header: 'Tenant' }, { header: 'Property' }, { header: 'Unit' }, { header: 'Due date', type: 'date' }, { header: 'Rent', type: 'money' }, { header: 'Paid', type: 'money' }, { header: 'Balance', type: 'money' }, { header: 'Status' }], rows: rr });
  const pl = [];
  const years = [...new Set(S.txns.map((t) => t.date.slice(0, 4)))].sort();
  for (const yr of years) {
    for (const [pid, pname] of [['', 'All properties'], ...S.properties.map((p) => [p.id, p.name])]) {
      const d = plData(yr, pid);
      if (!d.totalInc && !d.totalExp) continue;
      for (const [c, v] of Object.entries(d.inc)) pl.push([yr, pname, 'Income', c, v]);
      for (const [c, v] of Object.entries(d.exp)) pl.push([yr, pname, 'Expense', c, -v]);
      pl.push({ bold: true, cells: [yr, pname, 'NET', '', d.net] });
      for (const [ptn, v] of Object.entries(d.shares)) pl.push([yr, pname, 'Partner share of net', partnerName(ptn), v]);
    }
  }
  sheets.push({ name: 'Profit & loss', columns: [{ header: 'Year' }, { header: 'Property' }, { header: 'Type' }, { header: 'Category / partner' }, { header: 'Amount', type: 'money' }], rows: pl });
  sheets.push({
    name: 'Documents',
    columns: [{ header: 'File name' }, { header: 'Linked to' }, { header: 'Property' }, { header: 'Added', type: 'date' }, { header: 'Size (KB)', type: 'number' }, { header: 'Note' }],
    rows: S.files.map((f) => [f.name, fileLinkLabel(f), propName(f.propertyId || (f.linkType === 'property' ? f.linkId : '')), (f.createdAt || '').slice(0, 10), Math.round(f.size / 1024), f.note]),
  });
  return sheets;
}
async function exportAll() {
  toast('Building Excel file…');
  const blob = await Xlsx.build(buildWorkbookSheets());
  offerFile(blob, `EstateLedger_${today()}.xlsx`);
}
async function exportLedger() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const { list } = ledgerFilter(q);
  const blob = await Xlsx.build([ledgerSheet(list)]);
  offerFile(blob, `Ledger_${today()}.xlsx`);
}

// ---------------------------------------------------------------- backup / restore
async function backup(withFiles) {
  toast('Preparing backup…', 5000);
  const data = { format: 'estate-ledger-backup', version: 1, exportedAt: new Date().toISOString(), settings: S.settings, includesFiles: withFiles };
  for (const s of DATA_STORES) data[s] = S[s];
  const entries = [{ name: 'data.json', data: JSON.stringify(data, null, 1) }];
  if (withFiles) {
    for (const f of S.files) {
      const b = await blobFor(f.id);
      if (b) entries.push({ name: `files/${f.id}__${f.name.replace(/[\\/:*?"<>|]/g, '_')}`, data: b });
    }
  }
  entries.push({ name: 'README.txt', data: 'Estate Ledger backup.\nRestore it from the app: More > Export & backup > Restore from backup.\ndata.json holds all records; files/ holds uploaded documents.\n' });
  const blob = await Zip.create(entries);
  // Read the finished zip back to prove it restores: data parses, record counts and every document match.
  const check = await Zip.read(await blob.arrayBuffer());
  const back = JSON.parse(new TextDecoder().decode(check.get('data.json')));
  const nFiles = [...check.keys()].filter((n) => n.startsWith('files/')).length;
  const recs = DATA_STORES.reduce((a, k) => a + (back[k] || []).length, 0);
  const expectRecs = DATA_STORES.reduce((a, k) => a + S[k].length, 0);
  if (recs !== expectRecs || (withFiles && nFiles !== entries.length - 2)) throw new Error('Verification of the backup file failed. Please try again.');
  const note = `✓ Verified: ${recs} records${withFiles ? `, ${nFiles} documents` : ' (documents not included)'}.`;
  offerFile(blob, `EstateLedger_backup_${today()}${withFiles ? '' : '_nofiles'}.zip`, async () => {
    S.settings.lastBackupAt = new Date().toISOString();
    await saveSettings();
    render();
  }, note);
}
async function restoreBackup(file) {
  try {
    const map = await Zip.read(await file.arrayBuffer());
    const raw = map.get('data.json');
    if (!raw) throw new Error('data.json not found — is this an Estate Ledger backup?');
    const data = JSON.parse(new TextDecoder().decode(raw));
    if (data.format !== 'estate-ledger-backup') throw new Error('This is not an Estate Ledger backup file.');
    const counts = `${(data.properties || []).length} properties, ${(data.txns || []).length} transactions, ${(data.files || []).length} files, made ${fmtDate((data.exportedAt || '').slice(0, 10))}`;
    if (!confirm(`Restore this backup?\n\n${counts}\n\nEverything currently in the app will be REPLACED.`)) return;
    const out = { settings: [{ ...(data.settings || {}), id: 'main', lastBackupAt: data.exportedAt, lastChangeAt: data.exportedAt }] };
    for (const s of DATA_STORES) out[s] = Array.isArray(data[s]) ? data[s] : [];
    const byFileId = new Map();
    for (const [name, bytes] of map) {
      const m = /^files\/([^_]+)__/.exec(name);
      if (m) byFileId.set(m[1], bytes);
    }
    out.blobs = [];
    const missing = [];
    for (const f of out.files) {
      const bytes = byFileId.get(f.id);
      if (bytes) out.blobs.push({ id: f.id, buf: bytes.slice().buffer, type: f.type });
      else missing.push(f.id);
    }
    if (missing.length) {
      // keep the documents already on this device for files that the backup does not include
      for (const id of missing) { const b = await DB.get('blobs', id); if (b) out.blobs.push(b); }
    }
    await DB.replaceAll(out);
    urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
    await loadAll();
    toast('Backup restored');
    location.hash = '#/home';
    render();
  } catch (e) {
    alert('Restore failed: ' + e.message);
  }
}

// ---------------------------------------------------------------- actions (click delegation)
const ACTIONS = {
  go: (d) => { location.hash = d.href; },
  txn: (d) => txnForm(d.id),
  newTxn: (d) => {
    const preset = {};
    for (const k of ['kind', 'propertyId', 'unitId', 'leaseId', 'category', 'partnerId', 'toPartnerId', 'accountId']) if (d[k]) preset[k] = d[k];
    if (d.amount) preset.amount = d.amount;
    if (d.category === '') preset.category = '';
    txnForm(null, preset);
  },
  rent: (d) => {
    const l = byId('leases', d.id);
    const u = byId('units', l.unitId);
    const paid = paidForPeriod(l, d.period);
    txnForm(null, { kind: 'income', category: 'Rent', leaseId: l.id, unitId: l.unitId, propertyId: u?.propertyId, period: d.period, amount: r2(Math.max(0, l.rent - paid)) || l.rent });
  },
  newProperty: () => propertyForm(),
  editProperty: (d) => propertyForm(d.id),
  newUnit: (d) => unitForm(null, d.id),
  editUnit: (d) => unitForm(d.id),
  newLease: (d) => leaseForm(null, { ...(d.unitId ? { unitId: d.unitId } : {}), ...(d.tenantId ? { tenantId: d.tenantId } : {}) }),
  editLease: (d) => leaseForm(d.id),
  endLease: (d) => endLeaseForm(d.id),
  reopenLease: async (d) => { const l = byId('leases', d.id); if (!confirm('Reopen this lease as active?')) return; l.status = 'active'; await save('leases', l); render(); },
  newTenant: () => tenantForm(),
  editTenant: (d) => tenantForm(d.id),
  newPartner: () => partnerForm(),
  editPartner: (d) => partnerForm(d.id),
  merge: (d) => mergeForm(d.store, d.id),
  fixOwners: async (d) => {
    const p = byId('properties', d.id);
    const out = [];
    for (const o of p.owners || []) { const hit = out.find((x) => x.partnerId === o.partnerId); if (hit) hit.pct = r2(num(hit.pct) + num(o.pct)); else out.push({ ...o }); }
    p.owners = out; await save('properties', p); toast('Combined'); render();
  },
  newAccount: (d) => accountForm(null, d.propertyId ? { propertyId: d.propertyId, name: propName(d.propertyId) + ' account' } : {}),
  editAccount: (d) => accountForm(d.id),
  uploadDoc: (d) => uploadDocForm(d.linkType || 'general', d.id),
  exportAll: () => exportAll().catch((e) => alert('Export failed: ' + e.message)),
  exportLedger: () => exportLedger().catch((e) => alert('Export failed: ' + e.message)),
  backup: () => backup(true).catch((e) => alert('Backup failed: ' + e.message)),
  backupLite: () => backup(false).catch((e) => alert('Backup failed: ' + e.message)),
  eraseAll: async () => {
    if (prompt('This deletes ALL properties, transactions and documents on this device. Type ERASE to confirm.') !== 'ERASE') return;
    await DB.clearAll();
    urlCache.clear();
    await loadAll();
    location.hash = '#/home';
    render();
  },
};

// ---------------------------------------------------------------- router
const TAB_OF = { home: 'home', properties: 'properties', property: 'properties', unit: 'properties', rentals: 'rentals', lease: 'rentals', tenant: 'rentals', ledger: 'ledger' };
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/home';
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], q: new URLSearchParams(qs || '') };
}
let currentBack = null;
function render() {
  const { name, id, q } = parseHash();
  const view = V[name] || V.home;
  let res;
  try { res = view(id, q); }
  catch (e) { console.error(e); res = { title: 'Error', html: `<div class="empty">Something went wrong: ${esc(e.message)}</div>` }; }
  const main = $('#main');
  const keepScroll = render._last === location.hash;
  const y = window.scrollY;
  $('#title').textContent = res.title || 'Estate Ledger';
  document.title = (res.title && res.title !== 'Estate Ledger' ? res.title + ' · ' : '') + 'Estate Ledger';
  main.innerHTML = res.html;
  currentBack = res.back || null;
  $('#backBtn').hidden = !currentBack;
  $('#topActions').innerHTML = (res.actions || []).map((a, i) => `<button data-top="${i}">${esc(a.label)}</button>`).join('');
  $$('#topActions [data-top]').forEach((b) => (b.onclick = () => { const a = res.actions[+b.dataset.top]; ACTIONS[a.act]({ id: a.id, linkType: a.linkType }); }));
  $('#fab').hidden = name === 'import';
  const tab = TAB_OF[name] || 'more';
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (res.bind) res.bind(main);
  hydrateThumbs(main);
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  render._last = location.hash;
}

// ---------------------------------------------------------------- boot
async function init() {
  $('#backBtn').onclick = () => { if (currentBack) location.hash = currentBack; };
  $('#fab').onclick = () => {
    const { name, id } = parseHash();
    const preset = {};
    if (name === 'property') preset.propertyId = id;
    if (name === 'unit') { preset.unitId = id; preset.propertyId = byId('units', id)?.propertyId; }
    if (name === 'lease') { const l = byId('leases', id); preset.leaseId = id; preset.unitId = l?.unitId; preset.propertyId = byId('units', l?.unitId)?.propertyId; }
    txnForm(null, preset);
  };
  $('#sheetClose').onclick = closeSheet;
  $('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });
  $('#main').addEventListener('click', (e) => {
    const vf = e.target.closest('[data-view-file]');
    if (vf) { e.preventDefault(); viewFile(vf.dataset.viewFile); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) { e.preventDefault(); fn({ ...el.dataset }); }
  });
  window.addEventListener('hashchange', render);
  try {
    await loadAll();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty">Could not open the local database: ${esc(e.message)}<br><br>If you are in Private Browsing, switch to a normal Safari tab.</div>`;
    return;
  }
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      toast('App updated — reloading…');
      setTimeout(() => location.reload(), 800);
    });
  }
}
init();
