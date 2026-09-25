/* End-to-end tests for bulk import (More › Import transactions).
   Run:  NODE_PATH=$(npm root -g) node tests/import.cjs      (needs `npm i -g playwright`)
   If LibreOffice (soffice) is installed, the template is also opened and re-saved by it. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'el-import-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

let passed = 0, failed = 0;
const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; fails.push(m); console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (n) => console.log('\n' + n);
const unzipText = (file, member) => execFileSync('unzip', ['-p', file, member]).toString();

(async () => {
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const answers = [];
  page.on('dialog', async (d) => { const a = answers.length ? answers.shift() : undefined; if (a === false) return d.dismiss(); return typeof a === 'string' ? d.accept(a) : d.accept(); });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const go = async (h) => { await ev((x) => { location.hash = x; }, h); await page.waitForTimeout(150); };
  // build an .xlsx in the page with the app's own writer and save it to disk
  const writeXlsx = async (file, columns, rows) => {
    const b64 = await ev(async ([columns, rows]) => {
      const blob = await Xlsx.build([{ name: 'Transactions', columns: columns.map((h) => ({ header: h, type: h === 'Date' ? 'date' : undefined })), rows }]);
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s);
    }, [columns, rows]);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  };
  const chooseFile = async (file) => {
    await go('#/import');
    if (await page.$('#topActions button')) { await page.click('#topActions button'); await page.waitForTimeout(100); }
    await page.setInputFiles('#impFile', file);
    await page.waitForSelector('#impGo');
  };
  const summary = async () => ev(() => { const s = [...document.querySelectorAll('.stats .stat .v')].map((e) => +e.textContent); return { ready: s[0], bad: s[1], dup: s[2] }; });
  const doImport = async () => { answers.push(true); await page.click('#impGo'); await page.waitForTimeout(400); };
  const soffice = (() => { try { execFileSync('which', ['soffice']); return true; } catch { return false; } })();

  try {
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForSelector('text=Welcome');

    section('Parsing helpers');
    const dates = await ev(() => [
      parseImportDate('2025-03-01'), parseImportDate('2025/3/1'), parseImportDate('01/03/2025', 'dmy'), parseImportDate('01/03/2025', 'mdy'),
      parseImportDate('31.12.24', 'dmy'), parseImportDate('1 Mar 2025'), parseImportDate('01-Mar-25'), parseImportDate('March 1st, 2025'), parseImportDate('Mar 1, 2025'),
      parseImportDate(45717), parseImportDate('2025-02-30'), parseImportDate('13/13/2025', 'dmy'), parseImportDate('hello'), parseImportDate('2025-03-01 10:22:00'),
    ]);
    eq(dates, ['2025-03-01', '2025-03-01', '2025-03-01', '2025-01-03', '2024-12-31', '2025-03-01', '2025-03-01', '2025-03-01', '2025-03-01', '2025-03-01', '', '', '', '2025-03-01'], 'dates in many formats (and invalid ones rejected)');
    eq(await ev(() => [parseImportAmount('$1,500.00'), parseImportAmount('(200)'), parseImportAmount('-75.5'), parseImportAmount('200 DR'), parseImportAmount('1.234,56'), parseImportAmount('12,5'), parseImportAmount('₹ 12,34,567'), parseImportAmount(99), isNaN(parseImportAmount('abc'))]),
      [1500, -200, -75.5, -200, 1234.56, 12.5, 1234567, 99, true], 'amounts with symbols, commas, brackets, DR, European decimals');
    eq(await ev(() => [parseImportMonth('2025-03'), parseImportMonth('03/2025'), parseImportMonth('Mar 2025'), parseImportMonth('March-25'), parseImportMonth(45717)]), ['2025-03', '2025-03', '2025-03', '2025-03', '2025-03'], 'rent month formats');
    eq(await ev(() => [detectDateOrder(['31/01/2025', '01/02/2025']).order, detectDateOrder(['01/31/2025']).order, detectDateOrder(['2025-01-01']).sure, detectDateOrder(['01/02/2025']).sure]), ['dmy', 'mdy', true, false], 'day/month order detection');
    eq(await ev(() => parseCsv('a;b;c\n"x;1";"he said ""hi""";3\r\n4;5;6')), [['a', 'b', 'c'], ['x;1', 'he said "hi"', '3'], ['4', '5', '6']], 'CSV with semicolons, quotes and CRLF');
    eq(await ev(() => parseCsv('﻿Date,Amount\n2025-01-01,"1,000"\n')), [['Date', 'Amount'], ['2025-01-01', '1,000']], 'CSV with BOM and quoted commas');

    section('Setup');
    await ev(async () => {
      const me = selfPartner(); me.name = 'Viraj'; await save('partners', me);
      await save('partners', { id: 'raj', name: 'Raj' }); await save('partners', { id: 'amit', name: 'Amit' }); await save('partners', { id: 'sam', name: 'Sam' });
      await save('properties', { id: 'maple', name: 'Maple', owners: [{ partnerId: me.id, pct: 34 }, { partnerId: 'raj', pct: 33 }, { partnerId: 'amit', pct: 33 }] });
      await save('properties', { id: 'oak', name: 'Oak', owners: [{ partnerId: me.id, pct: 50 }, { partnerId: 'sam', pct: 50 }] });
      await save('units', { id: 'ua', propertyId: 'maple', name: 'Unit A' }); await save('units', { id: 'ub', propertyId: 'maple', name: 'Unit B' }); await save('units', { id: 'om', propertyId: 'oak', name: 'Main' });
      await save('accounts', { id: 'macc', name: 'Maple account', propertyId: 'maple', owners: [{ partnerId: me.id, pct: 34 }, { partnerId: 'raj', pct: 33 }, { partnerId: 'amit', pct: 33 }], openingBalance: 0 });
      await save('accounts', { id: 'joint', name: 'Joint savings', propertyId: 'maple', owners: [{ partnerId: me.id, pct: 50 }, { partnerId: 'raj', pct: 50 }], openingBalance: 1000 });
      await save('tenants', { id: 'john', name: 'John Smith' }); await save('tenants', { id: 'mary', name: 'Mary Jones' });
      await save('leases', { id: 'l_john_old', unitId: 'ub', tenantId: 'john', startDate: '2024-01-01', endDate: '2024-12-31', status: 'ended', rent: 1400, dueDay: 1 });
      await save('leases', { id: 'l_john', unitId: 'ua', tenantId: 'john', startDate: '2025-01-01', status: 'active', rent: 1500, dueDay: 1 });
      await save('leases', { id: 'l_mary', unitId: 'om', tenantId: 'mary', startDate: '2025-01-01', status: 'active', rent: 1200, dueDay: 5 });
      await save('txns', { id: 'existing1', kind: 'expense', date: '2025-01-10', amount: 250, category: 'Repairs & maintenance', propertyId: 'maple', via: { t: 'a', id: 'macc' } });
      render();
    });
    ok(true, 'partners, properties, units, accounts, tenants and leases created');

    section('Template with dropdowns');
    await go('#/more');
    ok((await page.textContent('#main')).includes('Import transactions'), 'More menu has “Import transactions”');
    await go('#/import');
    await page.click('[data-act=importTemplate]');
    await page.waitForSelector('#doShare');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#doShare')]);
    const tpl = path.join(TMP, 'template.xlsx');
    await dl.saveAs(tpl);
    ok(dl.suggestedFilename() === 'EstateLedger_import_template.xlsx', 'template file name');
    const wb = unzipText(tpl, 'xl/workbook.xml');
    ok(/name="Transactions"/.test(wb) && /name="How to fill"/.test(wb) && /name="Lists"[^>]*state="hidden"/.test(wb), 'sheets: Transactions, How to fill, hidden Lists');
    const s1 = unzipText(tpl, 'xl/worksheets/sheet1.xml');
    const dv = [...s1.matchAll(/<dataValidation [^>]*sqref="([A-Z]+)2:[A-Z]+1001"><formula1>([^<]*)<\/formula1>/g)].map((m) => [m[1], m[2]]);
    const dvCols = dv.map((x) => x[0]);
    eq(dvCols, ['B', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'], 'dropdowns on Type, Property, Unit, Tenant, Category, Rent month, Paid from, Collected by, Partner, To partner, Account, To account');
    const f = Object.fromEntries(dv);
    ok(f.B.includes('Income') && f.B.includes('Partner took money out'), 'Type dropdown has friendly type names');
    eq(f.D, '"Maple,Oak"', 'Property dropdown lists the properties (inline list)');
    ok(f.E.includes('Maple › Unit A') && f.E.includes('Oak › Main'), 'Unit dropdown shows “Property › Unit”');
    ok(f.F.includes('John Smith · Maple › Unit A') && f.F.includes('(ended)'), 'Tenant dropdown shows tenant · property › unit, marks ended leases');
    ok(/^Lists!\$[A-Z]\$2:\$[A-Z]\$\d+$/.test(f.G), 'long Category list points at the hidden Lists sheet: ' + f.G);
    ok(f.I.includes('Maple account') && f.I.includes('Raj (personally)'), 'Paid-from dropdown has accounts and “Name (personally)”');
    ok(/errorStyle="warning"[^>]*sqref="G2/.test(s1) && /errorStyle="stop"[^>]*sqref="B2/.test(s1), 'Category allows your own words; Type must be from the list');
    const lists = unzipText(tpl, 'xl/worksheets/sheet3.xml');
    ok(lists.includes('Repairs &amp; maintenance') && lists.includes('Mortgage / loan EMI'), 'Lists sheet holds the categories');
    if (soffice) {
      execFileSync('soffice', ['--headless', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(TMP, 'lo'), tpl], { stdio: 'ignore', timeout: 120000 });
      const lo = path.join(TMP, 'lo', 'template.xlsx');
      const loS1 = unzipText(lo, 'xl/worksheets/sheet1.xml');
      ok((loS1.match(/<dataValidation /g) || []).length >= 12, 'LibreOffice opens the template and keeps all the dropdowns');
    } else console.log('  (LibreOffice not installed — skipped the round trip)');

    section('Import a filled-in template');
    const H = ['Date', 'Type', 'Amount', 'Property', 'Unit', 'Tenant / lease', 'Category', 'Rent month', 'Paid from / received into', 'Collected / paid by', 'Partner', 'To partner', 'Account', 'To account', 'Description'];
    const rows = [
      ['2025-02-01', 'Income', 1500, '', '', 'John Smith · Maple › Unit A', 'Rent', '2025-02', '', 'Raj', '', '', '', '', 'Feb rent'],          // 2 lease label → Maple, default account, collected by Raj
      ['2025-03-02', 'Income', 1500, 'Maple', '', 'John Smith', 'Rent', '', 'Maple account', '', '', '', '', '', 'Mar rent'],                // 3 plain tenant → lease by date
      ['2024-06-01', 'Income', 1400, 'Maple', '', 'John Smith', 'Rent', '', 'Raj (personally)', '', '', '', '', '', 'old lease rent'],       // 4 → old lease, Raj kept it
      ['2025-02-03', 'Expense', 1800, 'Maple', '', '', 'Mortgage / loan EMI', '', '', '', '', '', '', '', 'EMI'],                             // 5 default Maple account
      ['2025-02-05', 'Expense', 300, 'Oak', 'Oak › Main', '', 'Insurance', '', '', '', '', '', '', '', ''],                                  // 6 Oak has no account → creates one
      ['2025-02-06', 'Expense', 120, 'Maple', 'Unit B', '', 'repairs & maintenance', '', 'Amit (personally)', '', '', '', '', '', 'plumber'], // 7 category case normalised
      ['2025-01-05', 'Deposit received', 1500, '', '', 'John Smith · Maple › Unit A', '', '', 'Maple account', '', '', '', '', '', ''],      // 8
      ['2025-02-10', 'Deposit kept', 100, '', '', 'John Smith · Maple › Unit A', 'Damages', '', '', '', '', '', '', '', ''],                 // 9
      ['2025-02-11', 'Partner put money in', 5000, '', '', '', '', '', '', '', 'Raj', '', 'Maple account', '', ''],                         // 10 property from account
      ['2025-02-12', 'Partner took money out', 200, 'Maple', '', '', 'Personal use', '', '', '', 'Amit', '', '', '', ''],                   // 11 account defaults to Maple account
      ['2025-02-13', 'Partner paid partner', 50, 'Maple', '', '', '', '', '', '', 'Amit', 'Raj', '', '', ''],                               // 12
      ['2025-02-14', 'Transfer between accounts', 400, '', '', '', '', '', '', '', '', '', 'Maple account', 'Joint savings', ''],           // 13
      ['2025-02-15', 'Incme', 60, 'Mapel', '', '', 'Late fee', '', '', '', '', '', '', '', 'typos'],                                        // 14 fuzzy type & property
      ['not a date', 'Expense', 10, 'Maple', '', '', '', '', '', '', '', '', '', '', ''],                                                   // 15 bad date
      ['2025-02-16', 'Expense', '', 'Maple', '', '', '', '', '', '', '', '', '', '', 'no amount'],                                          // 16 no amount
      ['2025-02-17', 'Deposit received', 500, 'Oak', '', '', '', '', '', '', '', '', '', '', ''],                                           // 17 deposit without lease
      ['2025-01-10', 'Expense', 250, 'Maple', '', '', 'Repairs & maintenance', '', '', '', '', '', '', '', ''],                             // 18 duplicate of existing
      ['2025-02-18', 'Expense', 75, 'Maple', '', '', '', '', 'Bob (personally)', '', '', '', '', '', ''],                                  // 19 unknown partner
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],                                                                        // empty row ignored
    ];
    const f1 = await writeXlsx(path.join(TMP, 'filled.xlsx'), H, rows);
    await chooseFile(f1);
    let sm = await summary();
    eq(sm, { ready: 13, bad: 4, dup: 1 }, 'preview: 13 ready, 4 problems (bad date, no amount, deposit w/o lease, unknown partner), 1 duplicate');
    const matchText = await page.textContent('#main');
    ok(matchText.includes('“Incme”') && matchText.includes('“Mapel”') && matchText.includes('“Bob (personally)”'), 'typos and unknown names are listed under “Match names”');
    eq(await page.$eval('[data-match=type]', (e) => e.value), 'income', '“Incme” pre-selected as Income');
    eq(await page.$eval('[data-match=property]', (e) => e.value), 'maple', '“Mapel” pre-selected as Maple');
    eq(await page.$eval('[data-match=via]', (e) => e.value), '', '“Bob” has no good guess');
    ok(matchText.includes('Can\'t read the date “not a date”') && matchText.includes('Amount is empty') && matchText.includes('Deposits need the tenant / lease'), 'problems explained per row');
    ok(matchText.includes('Will also create: Oak account'), 'says it will create the Oak account');
    // fix "Bob" with the dropdown → pick Sam? Not a Maple owner → still imported with a warning. Pick Raj instead.
    await page.selectOption('[data-match=via]', 'p:raj'); await page.waitForTimeout(200);
    sm = await summary();
    eq(sm, { ready: 14, bad: 3, dup: 1 }, 'choosing “Raj (personally)” for Bob fixes that row');
    // skip duplicates toggle
    await page.uncheck('#impSkipDup'); await page.waitForTimeout(150);
    eq((await summary()).ready, 15, 'unticking “skip duplicates” includes the duplicate');
    await page.check('#impSkipDup'); await page.waitForTimeout(150);
    await page.selectOption('#impFilter', 'bad'); await page.waitForTimeout(150);
    eq(await page.$$eval('.imp-row', (r) => r.length), 3, 'filter shows only the problem rows');
    await page.selectOption('#impFilter', 'all'); await page.waitForTimeout(150);
    ok(await ev(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'preview fits the phone width');
    const before = await ev(() => S.txns.length);
    await doImport();
    ok((await ev(() => location.hash)).startsWith('#/ledger'), 'goes to the ledger after importing');
    const imp = await ev(() => S.txns.filter((t) => t.importId));
    eq([imp.length, (await ev(() => S.txns.length)) - before], [14, 14], '14 entries imported');
    const by = (d) => imp.find((t) => t.description === d);
    const T = (desc) => by(desc);
    eq([T('Feb rent').leaseId, T('Feb rent').propertyId, T('Feb rent').unitId, T('Feb rent').via, T('Feb rent').handledBy, T('Feb rent').period], ['l_john', 'maple', 'ua', { t: 'a', id: 'macc' }, 'raj', '2025-02'], 'rent via lease label: property/unit filled, Maple account, collected by Raj');
    eq([T('Mar rent').leaseId, T('Mar rent').period], ['l_john', '2025-03'], 'plain tenant name picks the lease active on that date');
    eq([T('old lease rent').leaseId, T('old lease rent').via], ['l_john_old', { t: 'p', id: 'raj' }], '2024 rent goes to John\'s old lease; Raj kept it personally');
    eq(T('EMI').via, { t: 'a', id: 'macc' }, 'blank “paid from” = the property\'s account');
    const oakAcc = await ev(() => S.accounts.find((a) => a.name === 'Oak account'));
    ok(oakAcc && oakAcc.propertyId === 'oak', 'Oak account created and linked to Oak');
    eq(T('plumber').category, 'Repairs & maintenance', 'category spelling normalised to the existing one');
    const k = (kind) => imp.filter((t) => t.kind === kind);
    eq(k('deposit_apply')[0].via, { t: 'a', id: 'macc' }, 'deposit kept follows where the deposit was received');
    eq([k('contribution')[0].propertyId, k('contribution')[0].accountId, k('contribution')[0].partnerId], ['maple', 'macc', 'raj'], 'contribution: property taken from the account');
    eq([k('withdrawal')[0].accountId, k('withdrawal')[0].partnerId], ['macc', 'amit'], 'withdrawal: account defaults to the property\'s account');
    eq([k('settlement')[0].partnerId, k('settlement')[0].toPartnerId], ['amit', 'raj'], 'settlement partners');
    eq([k('transfer')[0].accountId, k('transfer')[0].toAccountId], ['macc', 'joint'], 'transfer accounts');
    eq([T('typos').kind, T('typos').propertyId], ['income', 'maple'], 'typos imported with the matched values');
    eq(await ev(() => [accountBalance('macc'), accountBalance('joint')]), [1500 + 1500 - 1800 + 1500 + 5000 - 200 - 400 + 60 - 250, 1400], 'account balances add up');
    await go('#/ledger');
    ok((await page.textContent('#main')).includes('Feb rent'), 'imported entries appear in the ledger with descriptions');

    section('Undo');
    await go('#/import');
    ok((await page.textContent('#main')).includes('filled.xlsx'), 'previous import listed with Undo');
    answers.push(true);
    await page.click('[data-act=undoImport]'); await page.waitForTimeout(300);
    eq(await ev(() => [S.txns.length, S.txns.some((t) => t.importId), !!S.accounts.find((a) => a.name === 'Oak account')]), [before, false, false], 'undo removes every imported entry and the account it created');

    section('Re-import after Undo, then re-importing the same file is caught as duplicates');
    await chooseFile(f1);
    await page.selectOption('[data-match=via]', 'p:raj'); await page.waitForTimeout(150);
    await doImport();
    await chooseFile(f1);
    await page.selectOption('[data-match=via]', 'p:raj'); await page.waitForTimeout(150);
    sm = await summary();
    eq(sm.ready, 0, 'importing the same file twice: nothing new to import (' + JSON.stringify(sm) + ')');
    ok(await page.$eval('#impGo', (b) => b.disabled), 'Import button disabled when nothing is new');

    section('Bank statement CSV (other column names, day/month dates, debit/credit)');
    const csv = 'Posted Date,Details,Debit,Credit,Balance\n' +
      '31/01/2025,"RENT JOHN SMITH, JAN",,"1,500.00",9000\n' +
      '03/03/2025,MORTGAGE PAYMENT,"1,800.00",,7200\n' +
      '04/02/2025,CITY WATER BILL,85.40,,7114.60\n';
    fs.writeFileSync(path.join(TMP, 'bank.csv'), csv);
    await chooseFile(path.join(TMP, 'bank.csv'));
    const cols = await ev(() => IMP.colMap);
    eq([cols.date, cols.description, cols.moneyOut, cols.moneyIn, cols.type], [0, 1, 2, 3, undefined], 'columns matched from bank headings (Posted Date, Details, Debit, Credit)');
    eq(await page.$eval('#impOrder', (e) => e.value), 'dmy', '31/01/2025 → day/month order detected');
    await page.selectOption('#impDefProp', 'maple'); await page.waitForTimeout(150);
    await page.selectOption('#impDefVia', 'a:macc'); await page.waitForTimeout(150);
    eq(await summary(), { ready: 3, bad: 0, dup: 0 }, 'all 3 rows ready');
    await doImport();
    const bank = await ev(() => S.txns.filter((t) => /MORTGAGE|RENT JOHN|WATER/.test(t.description)).map((t) => [t.date, t.kind, t.amount, t.propertyId, t.via.id]).sort());
    eq(bank, [['2025-01-31', 'income', 1500, 'maple', 'macc'], ['2025-02-04', 'expense', 85.4, 'maple', 'macc'], ['2025-03-03', 'expense', 1800, 'maple', 'macc']], 'credits = income, debits = expense, defaults applied');

    section('Signed amounts and column re-mapping with dropdowns');
    fs.writeFileSync(path.join(TMP, 'signed.csv'), 'When;What;Value\n2025-05-01;Gardening;-45,50\n2025-05-02;Parking;20\n');
    await chooseFile(path.join(TMP, 'signed.csv'));
    ok((await page.textContent('#main')).includes('choose Date and Amount'), 'unknown headings: asks to choose the Date and Amount columns');
    eq(await ev(() => IMP.colMap.amount), 2, '“Value” recognised as the amount');
    await page.selectOption('[data-col=date]', '0'); await page.waitForTimeout(100);
    ok(await page.$eval('#impCols', (d) => d.open), 'column section stays open while you are choosing columns');
    await page.selectOption('[data-col=description]', '1'); await page.waitForTimeout(100);
    eq(await summary(), { ready: 2, bad: 0, dup: 0 }, 'after choosing columns both rows are ready');
    await doImport();
    eq(await ev(() => S.txns.filter((t) => ['Gardening', 'Parking'].includes(t.description)).map((t) => [t.kind, t.amount]).sort()), [['expense', 45.5], ['income', 20]], 'negative = expense, positive = income');

    section('Exported ledger can be re-imported (all detected as duplicates)');
    const exp = await ev(async () => {
      const blob = await Xlsx.build([ledgerSheet(S.txns)]);
      const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s);
    });
    fs.writeFileSync(path.join(TMP, 'ledger.xlsx'), Buffer.from(exp, 'base64'));
    await chooseFile(path.join(TMP, 'ledger.xlsx'));
    const n = await ev(() => S.txns.length);
    sm = await summary();
    ok(sm.dup === n && sm.ready === 0, `every exported entry recognised as already in the app (${JSON.stringify(sm)}, ${n} entries)`);

    if (soffice) {
      section('A file saved by LibreOffice (shared strings, compressed)');
      execFileSync('soffice', ['--headless', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(TMP, 'lo2'), f1], { stdio: 'ignore', timeout: 120000 });
      const lo = path.join(TMP, 'lo2', 'filled.xlsx');
      ok(execFileSync('unzip', ['-l', lo]).toString().includes('xl/sharedStrings.xml'), 'LibreOffice file uses shared strings');
      await chooseFile(lo);
      await page.selectOption('[data-match=via]', 'p:raj'); await page.waitForTimeout(150);
      eq(await summary(), { ready: 0, bad: 3, dup: 15 }, 'LibreOffice-saved file reads the same (all already imported)');
      const csvOut = path.join(TMP, 'lo3');
      execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', csvOut, f1], { stdio: 'ignore', timeout: 120000 });
      await chooseFile(path.join(csvOut, 'filled.csv'));
      await page.selectOption('[data-match=via]', 'p:raj'); await page.waitForTimeout(150);
      eq((await summary()).dup, 15, 'same data saved as CSV by LibreOffice reads the same');
    }

    section('Other files');
    fs.writeFileSync(path.join(TMP, 'x.numbers'), 'not really');
    await go('#/import');
    if (await page.$('#topActions button')) { await page.click('#topActions button'); await page.waitForTimeout(100); }
    let alertMsg = '';
    page.once('dialog', (d) => { alertMsg = d.message(); });
    await page.setInputFiles('#impFile', path.join(TMP, 'x.numbers'));
    await page.waitForTimeout(300);
    ok(alertMsg.includes('Excel (.xlsx) or CSV'), 'a Numbers file gets a clear “export as Excel or CSV” message');

    section('Pages & errors');
    for (const h of ['#/import', '#/more', '#/data', '#/ledger']) { await go(h); ok(!(await page.textContent('#main')).includes('Something went wrong'), 'renders ' + h); }
    eq(errors, [], 'no JavaScript errors');
  } catch (e) {
    failed++; fails.push('CRASH: ' + e.message); console.error(e);
    try { await page.screenshot({ path: path.join(TMP, 'fail.png'), fullPage: true }); console.log('screenshot: ' + path.join(TMP, 'fail.png')); } catch { /* ignore */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('Failures:\n - ' + fails.join('\n - '));
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
