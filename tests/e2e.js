'use strict';
/* Browser QA: XSS, mobile overflow, console errors, staff permissions, locked quotes, total parity.
   Usage: BASE=http://127.0.0.1:8766 node tests/e2e.js     (needs Playwright; see tests/run.sh) */
const { chromium } = require('playwright');
const { totp } = require('./helpers');
let axeSrc = null; try { axeSrc = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) { /* accessibility gate is skipped when axe-core is not installed */ }

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
const XSS = '"><img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ok   ' + m); } else { failed++; console.log('  FAIL ' + m); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; let dialogs = 0;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => { if (d.type() === 'alert') dialogs++; d.accept(); });
  const api = async (method, route, body) => {
    const r = await page.request.fetch(`${BASE}/api/index.php?r=${route}`, { method, headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, data: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (e) { /* ignore */ }
    return { status: r.status(), data: d };
  };
  const go = async h => { await page.goto(BASE + '/index.html' + h); await page.waitForTimeout(700); };

  console.log(`E2E against ${BASE}`);
  await page.goto(BASE + '/index.html');
  await page.fill('input[name=email]', ADMIN.email); await page.fill('input[name=password]', ADMIN.password); await page.click('button.btn.pri');
  await page.waitForSelector('.side');

  /* ---------- seed hostile data ---------- */
  console.log('\nXSS: hostile text in every field');
  const sec = t => ({ title: t, items: [{ desc: XSS, unit: XSS, qty: 2, rate: 100, cost: 50 }], images: [] });
  const q = await api('POST', 'quotes', {
    division: 'roofing', client: { name: XSS, contact_person: XSS, phone: XSS, email: XSS, address: XSS, gstin: XSS }, title: XSS,
    data: { sections: [sec(XSS)], options: [{ name: XSS, note: XSS, sections: [sec(XSS)] }, { name: 'B', note: '', sections: [sec('B')] }], discount: { type: 'percent', value: 0 }, tax_rate: 18,
      payment_schedule: [{ label: XSS, percent: 100 }], terms: [XSS], notes: XSS, scope: XSS, site_address: XSS, hsn: XSS, source: XSS },
  });
  ok(q.status === 201, 'hostile quote saved (' + q.status + ')');
  const qid = q.data.id;
  await api('POST', 'clients', { name: XSS, contact_person: XSS, address: XSS });
  await api('POST', 'rates', { division: 'roofing', category: XSS, name: XSS, unit: XSS, rate: 5, description: XSS });
  await api('POST', 'templates', { name: XSS, division: 'roofing', data: { sections: [sec(XSS)] } });
  await api('POST', 'users', { name: XSS, email: `x${Date.now()}@example.com`, password: 'password123', role: 'staff' });
  const share = (await api('POST', `quotes/${qid}/share`)).data.token;
  // accept via API so we can build a project from it
  await api('PUT', 'settings', { auto_project: '0' });   // this test creates the project by hand
  await page.request.fetch(`${BASE}/api/public.php?r=respond&t=${share}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, data: JSON.stringify({ action: 'accept', name: XSS, note: XSS, option: 0, expected_total: 2 * 100 * 1.18 * 1 + 0, signature: '' }) }).catch(() => {});
  // the line above may be refused if the expected total differs; compute it properly
  const cur = (await api('GET', `quotes/${qid}`)).data.quote;
  if (cur.status !== 'accepted') {
    await page.request.fetch(`${BASE}/api/public.php?r=respond&t=${share}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, data: JSON.stringify({ action: 'accept', name: XSS, note: XSS, option: 0, expected_total: cur.total }) });
  }
  const proj = await api('POST', 'projects', { quote_id: qid });
  const pid = proj.data && proj.data.id;
  if (pid) {
    const det = (await api('GET', `projects/${pid}`)).data;
    await api('PUT', `projects/${pid}`, { name: XSS, status: 'active', notes: XSS });
    await api('POST', `projects/${pid}/variations`, { title: XSS, note: XSS, amount: 1000 });
    await api('POST', `projects/${pid}/log`, { text: XSS, progress: 10 });
    await api('POST', `projects/${pid}/receipts`, { milestone_id: det.milestones[0].id, amount: 10, reference: XSS, mode: XSS, note: XSS });
    await api('POST', `projects/${pid}/milestones/${det.milestones[0].id}/invoice`);
    var invMid = det.milestones[0].id;
  }
  ok(!!pid, 'hostile project created');

  const pages = ['#/dashboard', '#/quotes', `#/quotes/${qid}`, `#/quotes/${qid}/print`, '#/clients', '#/rates', '#/projects', `#/projects/${pid}`, `#/projects/${pid}/invoice/${invMid}`, '#/reports', '#/settings'];
  for (const h of pages) {
    await go(h);
    if (h === '#/rates') { await page.click('[data-act=tab][data-d=roofing]').catch(() => {}); }
    const x = await page.evaluate(() => window.__xss);
    ok(x === undefined && dialogs === 0, `no script execution on ${h}`);
  }
  await page.goto(`${BASE}/view.html?t=${share}`); await page.waitForTimeout(900);
  ok((await page.evaluate(() => window.__xss)) === undefined, 'no script execution on the public client page');
  const share2 = (await api('GET', `quotes/${qid}`)).data.share;
  ok(!!share2, 'public link still resolves');

  /* ---------- all pages load without console errors ---------- */
  console.log('\nConsole errors');
  ok(errors.length === 0, 'no JavaScript errors across all pages' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));

  /* ---------- locked accepted quote ---------- */
  console.log('\nLocked quote UI');
  await go(`#/quotes/${qid}`);
  ok((await page.locator('[data-act=save]').count()) === 0, 'accepted quote has no Save button');
  ok((await page.locator('fieldset[disabled]').count()) === 1, 'accepted quote form is read-only');
  ok(/Accepted - locked/.test(await page.textContent('.banner')), 'locked banner shown');
  ok((await page.locator('[data-act=revise]').count()) === 0, 'revision blocked once a project exists');

  /* ---------- total parity browser vs server ---------- */
  console.log('\nTotal parity (browser vs server) on randomised quotes');
  let mismatches = 0; const ids = [];
  for (let i = 0; i < 12; i++) {
    const items = Array.from({ length: 1 + (i % 4) }, (_, k) => ({ desc: 'L' + k, unit: 'nos', qty: Math.round(Math.random() * 5000) / 100, rate: Math.round(Math.random() * 1e6) / 100, cost: 0 }));
    const r = await api('POST', 'quotes', { division: 'interior', client: { name: 'Parity ' + i }, title: 'p', data: { sections: [{ title: 'S', items }], discount: { type: i % 2 ? 'flat' : 'percent', value: i % 2 ? Math.round(Math.random() * 5000) / 100 : [0, 2.5, 7.5, 10][i % 4] }, tax_rate: [5, 12, 18, 28][i % 4], round_off: i % 3 === 0 } });
    ids.push([r.data.id, (await api('GET', `quotes/${r.data.id}`)).data.quote.total]);
  }
  for (const [id, total] of ids) {
    await go(`#/quotes/${id}`);
    const shown = (await page.textContent('#t-total')).replace(/[^0-9.]/g, '');
    if (Math.abs(parseFloat(shown) - total) > 0.005) { mismatches++; console.log(`    mismatch quote ${id}: browser ${shown} server ${total}`); }
  }
  ok(mismatches === 0, 'browser and server totals agree on 12 random quotes');

  /* ---------- mobile layout ---------- */
  console.log('\nMobile layout (390px wide)');
  await page.setViewportSize({ width: 390, height: 844 });
  const lastQuote = ids[0][0];
  const mobile = ['#/dashboard', '#/quotes', `#/quotes/${lastQuote}`, `#/quotes/${lastQuote}/print`, '#/clients', '#/rates', '#/projects', `#/projects/${pid}`, '#/reports', '#/settings'];
  for (const h of mobile) {
    await go(h);
    const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok(over.sw <= over.cw + 1, `no horizontal page scroll on ${h} (${over.sw}/${over.cw})`);
  }
  await page.goto(`${BASE}/view.html?t=${share}`); await page.waitForTimeout(800);
  const pv = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(pv.sw <= pv.cw + 1, `no horizontal scroll on the client page (${pv.sw}/${pv.cw})`);
  await page.setViewportSize({ width: 1280, height: 900 });

  /* ---------- regional language + real PDF ---------- */
  console.log('\nRegional-language labels and PDF output');
  const mkLang = async (lang, n) => (await api('POST', 'quotes', { division: 'roofing', client: { name: 'Lang Co' }, title: 'Lang ' + lang, data: { lang, sections: [{ title: 'S', items: Array.from({ length: n }, (_, i) => ({ desc: 'Line ' + i + ' supply and fixing of material as per specification and drawing', unit: 'sq ft', qty: 10 + i, rate: 50 + i })) }], tax_rate: 18, payment_schedule: [{ label: 'All', percent: 100 }] } })).data;
  const ta = await mkLang('ta', 5), big = await mkLang('', 70);
  await go(`#/quotes/${ta.id}/print`);
  const taText = await page.textContent('.doc'); ok(/விலைப்புள்ளி/.test(taText) && /QUOTATION/.test(taText), 'Tamil label printed with the English one underneath');
  const pdf1 = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }); ok(pdf1.slice(0, 5).toString() === '%PDF-' && pdf1.length > 20000, 'a real PDF is produced (' + pdf1.length + ' bytes)');
  await go(`#/quotes/${big.id}/print`); const pdf2 = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }); const pdfPages = (pdf2.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length; ok(pdfPages >= 3, `a 70-line quote paginates over several A4 pages (${pdfPages})`);
  const noOverflow = await page.evaluate(() => { const d = document.querySelector('.doc'); return d.scrollWidth <= d.clientWidth + 1; }); ok(noOverflow, 'the quotation fits its page width');

  /* ---------- lists at volume ---------- */
  console.log('\nPagination in the UI');
  for (let i = 0; i < 55; i++) await api('POST', 'clients', { name: 'Bulk Client ' + String(i).padStart(3, '0'), phone: '90000' + String(i).padStart(5, '0') });
  for (let i = 0; i < 55; i++) await api('POST', 'quotes', { division: 'pmc', client: { name: 'Bulk Client 000' }, title: 'Bulk quote ' + i, data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 1, rate: 1 }] }] } });
  await go('#/quotes'); await page.waitForSelector('#ql table');
  const rows1 = await page.locator('#ql tbody tr').count(); ok(rows1 === 50, 'quotes list shows 50 rows first (' + rows1 + ')'); ok(/Showing 50 of \d+/.test(await page.textContent('#ql')), 'shows how many exist');
  await page.click('#qmore'); await page.waitForTimeout(600); ok((await page.locator('#ql tbody tr').count()) > 50, '"Load more" appends the next page');
  await go('#/clients'); await page.waitForSelector('#cb tr'); ok((await page.locator('#cb tr').count()) === 50, 'clients list pages at 50'); await page.fill('#cs', 'Bulk Client 04'); await page.waitForTimeout(700);
  const found = await page.locator('#cb tr').count(); ok(found >= 1 && found <= 12, 'client search narrows the list on the server (' + found + ')');

  /* ---------- two-step sign-in through the real UI ---------- */
  console.log('\nTwo-step sign-in (UI)');
  const tfEmail = `ui2fa${Date.now()}@example.com`; await api('POST', 'users', { name: 'UI Two Factor', email: tfEmail, password: 'password123', role: 'staff' });
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const tp = await tctx.newPage(); tp.on('dialog', d => d.accept('password123'));
  await tp.goto(BASE + '/index.html'); await tp.fill('input[name=email]', tfEmail); await tp.fill('input[name=password]', 'password123'); await tp.click('#lf button.pri'); await tp.waitForSelector('.side');
  await tp.goto(BASE + '/index.html#/settings'); await tp.click('[data-tf=on]'); await tp.waitForSelector('#tfc'); const secret = (await tp.locator('#tfa code').textContent()).replace(/\s/g, '');
  await tp.fill('#tfc', totp(secret)); await tp.click('#tfv'); await tp.waitForSelector('text=Two-step sign-in is on'); ok((await tp.locator('.modal pre').textContent()).trim().split('\n').length === 8, '8 recovery codes shown once'); await tp.click('#rc3');
  await tp.click('text=Sign out'); await tp.waitForSelector('#lf'); await tp.fill('input[name=email]', tfEmail); await tp.fill('input[name=password]', 'password123'); await tp.click('#lf button.pri'); await tp.waitForSelector('#codebox', { state: 'visible' }); ok(true, 'the code box appears after the password');
  await tp.fill('input[name=code]', totp(secret, Date.now(), 1)); await tp.click('#lf button.pri'); await tp.waitForSelector('.side'); ok(true, 'signed in with the authenticator code');
  await tctx.close();

  /* ---------- accessibility gate ---------- */
  console.log('\nAccessibility (axe-core, WCAG 2 A/AA)');
  if (axeSrc) {
    const a11y = async label => { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, `${label}: no serious/critical issues` + (bad.length ? ' - ' + bad.map(v => v.id + ' (' + v.nodes[0].target.join(' ') + ')').join('; ') : '')); };
    for (const [label, h] of [['dashboard', '#/dashboard'], ['quotes', '#/quotes'], ['editor', `#/quotes/${ta.id}`], ['print view', `#/quotes/${ta.id}/print`], ['clients', '#/clients'], ['rate cards', '#/rates'], ['projects', '#/projects'], ['project detail', `#/projects/${pid}`], ['reports', '#/reports'], ['settings', '#/settings']]) { await go(h); await a11y(label); }
  } else console.log('  skip axe-core not installed (npm i axe-core)');

  console.log('\nQuick roofing quote dialog');
  await go('#/dashboard'); await page.waitForSelector('#quickroof'); await page.click('#quickroof'); await page.waitForSelector('#qrf');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'quick-quote dialog: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id).join(', ') : '')); }
  await page.fill('input[name=client_name]', 'Browser Quick Co'); await page.fill('input[name=length_ft]', '60'); await page.fill('input[name=width_ft]', '30');
  await page.click('#qrf button.pri'); await page.waitForFunction(() => /#\/quotes\/\d+/.test(location.hash), null, { timeout: 8000 });
  ok(/#\/quotes\/\d+/.test(page.url()), 'quick quote opens the new draft');
  await go('#/dashboard'); await page.waitForSelector('#quickroof'); await page.click('#quickroof'); await page.waitForSelector('#qrf');
  await page.click('#qsvc label:has(input[value=interior])'); await page.waitForSelector('select[name=bhk]');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'interior quick-quote form: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id).join(', ') : '')); }
  await page.fill('input[name=client_name]', 'Browser Interior Co'); await page.click('#qrf button.pri'); await page.waitForFunction(() => /#\/quotes\/\d+/.test(location.hash), null, { timeout: 8000 });
  ok(/#\/quotes\/\d+/.test(page.url()), 'interior quick quote opens the new draft');
  await go('#/dashboard'); await page.waitForSelector('#quickroof'); await page.click('#quickroof'); await page.waitForSelector('#qrf');
  await page.click('#qsvc label:has(input[value=interior])'); await page.check('#qroomsOn'); await page.waitForSelector('.qroom');
  ok((await page.locator('.qroom').count()) === 4, 'room-by-room starts with 4 sample rooms'); await page.click('#qaddroom'); ok((await page.locator('.qroom').count()) === 5, 'rooms can be added');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'room-by-room form: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id).join(', ') : '')); }
  await page.locator('.qroom').last().locator('.qr-l').fill('10'); await page.locator('.qroom').last().locator('.qr-w').fill('10');
  await page.fill('input[name=client_name]', 'Browser Rooms Co'); await page.click('#qrf button.pri'); await page.waitForFunction(() => /#\/quotes\/\d+/.test(location.hash), null, { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('input,textarea')].some(e => /Living \(15 x 12 ft\)/.test(e.value)) || /Living \(15 x 12 ft\)/.test(document.body.innerText), null, { timeout: 8000 }); ok(true, 'room-by-room quote shows one section per room');
  await go('#/dashboard'); await page.waitForSelector('#quickroof'); await page.click('#quickroof'); await page.waitForSelector('#qrf');
  await page.click('#qsvc label:has(input[value=construction])'); await page.fill('input[name=built_up_sqft]', '1800'); await page.check('input[name=detailed]');
  await page.fill('input[name=client_name]', 'Browser BOQ Co'); await page.click('#qrf button.pri'); await page.waitForFunction(() => /#\/quotes\/\d+/.test(location.hash), null, { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('input,textarea')].some(e => /Foundation & RCC structure/.test(e.value)) || /Foundation & RCC structure/.test(document.body.innerText), null, { timeout: 8000 }); ok(true, 'detailed BOQ quote shows itemised sections');

  console.log('\nChange-order approval page, bulk price dialog, revision compare');
  const vid = (await api('POST', `projects/${pid}/variations`, { title: 'Browser extra <b>work</b>', note: 'x', amount: 2500 })).data.id;
  const vlink = (await api('POST', `projects/${pid}/variations/${vid}/request-approval`, {})).data.link;
  await page.goto(vlink); await page.waitForSelector('#vyes');
  ok(!(await page.content()).includes('<b>work</b></h3>'), 'change-order title is escaped (no HTML injection)');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'approval page: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id + ' (' + v.nodes.map(n => n.target.join(' ') + ' ' + (n.any[0] && n.any[0].message || '')).slice(0, 3).join('; ') + ')').join(', ') : '')); }
  await page.fill('#vn', 'Browser Client'); await page.click('#vyes'); await page.waitForSelector('text=Approved', { timeout: 8000 }); ok(true, 'client can approve a change order in the browser');
  await go('#/rates'); await page.waitForSelector('[data-act=bulk]'); await page.click('[data-act=bulk]'); await page.waitForSelector('#bpf');
  await page.fill('input[name=percent]', '3'); await page.waitForFunction(() => /will change/.test(document.querySelector('#bpn').textContent), null, { timeout: 5000 }); ok(true, 'bulk price dialog previews how many items change');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'bulk price dialog: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id).join(', ') : '')); }
  await page.click('#bpx');
  const rvr = await api('POST', `quotes/${ta.id}/revise`); if (rvr.status !== 201) console.log('  note: revise returned', rvr.status, JSON.stringify(rvr.data).slice(0, 200)); const rev1 = rvr.data; await go(`#/quotes/${rev1.id}`); await page.waitForSelector('[data-act=cmp]'); await page.click('[data-act=cmp]'); await page.waitForSelector('#cmpx');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'revision compare: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id + ' (' + v.nodes.map(n => n.target.join(' ') + ' ' + (n.any[0] && n.any[0].message || '').slice(0, 110)).slice(0, 3).join('; ') + ')').join(', ') : '')); }
  await page.click('#cmpx');

  console.log('\nClient portal page');
  await api('POST', `projects/${pid}/log`, { text: 'Update <img src=x onerror=window.__pwn=1> with photo', progress: 40, photos: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='] });
  const plink = (await api('POST', `projects/${pid}/portal`, {})).data.link;
  await page.goto(plink); await page.waitForSelector('.bar'); await page.waitForSelector('img.lth');
  ok(!(await page.evaluate(() => window.__pwn)), 'portal text is escaped (no script injection)');
  ok(await page.evaluate(() => document.querySelector('img.lth').naturalWidth > 0), 'site photo loads through the portal');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'portal: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id + ' (' + v.nodes.map(n => n.target.join(' ') + ' ' + (n.any[0] && n.any[0].message || '').slice(0, 110)).slice(0, 3).join('; ') + ')').join(', ') : '')); }
  await page.setViewportSize({ width: 375, height: 800 }); await page.reload(); await page.waitForSelector('.bar');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'portal has no horizontal scroll on a phone'); await page.setViewportSize({ width: 1280, height: 900 });
  await go(`#/projects/${pid}`); await page.waitForSelector('[data-act=portal]'); await page.click('[data-act=portal]'); await page.waitForSelector('#plink');
  if (axeSrc) { await page.evaluate(axeSrc); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })); const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)); ok(bad.length === 0, 'portal dialog: no serious/critical a11y issues' + (bad.length ? ' - ' + bad.map(v => v.id).join(', ') : '')); }
  await page.click('#pcl');

  /* ---------- staff UI ---------- */
  console.log('\nStaff role UI');
  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const sp = await staffCtx.newPage();
  const semail = `staff${Date.now()}@example.com`; await api('POST', 'users', { name: 'Staff Tester', email: semail, password: 'password123', role: 'staff' });
  await sp.goto(BASE + '/index.html'); await sp.fill('input[name=email]', semail); await sp.fill('input[name=password]', 'password123'); await sp.click('button.btn.pri'); await sp.waitForSelector('.side');
  await sp.goto(BASE + '/index.html#/rates'); await sp.waitForTimeout(700);
  ok((await sp.locator('[data-act=new], [data-act=imp], [data-act=edit], [data-act=del]').count()) === 0, 'staff sees no rate-card edit controls');
  await sp.goto(BASE + '/index.html#/settings'); await sp.waitForTimeout(800);
  ok((await sp.locator('#audit').count()) === 0 && (await sp.locator('a[href*="r=backup"]').count()) === 0, 'staff sees no backup / audit log');
  ok((await sp.locator('fieldset[disabled]').count()) >= 1, 'staff settings are read-only');
  await sp.goto(BASE + '/index.html#/quotes/new/interior'); await sp.waitForTimeout(700);
  await sp.fill('[data-b="client.name"]', 'Staff made'); await sp.click('[data-act=save]'); await sp.waitForTimeout(1000);
  ok(/INF\/IN/.test(await sp.textContent('.page-head')), 'staff can create a quote');

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
