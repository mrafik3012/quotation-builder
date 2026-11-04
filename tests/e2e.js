'use strict';
/* Browser QA: XSS, mobile overflow, console errors, staff permissions, locked quotes, total parity.
   Usage: BASE=http://127.0.0.1:8766 node tests/e2e.js     (needs Playwright; see tests/run.sh) */
const { chromium } = require('playwright');

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
