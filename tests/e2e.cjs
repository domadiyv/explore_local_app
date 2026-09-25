/* End-to-end tests for Estate Ledger, driven in a real Chromium via Playwright.
   Run:  NODE_PATH=$(npm root -g) node tests/e2e.cjs      (needs `npm i -g playwright`)
   Optional: OLD_ROOT=<folder with a previous release> also tests upgrading from it with existing data. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const NEW_ROOT = path.resolve(__dirname, '..');
let root = NEW_ROOT;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(name) { console.log('\n' + name); }

(async () => {
  await new Promise((r) => server.listen(0, r));
  const URL0 = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // queue of answers for prompt/confirm/alert; each entry: string (prompt text) | true/false (confirm)
  const answers = [];
  const dialogLog = [];
  page.on('dialog', async (d) => {
    dialogLog.push(`${d.type()}: ${d.message()}`);
    const a = answers.length ? answers.shift() : (d.type() === 'alert' ? true : undefined);
    if (a === false) return d.dismiss();
    if (typeof a === 'string') return d.accept(a);
    return d.accept();
  });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(120); };
  const sheet = '#sheetBody';
  const sel = async (name, value) => { await page.selectOption(`${sheet} [name="${name}"]`, value); await page.waitForTimeout(60); };
  const fill = (name, value) => page.fill(`${sheet} [name="${name}"]`, String(value));
  const submit = async () => { await page.click(`${sheet} form button.btn.block:not(.sec):not(.danger)`); await page.waitForTimeout(250); };
  const toastText = () => page.textContent('#toast');
  const pid = (name) => ev((n) => S.partners.find((p) => p.name === n)?.id, name);
  const propId = (name) => ev((n) => S.properties.find((p) => p.name === n)?.id, name);
  const positions = (propertyName) => ev((n) => {
    const p = S.properties.find((x) => x.name === n);
    const { pos } = partnerPositions(p ? S.txns.filter((t) => t.propertyId === p.id) : S.txns);
    const out = {}; for (const [id, v] of Object.entries(pos)) if (Math.abs(v) > 0.005) out[partnerName(id)] = v; return out;
  }, propertyName);
  const openNewTxn = async () => { await page.click('#fab'); await page.waitForSelector(`${sheet} [name=kind]`); };

  try {
    // ------------------------------------------------------------ upgrade from previous release
    if (process.env.OLD_ROOT) {
      section('Upgrade from the previous release keeps existing data');
      root = path.resolve(process.env.OLD_ROOT);
      await page.goto(URL0);
      await page.waitForSelector('text=Welcome');
      await page.evaluate(() => navigator.serviceWorker.ready);
      await ev(async () => {
        const me = S.partners.find((p) => p.isSelf);
        const raj = { id: 'p_raj', name: 'Raj' }, raj2 = { id: 'p_raj2', name: 'Raj' };
        await save('partners', raj); await save('partners', raj2);
        await save('properties', { id: 'prop_old', name: 'Old House', owners: [{ partnerId: me.id, pct: 50 }, { partnerId: 'p_raj', pct: 50 }] });
        await save('units', { id: 'u_old', propertyId: 'prop_old', name: 'Main' });
        await save('accounts', { id: 'acc_old', name: 'Joint', owners: [{ partnerId: me.id, pct: 50 }, { partnerId: 'p_raj', pct: 50 }], openingBalance: 100 });
        await save('txns', { id: 'tx_old1', kind: 'income', date: '2026-01-05', amount: 1000, category: 'Rent', description: 'Jan rent cheque 123', propertyId: 'prop_old', via: { t: 'a', id: 'acc_old' } });
        await save('txns', { id: 'tx_old2', kind: 'expense', date: '2026-01-10', amount: 400, category: 'Repairs', propertyId: 'prop_old', via: { t: 'p', id: 'p_raj2' } });
      });
      const before = await ev(() => ({ n: S.txns.length, bal: accountBalance('acc_old') }));
      // deploy the new version to the same address
      root = NEW_ROOT;
      await page.reload();
      // the new service worker installs in the background, takes over and reloads the page by itself
      let upgraded = false;
      for (let i = 0; i < 40 && !upgraded; i++) {
        await page.waitForTimeout(250);
        upgraded = await page.evaluate(() => typeof dataIssues === 'function').catch(() => false);
      }
      ok(upgraded, 'app reloaded itself into the new version');
      await page.waitForTimeout(500);
      await page.waitForSelector('.stats');
      const sw = await ev(async () => (await caches.keys()).join(','));
      ok(sw.includes('estate-ledger-v3') && !sw.includes('v2'), 'service worker switched to the new version cache: ' + sw);
      ok(await ev(() => typeof dataIssues === 'function'), 'new app code is running after the update');
      const after = await ev(() => ({ n: S.txns.length, bal: accountBalance('acc_old') }));
      eq(after, before, 'all transactions and balances survive the update');
      eq(before.bal, 1100, 'old account balance');
      await go('#/ledger');
      ok((await page.textContent('#main')).includes('Jan rent cheque 123'), 'old entry description now visible in ledger');
      await go('#/check');
      const chk = await page.textContent('#main');
      ok(chk.includes('Partner “Raj” exists 2 times') && chk.includes('owns Old House · 0 entries') && chk.includes('owns no property · 1 entry'), 'data check finds the old duplicate partner and says which copy is which');
      ok(chk.includes('not an owner'), 'data check finds the old entry paid by a non-owner (duplicate Raj)');
      // merge duplicate Raj → original
      await page.click('[data-act=merge][data-id=p_raj2]');
      await sel('to', 'p_raj');
      answers.push(true);
      await submit();
      ok(!(await ev(() => byId('partners', 'p_raj2'))), 'duplicate partner removed after merge');
      eq(await ev(() => byId('txns', 'tx_old2').via), { t: 'p', id: 'p_raj' }, 'entry moved to the kept partner');
      await go('#/check');
      ok((await page.textContent('#main')).includes('No problems found'), 'data check is clean after merge');
      ok(await ev(() => S.txns.length === 2 && S.properties.length === 1), 'still the same data');
      // wipe for the main suite
      await ev(async () => { await DB.clearAll(); await loadAll(); location.hash = '#/home'; render(); });
    } else {
      await page.goto(URL0);
    }

    // ------------------------------------------------------------ setup
    section('Partners: names, duplicates');
    await page.waitForSelector('text=Welcome');
    await go('#/settings');
    await page.fill('#sf [name=myName]', 'Viraj');
    await page.click('#sf button.btn');
    await page.waitForTimeout(150);
    ok(await ev(() => selfPartner().name === 'Viraj'), 'renamed "Me" to Viraj');
    await go('#/partners');
    for (const n of ['Raj', 'Amit']) {
      await page.click('#topActions button');
      await fill('name', n); await submit();
    }
    eq(await ev(() => S.partners.map((p) => p.name).sort()), ['Amit', 'Raj', 'Viraj'], 'three partners');
    // duplicate name (different case/spaces) → warned; cancel keeps it out
    await page.click('#topActions button');
    await fill('name', '  raj '); answers.push(false); await submit();
    ok(dialogLog.at(-1).includes('already exists'), 'warned about duplicate partner name');
    eq(await ev(() => S.partners.length), 3, 'duplicate not saved when cancelled');
    await page.click('#sheetClose');

    section('Property owners editor');
    await go('#/properties');
    await page.click('#topActions button');
    await fill('name', 'Maple');
    await fill('unitCount', 2);
    await page.click('#addOwner'); await page.click('#addOwner');
    await page.click('#addOwner');
    ok((await toastText()).includes('already listed'), '"+ Owner" refuses when every partner is already an owner');
    eq(await page.$$eval('.owner-row', (r) => r.length), 3, 'three owner rows, no duplicate added');
    const [v, r, a] = [await pid('Viraj'), await pid('Raj'), await pid('Amit')];
    await page.selectOption('[name=owner_p_1]', v);
    ok((await page.textContent('#ownerSum')).includes('more than once'), 'picking the same partner twice shows an error');
    await submit();
    ok((await toastText()).includes('more than once'), 'saving with the same partner twice is blocked');
    await page.selectOption('[name=owner_p_1]', r);
    await page.fill('[name=owner_pct_0]', '34'); await page.fill('[name=owner_pct_1]', '33'); await page.fill('[name=owner_pct_2]', '33');
    ok((await page.textContent('#ownerSum')).includes('100% ✓'), 'total 100% ✓');
    await submit();
    const maple = await propId('Maple');
    eq(await ev((id) => byId('properties', id).owners.map((o) => [partnerName(o.partnerId), o.pct]), maple), [['Viraj', 34], ['Raj', 33], ['Amit', 33]], 'Maple owners saved');

    // second property via "+ New partner" typed with an existing name → reuses the partner
    await go('#/properties');
    await page.click('#topActions button');
    await fill('name', 'Oak'); await fill('unitCount', 1);
    answers.push('RAJ');
    await page.click('#newPartner'); await page.waitForTimeout(150);
    eq(await ev(() => S.partners.length), 3, '"+ New partner" with an existing name does not create a duplicate');
    ok((await toastText()).includes('already exists'), 'told the user the existing partner was used');
    answers.push('Sam');
    await page.click('#newPartner'); await page.waitForTimeout(150);
    answers.push('Sam');
    await page.click('#newPartner'); await page.waitForTimeout(150);
    ok((await toastText()).includes('already an owner'), 'adding the same new partner twice is refused');
    // owners now: Viraj 100, Raj 0, Sam 0 → set Viraj 50, remove Raj, Sam 50
    await page.fill('[name=owner_pct_0]', '50');
    await page.click('[data-owner-del="1"]');
    await page.fill('[name=owner_pct_1]', '50');
    await submit();
    const oak = await propId('Oak');
    const sam = await pid('Sam');
    eq(await ev((id) => byId('properties', id).owners.map((o) => [partnerName(o.partnerId), o.pct]), oak), [['Viraj', 50], ['Sam', 50]], 'Oak owners saved');
    eq(await ev(() => S.partners.map((p) => p.name).sort()), ['Amit', 'Raj', 'Sam', 'Viraj'], 'four distinct partners, no duplicates');

    // change % allocation later (the original bug report) → no duplicate
    await go('#/property/' + maple);
    await page.click('#topActions button');
    await page.fill('[name=owner_pct_0]', '40'); await page.fill('[name=owner_pct_1]', '30'); await page.fill('[name=owner_pct_2]', '30');
    await submit();
    const chips = await page.$$eval('#main .card .chip', (els) => els.map((e) => e.textContent));
    eq(chips, ['Viraj 40%', 'Raj 30%', 'Amit 30%'], 'after changing %, each owner appears once on the property');
    await page.click('#topActions button');
    await page.fill('[name=owner_pct_0]', '33.34'); await page.fill('[name=owner_pct_1]', '33.33'); await page.fill('[name=owner_pct_2]', '33.33');
    await submit();

    section('Income into the common account (no account yet → created automatically)');
    await go('#/property/' + maple);
    await page.click('[data-act=newTxn][data-kind=income]');
    await page.waitForSelector(`${sheet} [name=viaMode]`);
    eq(await page.$eval(`${sheet} [name=viaMode]:checked`, (e) => e.value), 'a', 'defaults to common account');
    ok((await page.textContent(`${sheet} [name=viaAcc]`)).includes('Maple account (new'), 'offers to create "Maple account"');
    const collectedOpts = await page.$$eval(`${sheet} [name=handledBy] option`, (o) => o.map((x) => x.textContent));
    eq(collectedOpts, ['—', 'Viraj (me)', 'Raj', 'Amit'], '"Collected by" lists only Maple owners');
    await fill('amount', 3000); await fill('category', 'Rent'); await fill('date', '2026-09-01');
    await sel('handledBy', r);
    await fill('description', 'September rent — Zelle from tenant');
    await submit();
    const macc = await ev(() => S.accounts[0]);
    eq([macc?.name, macc?.propertyId === maple], ['Maple account', true], 'account "Maple account" created and linked to Maple');
    eq(await ev(() => S.txns[0].handledBy === S.partners.find((p) => p.name === 'Raj').id), true, 'collected-by stored');
    eq(await positions('Maple'), {}, 'income in common account: nobody owes anybody (even though Raj collected it)');
    eq(await ev((id) => accountBalance(id), macc.id), 3000, 'Maple account balance 3000');

    section('Expense (mortgage) paid from the common account');
    await go('#/property/' + maple);
    await page.click('[data-act=newTxn][data-kind=expense]');
    eq(await page.$eval(`${sheet} [name=viaAcc]`, (e) => e.value), macc.id, 'expense defaults to the Maple account');
    await fill('amount', 1800); await fill('category', 'Mortgage / loan EMI'); await fill('date', '2026-09-03');
    await submit();
    eq(await positions('Maple'), {}, 'mortgage from common account: nobody owes anybody');
    eq(await ev((id) => accountBalance(id), macc.id), 1200, 'Maple account balance 1200');

    section('Partner kept income personally / paid expense personally');
    await go('#/property/' + maple);
    await page.click('[data-act=newTxn][data-kind=income]');
    await page.click(`${sheet} label:has(input[name=viaMode][value=p])`); await page.waitForTimeout(80);
    const keptOpts = await page.$$eval(`${sheet} [name=viaPartner] option`, (o) => o.map((x) => x.textContent));
    eq(keptOpts, ['Choose…', 'Viraj (me)', 'Raj', 'Amit'], 'only Maple owners offered as the partner');
    await sel('viaPartner', r);
    ok((await page.textContent(sheet)).includes('Raj kept the money personally'), 'explains the effect of keeping it personally');
    await fill('amount', 900); await fill('category', 'Late fee'); await fill('date', '2026-09-04');
    await submit();
    const p1 = await positions('Maple');
    ok(Math.abs(p1.Raj + 600) < 0.05 && Math.abs(p1.Viraj - 300.06) < 0.02 && Math.abs(p1.Amit - 299.97) < 0.02, 'Raj owes the others their share of 900: ' + JSON.stringify(p1));
    await go('#/property/' + maple);
    await page.click('[data-act=newTxn][data-kind=expense]');
    await page.click(`${sheet} label:has(input[name=viaMode][value=p])`); await page.waitForTimeout(80);
    await sel('viaPartner', a);
    await fill('amount', 300); await fill('category', 'Repairs & maintenance'); await fill('date', '2026-09-05');
    await submit();
    const p2 = await positions('Maple');
    ok(Math.abs(p2.Amit - (299.97 + 200.01)) < 0.03, 'Amit is owed for the repair he paid: ' + JSON.stringify(p2));
    ok(Math.abs(Object.values(p2).reduce((x, y) => x + y, 0)) < 0.02, 'positions always add up to zero');

    await go('#/property/' + maple);
    await page.click('[data-act=newTxn][data-kind=expense]');
    eq(await page.$eval(`${sheet} [name=viaMode]:checked`, (e) => e.value), 'a', 'after a "paid personally" entry, the next one still defaults to the common account');
    await page.click('#sheetClose');

    section('Partner uses common money personally (withdrawal)');
    await go('#/accounts');
    await page.click('[data-act=newTxn][data-kind=withdrawal]');
    await sel('accountId', macc.id);
    eq(await page.$eval(`${sheet} [name=propertyId]`, (e) => e.value), maple, 'choosing the Maple account sets the property to Maple');
    const wOpts = await page.$$eval(`${sheet} [name=partnerId] option`, (o) => o.map((x) => x.textContent));
    eq(wOpts, ['Choose…', 'Viraj (me)', 'Raj', 'Amit'], 'withdrawal partner list = Maple owners only');
    await sel('partnerId', r);
    await fill('amount', 300); await fill('category', 'Personal use'); await fill('date', '2026-09-06');
    await submit();
    const p3 = await positions('Maple');
    ok(Math.abs(p3.Raj - (p2.Raj - 200)) < 0.03, 'Raj now owes 2/3 of the 300 he took: ' + JSON.stringify(p3));
    eq(await ev((id) => accountBalance(id), macc.id), 900, 'Maple account balance 900 after withdrawal');

    section('Oak entries only offer Oak partners; switching property resets partners');
    await go('#/property/' + oak);
    await page.click('[data-act=newTxn][data-kind=expense]');
    ok((await page.textContent(`${sheet} [name=viaAcc]`)).includes('Oak account (new'), 'Oak does not default to the Maple account');
    ok(!(await page.textContent(`${sheet} [name=viaAcc]`)).includes('Maple account'), 'Maple account not offered for Oak');
    await page.click(`${sheet} label:has(input[name=viaMode][value=p])`); await page.waitForTimeout(80);
    eq(await page.$$eval(`${sheet} [name=viaPartner] option`, (o) => o.map((x) => x.textContent)), ['Choose…', 'Viraj (me)', 'Sam'], 'only Viraj and Sam for Oak');
    await sel('propertyId', maple);
    await sel('viaPartner', a);
    await sel('propertyId', oak);
    eq(await page.$eval(`${sheet} [name=viaPartner]`, (e) => e.value), v, 'switching to Oak replaced Amit (not an Oak owner) with Viraj');
    await page.check(`${sheet} [name=customSplit]`); await page.waitForTimeout(80);
    eq(await page.$$eval(`${sheet} .split-grid span`, (o) => o.map((x) => x.textContent)), ['Viraj', 'Sam'], 'custom split lists only Oak owners');
    await page.uncheck(`${sheet} [name=customSplit]`); await page.waitForTimeout(80);
    await fill('amount', 500); await fill('category', 'Insurance'); await fill('date', '2026-08-15');
    await page.click(`${sheet} label:has(input[name=viaMode][value=a])`); await page.waitForTimeout(80);
    await submit();
    eq(await ev(() => S.accounts.map((x) => x.name).sort()), ['Maple account', 'Oak account'], 'Oak account created for Oak');
    eq(await positions('Oak'), {}, 'Oak expense from Oak account: settled');
    await go('#/property/' + oak);
    const oakBal = await page.textContent('#main');
    ok(!oakBal.includes('Raj') && !oakBal.includes('Amit'), 'Oak page shows no Maple-only partners');
    await go('#/partners?p=' + oak);
    const pp = await page.textContent('#main');
    ok(pp.includes('Owners of Oak') && !pp.includes('Amit'), 'Partners page filtered to Oak shows only Oak owners');

    section('Editing an existing entry keeps its values');
    const firstId = await ev(() => S.txns.find((t) => t.description?.startsWith('September')).id);
    await ev((id) => txnForm(id), firstId);
    await page.waitForSelector(`${sheet} [name=viaAcc]`);
    eq(await page.$eval(`${sheet} [name=handledBy]`, (e) => e.value), r, 'collected-by shown when editing');
    await fill('amount', 3100); await submit();
    const ed = await ev((id) => byId('txns', id), firstId);
    eq([ed.amount, ed.via.id, ed.handledBy, ed.description], [3100, macc.id, r, 'September rent — Zelle from tenant'], 'edit saved without losing account / collected-by / description');

    section('Ledger shows description and collected-by');
    await go('#/ledger');
    const row = await page.$eval(`[data-id="${firstId}"]`, (e) => e.innerText);
    ok(row.includes('September rent — Zelle from tenant'), 'description shown on the ledger row');
    ok(row.includes('collected by Raj'), '"collected by Raj" shown on the ledger row');
    ok(await page.$eval(`[data-id="${firstId}"] .d`, (e) => getComputedStyle(e).fontSize === '12px'), 'description is in small text');
    await page.fill('[data-q=q]', 'zelle'); await page.waitForTimeout(600);
    eq(await page.$$eval('#main .row.nav', (r) => r.length), 1, 'search finds entries by description');
    await go('#/ledger');

    section('Ledger custom dates');
    await page.selectOption('[data-q=per]', 'custom'); await page.waitForTimeout(150);
    ok(await page.$('[data-date=from]'), 'custom date inputs shown');
    ok(await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'custom dates + Apply fit the phone width');
    ok(await page.$eval('#applyDates', (e) => e.getBoundingClientRect().right <= window.innerWidth), 'Apply button fully visible');
    const today = await ev(() => today());
    eq(await page.$eval('[data-date=to]', (e) => e.value), today, 'defaults "to" = today');
    const marker = await page.$eval('[data-date=from]', (e) => { e.dataset.marker = '1'; return 1; });
    // simulate the iOS wheel: several change events while the picker is open
    await page.focus('[data-date=from]');
    for (const d of ['2026-07-01', '2026-06-01', '2026-08-01']) await page.$eval('[data-date=from]', (e, d) => { e.value = d; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, d);
    await page.waitForTimeout(300);
    ok(await page.$('[data-date=from][data-marker="1"]'), 'page does not re-render while the date is being picked');
    ok(await page.$eval('[data-date=from]', (e) => document.activeElement === e), 'date field keeps focus while picking');
    // moving to the "to" field must not re-render either
    await page.focus('[data-date=to]'); await page.waitForTimeout(300);
    ok(await page.$('[data-date=from][data-marker="1"]'), 'moving from "From" to "To" does not re-render');
    await page.$eval('[data-date=to]', (e) => { e.value = '2026-08-31'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#applyDates'); await page.waitForTimeout(200);
    const h = await ev(() => location.hash);
    ok(h.includes('from=2026-08-01') && h.includes('to=2026-08-31'), 'Apply sets the range: ' + h);
    eq(await page.$$eval('#main .row.nav', (r) => r.length), 1, 'only the August entry is listed');
    // blur (tap outside) also applies
    await page.focus('[data-date=from]');
    await page.$eval('[data-date=from]', (e) => { e.value = '2026-09-01'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('[data-date=to]', (e) => { e.value = '2026-09-30'; });
    await page.click('#title'); await page.waitForTimeout(400);
    const h2 = await ev(() => location.hash);
    ok(h2.includes('from=2026-09-01') && h2.includes('to=2026-09-30'), 'leaving the date fields applies them: ' + h2);
    eq(await page.$$eval('#main .row.nav', (r) => r.length), 5, 'September entries listed');
    // reversed range is swapped
    await page.$eval('[data-date=from]', (e) => { e.value = '2026-09-30'; });
    await page.$eval('[data-date=to]', (e) => { e.value = '2026-08-01'; });
    await page.click('#applyDates'); await page.waitForTimeout(200);
    const h3 = await ev(() => location.hash);
    ok(h3.includes('from=2026-08-01') && h3.includes('to=2026-09-30'), 'reversed dates are swapped');
    await page.selectOption('[data-q=per]', 'all'); await page.waitForTimeout(150);
    ok(!(await page.$('[data-date=from]')), 'switching back to All dates hides the pickers');

    section('Tenants belong to their property');
    await ev(() => leaseForm(null, { unitId: S.units.find((u) => u.propertyId === S.properties.find((p) => p.name === 'Maple').id).id }));
    await page.waitForSelector('#tenantSel');
    answers.push('John Smith', '555-0100');
    await page.selectOption('#tenantSel', '__new'); await page.waitForTimeout(200);
    await fill('rent', 1500); await fill('startDate', '2026-01-01');
    await submit();
    await ev(() => leaseForm(null, { unitId: S.units.find((u) => u.propertyId === S.properties.find((p) => p.name === 'Oak').id).id }));
    await page.waitForSelector('#tenantSel');
    const groups = await page.$$eval('#tenantSel optgroup', (g) => g.map((x) => x.label));
    eq(groups, ['At other properties'], 'Oak lease: John (Maple) listed under "At other properties"');
    answers.push('john smith', true); // duplicate name → use existing? OK
    await page.selectOption('#tenantSel', '__new'); await page.waitForTimeout(200);
    eq(await ev(() => S.tenants.length), 1, 'typing an existing tenant name offers the existing tenant instead of a duplicate');
    answers.push('Mary Jones', '');
    await page.selectOption('#tenantSel', '__new'); await page.waitForTimeout(200);
    await fill('rent', 1200); await fill('startDate', '2026-02-01');
    await submit();
    await go('#/rentals/tenants');
    const heads = await page.$$eval('#main h2', (h) => h.map((x) => x.textContent));
    eq(heads, ['Maple (1)', 'Oak (1)'], 'tenants grouped by property');
    await page.selectOption('#rpf', oak); await page.waitForTimeout(150);
    const tn = await page.textContent('#main .list');
    ok(tn.includes('Mary Jones') && !tn.includes('John Smith'), 'filter by Oak shows only Oak tenants');
    await page.click('.seg button:has-text("Leases")'); await page.waitForTimeout(150);
    const ln = await page.textContent('#main');
    ok(ln.includes('Mary Jones') && !ln.includes('John Smith'), 'property filter carries over to Leases');
    await page.click('.seg button:has-text("Rent roll")'); await page.waitForTimeout(150);
    ok((await ev(() => location.hash)).includes('p='), 'property filter carries over to Rent roll');

    section('Duplicate tenant merge');
    await ev(async () => { await save('tenants', { id: 't_dup', name: 'Mary  jones', phone: '555-0199' }); });
    await go('#/check');
    ok((await page.textContent('#main')).includes('Tenant “Mary Jones” exists 2 times') || (await page.textContent('#main')).includes('exists 2 times'), 'data check finds duplicate tenant');
    await page.click('[data-act=merge][data-store=tenants][data-id=t_dup]');
    answers.push(true); await submit();
    eq(await ev(() => S.tenants.length), 2, 'duplicate tenant merged');
    eq(await ev(() => S.tenants.find((t) => t.name === 'Mary Jones').phone || S.tenants.find((t) => normName(t.name) === 'mary jones').phone), '555-0199', 'missing phone copied from the merged duplicate');

    section('Legacy data problems are detected and fixable');
    await ev(async () => {
      const p = S.properties.find((x) => x.name === 'Oak');
      await save('properties', { ...p, owners: [...p.owners, { partnerId: p.owners[0].partnerId, pct: 10 }] });
      const raj = S.partners.find((x) => x.name === 'Raj');
      await save('txns', { id: 'legacy1', kind: 'expense', date: '2026-07-01', amount: 100, category: 'Cleaning', propertyId: p.id, via: { t: 'p', id: raj.id } });
      render();
    });
    await go('#/home');
    ok((await page.textContent('#main')).includes('to review'), 'home shows a "things to review" banner');
    await go('#/property/' + oak);
    ok((await page.textContent('#main')).includes('not an owner'), 'property page flags Raj as "not an owner" of Oak');
    await go('#/check');
    const ct = await page.textContent('#main');
    ok(ct.includes('Oak: Viraj listed as owner more than once'), 'duplicate owner row detected');
    ok(ct.includes('Oak: 1 entry uses Raj, who is not an owner'), 'non-owner entry detected');
    ok(ct.includes('Oak: ownership adds up to 110%'), 'ownership total detected');
    await page.click('[data-act=fixOwners]'); await page.waitForTimeout(150);
    eq(await ev(() => S.properties.find((x) => x.name === 'Oak').owners.map((o) => [partnerName(o.partnerId), o.pct])), [['Viraj', 60], ['Sam', 50]], 'Combine merges the duplicate owner rows');
    // fix the outsider entry from the list
    await page.click('[data-id=legacy1]');
    await page.waitForSelector(`${sheet} [name=viaPartner]`);
    eq(await page.$$eval(`${sheet} [name=viaPartner] option`, (o) => o.map((x) => x.textContent)), ['Choose…', 'Viraj (me)', 'Raj (not an owner)', 'Sam'], 'editing keeps the saved (non-owner) partner visible so nothing changes silently');
    await sel('viaPartner', sam); await submit();
    await ev(async () => { const p = S.properties.find((x) => x.name === 'Oak'); p.owners = [{ partnerId: p.owners[0].partnerId, pct: 50 }, p.owners[1]]; await save('properties', p); render(); });
    await go('#/check');
    ok((await page.textContent('#main')).includes('No problems found'), 'all problems fixed');

    section('Partner merge moves everything');
    await go('#/partners');
    await page.click('#topActions button');
    await fill('name', 'Amit'); answers.push(true); await submit();
    const amit2 = await ev(() => S.partners.filter((p) => p.name === 'Amit').at(-1).id);
    await ev(async (id) => {
      const m = S.properties.find((x) => x.name === 'Maple');
      m.owners = m.owners.map((o) => (partnerName(o.partnerId) === 'Amit' ? { ...o, partnerId: id } : o)); await save('properties', m);
      await save('txns', { id: 'split1', kind: 'expense', date: '2026-09-07', amount: 90, category: 'Other expense', propertyId: m.id, via: { t: 'p', id }, split: [{ partnerId: id, pct: 50 }, { partnerId: S.partners.find((p) => p.name === 'Amit').id, pct: 50 }] });
    }, amit2);
    await go('#/partners');
    ok((await page.textContent('#main')).includes('duplicate name'), 'partners list marks the duplicate name');
    await page.click(`[data-act=editPartner][data-id="${amit2}"]`);
    await page.click('#merge');
    await sel('to', a);
    answers.push(true); await submit();
    const mm = await ev(() => ({ names: S.partners.map((p) => p.name).sort(), maple: S.properties.find((x) => x.name === 'Maple').owners.map((o) => [partnerName(o.partnerId), o.pct]), t: byId('txns', 'split1') }));
    eq(mm.names, ['Amit', 'Raj', 'Sam', 'Viraj'], 'duplicate Amit merged');
    eq(mm.maple, [['Viraj', 33.34], ['Raj', 33.33], ['Amit', 33.33]], 'Maple ownership points at the kept Amit');
    eq([mm.t.via.id === a, mm.t.split], [true, [{ partnerId: a, pct: 100 }]], 'entry payer and split merged (50%+50% → 100%)');

    section('Other entry types still work');
    await openNewTxn();
    await sel('kind', 'transfer');
    const accs = await ev(() => S.accounts.map((x) => x.id));
    await sel('accountId', accs[0]); await sel('toAccountId', accs[1]); await fill('amount', 100);
    await submit();
    eq(await ev((ids) => ids.map(accountBalance), accs), [900, -400], 'transfer moved 100 between accounts');
    await openNewTxn();
    await sel('kind', 'settlement');
    await sel('propertyId', maple);
    eq(await page.$$eval(`${sheet} [name=partnerId] option`, (o) => o.map((x) => x.textContent)), ['Choose…', 'Viraj (me)', 'Raj', 'Amit'], 'settlement lists Maple owners');
    const plan = await ev(() => { const m = S.properties.find((x) => x.name === 'Maple'); return settlePlan(partnerPositions(S.txns.filter((t) => t.propertyId === m.id)).pos); });
    for (const x of plan) {
      await ev((x) => txnForm(null, { kind: 'settlement', partnerId: x.from, toPartnerId: x.to, amount: x.amount, propertyId: S.properties.find((p) => p.name === 'Maple').id }), x);
      await page.waitForSelector(`${sheet} [name=toPartnerId]`);
      await submit();
    }
    eq(await positions('Maple'), {}, 'recording the suggested settlements clears Maple balances');
    await openNewTxn();
    await sel('kind', 'deposit_in');
    await sel('propertyId', maple);
    await sel('leaseId', await ev(() => S.leases[0].id));
    ok(await page.$(`${sheet} [name=viaMode]`), 'deposit form has the common/partner choice');
    await fill('amount', 1500); await submit();
    eq(await ev(() => leaseStats(S.leases[0]).depHeld), 1500, 'deposit received recorded');
    await ev(() => ACTIONS.rent({ id: S.leases[0].id, period: '2026-09' }));
    await page.waitForSelector(`${sheet} [name=viaAcc]`);
    eq(await page.$eval(`${sheet} [name=viaAcc]`, (e) => e.value), macc.id, 'rent payment from the rent roll defaults to the Maple account');
    await submit();
    eq(await ev(() => rentStatus(S.leases[0], '2026-09').state), 'paid', 'rent marked paid');

    section('Excel export & backup/restore round trip');
    ok(await ev(async () => (await Xlsx.build(buildWorkbookSheets())).size > 5000), 'Excel workbook builds');
    const snapshot = await ev(() => JSON.stringify(DATA_STORES.map((s) => S[s].length)));
    await go('#/data');
    await page.click('[data-act=backup]');
    await page.waitForSelector('#doShare');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#doShare')]);
    const zipPath = path.join(require('os').tmpdir(), 'el-backup.zip');
    await dl.saveAs(zipPath);
    await ev(async () => { await DB.clearAll(); await loadAll(); location.hash = '#/data'; render(); });
    eq(await ev(() => S.txns.length), 0, 'data erased');
    answers.push(true);
    await page.setInputFiles('#restoreFile', zipPath);
    await page.waitForTimeout(800);
    eq(await ev(() => JSON.stringify(DATA_STORES.map((s) => S[s].length))), snapshot, 'restore brings back every record');
    eq(await ev(() => [S.accounts.find((x) => x.name === 'Maple account').propertyId === S.properties.find((p) => p.name === 'Maple').id, !!S.txns.find((t) => t.handledBy)]), [true, true], 'new fields (account property, collected by) survive backup/restore');
    eq(await positions('Maple'), {}, 'balances identical after restore');

    section('Ledger filter by partner includes what they collected');
    await go('#/ledger?v=p:' + r);
    ok((await page.textContent('#main')).includes('September rent'), 'filtering the ledger by Raj shows the rent Raj collected');
    const xl = await ev(() => ledgerSheet(S.txns));
    ok(xl.columns.some((c) => c.header === 'Collected / paid by') && xl.rows.some((row) => Array.isArray(row) && row.includes('Raj') && row.includes('September rent — Zelle from tenant')), 'Excel ledger has the collected-by column');

    section('Entry not tied to a property');
    await openNewTxn();
    await sel('kind', 'expense');
    await sel('propertyId', '');
    eq(await page.$$eval(`${sheet} [name=viaAcc] option`, (o) => o.map((x) => x.textContent)), ['Common account (new — created when you save)', 'Maple account (Maple)', 'Oak account (Oak)'], 'all accounts offered when no property is chosen');
    await sel('viaAcc', macc.id);
    eq(await page.$eval(`${sheet} [name=propertyId]`, (e) => e.value), maple, 'choosing a property account fills in its property');
    await sel('propertyId', '');
    eq(await page.$eval(`${sheet} [name=propertyId]`, (e) => e.value), '', 'property can still be cleared on purpose');
    await page.click('#sheetClose');

    section('Solo owner (no partners, no accounts)');
    const saved = await ev(() => { const d = {}; for (const s of DATA_STORES) d[s] = S[s]; return JSON.stringify(d); });
    await ev(async () => { await DB.clearAll(); await loadAll(); location.hash = '#/home'; render(); });
    await ev(async () => { await save('properties', { id: 'solo', name: 'Solo', owners: [{ partnerId: selfPartner().id, pct: 100 }] }); render(); });
    await go('#/property/solo');
    await page.click('[data-act=newTxn][data-kind=income]');
    await page.waitForSelector(`${sheet} [name=viaMode]`);
    eq(await page.$eval(`${sheet} [name=viaMode]:checked`, (e) => e.value), 'p', 'solo owner with no account defaults to themselves (no account clutter)');
    await fill('amount', 100); await submit();
    eq(await ev(() => [S.txns.length, S.accounts.length]), [1, 0], 'saved without creating an account');
    eq(await positions('Solo'), {}, 'solo owner owes nobody');
    await ev(async (d) => { await DB.replaceAll({ ...JSON.parse(d), settings: [{ id: 'main', ...S.settings }] }); await loadAll(); }, saved);

    section('Pages render without errors');
    for (const hsh of ['#/home', '#/properties', '#/property/' + maple, '#/unit/' + (await ev(() => S.units[0].id)), '#/rentals', '#/rentals/leases', '#/rentals/tenants', '#/lease/' + (await ev(() => S.leases[0].id)), '#/tenant/' + (await ev(() => S.tenants[0].id)), '#/ledger', '#/partners', '#/accounts', '#/documents', '#/reports', '#/more', '#/data', '#/settings', '#/help', '#/check']) {
      await go(hsh);
      const t = await page.textContent('#title');
      ok(t !== 'Error' && !(await page.textContent('#main')).includes('Something went wrong'), 'renders ' + hsh);
    }
    const wide = await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(wide, 'no horizontal scrolling at phone width');
    eq(errors, [], 'no JavaScript errors in the console');
  } catch (e) {
    failed++; fails.push('CRASH: ' + e.message); console.error(e);
    try { await page.screenshot({ path: path.join(require('os').tmpdir(), 'el-fail.png') }); } catch { /* ignore */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('Failures:\n - ' + fails.join('\n - '));
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
