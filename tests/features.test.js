'use strict';
/* AMC renewals, site-log photos, document language, pagination, privacy tools. Usage: BASE=... node tests/features.test.js */
const { Client } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const day = n => new Date(Date.now() + n * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

(async () => {
  console.log(`Feature tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  const staff = new Client(BASE); const se = `feat-staff-${Date.now()}@example.com`; await admin.api('POST', 'users', { name: 'S', email: se, password: 'staffpass1', role: 'staff' }); await staff.api('POST', 'auth/login', { email: se, password: 'staffpass1' });
  const mkAccepted = async (name, extra = {}) => {
    const q = (await admin.api('POST', 'quotes', { division: 'roofing', client: { name, phone: '9811122233', email: `${name.replace(/\W/g, '').toLowerCase()}@example.com` }, title: name + ' job', data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 10, rate: 1000 }] }], tax_rate: 18, payment_schedule: [{ label: 'All', percent: 100 }], ...extra } })).data;
    const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; const total = (await admin.api('GET', `quotes/${q.id}`)).data.quote.total;
    await fetch(`${BASE}/api/public.php?r=respond&t=${tok}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', name: 'Buyer', expected_total: total }) });
    return { q, tok, pid: (await admin.api('POST', 'projects', { quote_id: q.id })).data.id };
  };

  console.log('\nAMC / warranty renewals');
  let amcP;
  await test('a project can carry an AMC / warranty end date and note', async () => {
    amcP = await mkAccepted('Amc Co'); const p = (await admin.api('GET', `projects/${amcP.pid}`)).data.project;
    eq((await admin.api('PUT', `projects/${amcP.pid}`, { name: p.name, status: 'active', amc_end: day(20), amc_note: '10-year sheet warranty' })).status, 200);
    const g = (await admin.api('GET', `projects/${amcP.pid}`)).data.project; eq(g.amc_end, day(20)); eq(g.amc_note, '10-year sheet warranty');
  });
  await test('the dashboard lists renewals due in the next 60 days (with the client phone for WhatsApp), not far-future ones', async () => {
    const far = await mkAccepted('Far Away'); await admin.api('PUT', `projects/${far.pid}`, { name: 'Far', status: 'active', amc_end: day(400) });
    const due = (await admin.api('GET', 'dashboard')).data.amc_due; ok(due.some(x => x.id === amcP.pid && x.client_phone === '9811122233'), 'due soon is listed'); ok(!due.some(x => x.id === far.pid), 'far future is not');
  });
  await test('invalid AMC dates are ignored rather than stored', async () => {
    const p = (await admin.api('GET', `projects/${amcP.pid}`)).data.project; await admin.api('PUT', `projects/${amcP.pid}`, { name: p.name, status: 'active', amc_end: 'next tuesday' }); eq((await admin.api('GET', `projects/${amcP.pid}`)).data.project.amc_end, null);
    await admin.api('PUT', `projects/${amcP.pid}`, { name: p.name, status: 'active', amc_end: day(20) });
  });

  console.log('\nSite-log photos');
  await test('a log entry can carry up to 3 photos; junk and oversized images are dropped', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(230000);
    const r = await admin.api('POST', `projects/${amcP.pid}/log`, { text: 'Sheets delivered', progress: 25, photos: [JPG, JPG, 'javascript:alert(1)', big, 'data:image/svg+xml;base64,PHN2Zz4=', JPG, JPG] }); eq(r.status, 201);
    const l = (await admin.api('GET', `projects/${amcP.pid}`)).data.log[0]; eq(l.photos.length, 3, 'max three, only valid jpeg/png under 220 KB'); ok(l.photos.every(p => p === JPG));
  });
  await test('an entry without photos has an empty photo list', async () => { await admin.api('POST', `projects/${amcP.pid}/log`, { text: 'No photos today' }); eq((await admin.api('GET', `projects/${amcP.pid}`)).data.log[0].photos, []); });

  console.log('\nDocument language');
  await test('a quote can be set to a regional language; unknown codes fall back to English', async () => {
    const mk = lang => admin.api('POST', 'quotes', { division: 'interior', client: { name: 'Lang Co' }, title: 't', data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 1, rate: 1 }] }], lang } });
    const a = (await mk('ta')).data; eq((await admin.api('GET', `quotes/${a.id}`)).data.quote.data.lang, 'ta');
    const b = (await mk('xx')).data; eq((await admin.api('GET', `quotes/${b.id}`)).data.quote.data.lang, ''); for (const l of ['hi', 'te', 'kn', 'ml']) { const x = (await mk(l)).data; eq((await admin.api('GET', `quotes/${x.id}`)).data.quote.data.lang, l); }
  });
  await test('the language reaches the client page', async () => {
    const q = (await admin.api('POST', 'quotes', { division: 'interior', client: { name: 'Lang Pub' }, title: 't', data: { lang: 'hi', sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 1, rate: 1 }] }] } })).data;
    const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; eq((await (await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`)).json()).quote.data.lang, 'hi');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
