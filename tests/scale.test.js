'use strict';
/* Pagination, performance budgets at volume, privacy tools, link expiry. Needs APP_DIR (to bulk-load data).
   Usage: APP_DIR=/path/to/app BASE=http://127.0.0.1:8766 node tests/scale.test.js */
const { Client } = require('./helpers');
const { execFileSync } = require('child_process'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8766', APP_DIR = process.env.APP_DIR;
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
const N = parseInt(process.env.SCALE_N || '4000', 10);
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const db = (sql, params = []) => JSON.parse(execFileSync('php', [path.join(__dirname, 'dbtool.php'), APP_DIR, sql, JSON.stringify(params)]).toString());
const timed = async fn => { const t = Date.now(); const r = await fn(); return { ms: Date.now() - t, r }; };

(async () => {
  if (!APP_DIR) { console.log('APP_DIR not set - skipping scale tests'); process.exit(0); }
  console.log(`Scale & privacy tests against ${BASE} (${N} bulk quotes)`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  execFileSync('php', [path.join(__dirname, 'seed_bulk.php'), APP_DIR, String(N)]);

  console.log('\nPagination');
  await test('quotes are paged: stable, no duplicates between pages, correct total, empty beyond the end', async () => {
    const p1 = (await admin.api('GET', 'quotes&per=50&page=1')).data, p2 = (await admin.api('GET', 'quotes&per=50&page=2')).data;
    eq(p1.rows.length, 50); eq(p2.rows.length, 50); ok(p1.total >= N, 'total ' + p1.total); const ids = new Set([...p1.rows, ...p2.rows].map(r => r.id)); eq(ids.size, 100, 'unique rows');
    const last = (await admin.api('GET', `quotes&per=50&page=${Math.ceil(p1.total / 50) + 5}`)).data; eq(last.rows.length, 0);
    const big = (await admin.api('GET', 'quotes&per=100000&page=1')).data; ok(big.rows.length <= 200, 'per is capped at 200');
  });
  await test('filters and search work with pagination and report the filtered total', async () => {
    const all = (await admin.api('GET', 'quotes&per=10')).data.total, sent = (await admin.api('GET', 'quotes&per=10&status=sent')).data; ok(sent.total > 0 && sent.total < all); ok(sent.rows.every(r => r.status === 'sent'));
    const s = (await admin.api('GET', 'quotes&per=10&q=' + encodeURIComponent('Project 1234'))).data; ok(s.total >= 1 && s.rows.some(r => r.title === 'Project 1234'), 'found by title');
  });
  await test('the old un-paged call still works (back-compatible array, capped at 500)', async () => { const r = (await admin.api('GET', 'quotes')).data; ok(Array.isArray(r) && r.length === 500); });
  await test('clients are searchable and paged server-side; bootstrap sends only the 300 most recent', async () => {
    const r = (await admin.api('GET', 'clients&per=25&q=' + encodeURIComponent('Client 777 '))).data; ok(r.total >= 1 && r.rows[0].name.startsWith('Client 777 '), 'search');
    const boot = await admin.api('GET', 'bootstrap'); ok(boot.data.clients.length <= 300, 'bootstrap clients ' + boot.data.clients.length); ok(JSON.stringify(boot.data).length < 300000, 'bootstrap size ' + JSON.stringify(boot.data).length);
  });

  console.log('\nPerformance budgets (generous, to catch accidents - not micro-benchmarks)');
  for (const [label, route, budget] of [['dashboard', 'dashboard', 1500], ['reports', 'reports', 3000], ['quote list page', 'quotes&per=50&page=3', 800], ['quote search', 'quotes&per=50&q=Project%2099', 1500], ['client search', 'clients&per=50&q=Client%2012', 800], ['bootstrap', 'bootstrap', 1500]]) {
    await test(`${label} answers within ${budget} ms with ${N} quotes`, async () => { const { ms, r } = await timed(() => admin.api('GET', route)); eq(r.status, 200); ok(ms < budget, `${ms} ms`); });
  }

  console.log('\nPrivacy: export and erase client data');
  const mkClient = async (name, phone, email) => (await admin.api('POST', 'clients', { name, contact_person: 'Person ' + name, phone, email, address: '1 Test Road', gstin: '29ABCDE1234F1Z5' })).data.id;
  const mkQuote = async (cid, name, extra = {}) => (await admin.api('POST', 'quotes', { division: 'roofing', client_id: cid, client: { name, phone: '9000011111', email: 'pii@example.com', contact_person: 'Pii Person', address: '1 Test Road' }, title: 'Privacy ' + name, data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 1, rate: 1000 }] }], tax_rate: 18, payment_schedule: [{ label: 'All', percent: 100 }], ...extra } })).data;
  const staff = new Client(BASE); const se = `scale-staff-${Date.now()}@example.com`; await admin.api('POST', 'users', { name: 'S', email: se, password: 'staffpass1', role: 'staff' }); await staff.api('POST', 'auth/login', { email: se, password: 'staffpass1' });
  await test('only admins can export or erase client data', async () => { const cid = await mkClient('Priv Staff Test', '9111111111', 'a@x.com'); eq((await staff.api('GET', `clients/${cid}/export`)).status, 403); eq((await staff.api('POST', `clients/${cid}/anonymize`, { confirm: true })).status, 403); });
  await test('export returns the client, quotes, activity (with IPs) and projects as JSON', async () => {
    const cid = await mkClient('Export Me', '9222222222', 'exp@example.com'); const q = await mkQuote(cid, 'Export Me'); const t = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; await fetch(`${BASE}/api/public.php?r=quote&t=${t}`);
    const r = await admin.api('GET', `clients/${cid}/export`); eq(r.status, 200); ok(r.data.client.name === 'Export Me' && r.data.quotes.length === 1 && r.data.events.some(e => e.type === 'view' && 'ip' in e), 'content'); ok(!JSON.stringify(r.data).includes('password_hash'), 'no secrets');
  });
  await test('erasing requires explicit confirmation', async () => { const cid = await mkClient('Needs Confirm', '9333333333', 'c@x.com'); eq((await admin.api('POST', `clients/${cid}/anonymize`, {})).status, 400); });
  await test('full erase (no financial records): name, contact, address, quotes, links and activity are wiped', async () => {
    const cid = await mkClient('Erase Fully', '9444444444', 'full@example.com'); const q = await mkQuote(cid, 'Erase Fully'); const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`);
    const r = await admin.api('POST', `clients/${cid}/anonymize`, { confirm: true }); eq(r.data.mode, 'full');
    const c = (await admin.api('GET', `clients&per=5&q=${encodeURIComponent('Erased client #' + cid)}`)).data.rows[0]; eq(c.phone, ''); eq(c.email, ''); eq(c.address, ''); eq(c.gstin, ''); eq(c.anonymized, 1);
    const qq = (await admin.api('GET', `quotes/${q.id}`)).data; eq(qq.quote.client.email, ''); eq(qq.quote.client.phone, ''); ok(/Erased client/.test(qq.quote.client.name)); eq(qq.events.length, 0, 'activity removed'); eq((await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`)).status, 404, 'client link revoked');
  });
  await test('partial erase (accepted quote exists): contact details go, name / address / GSTIN stay for tax records', async () => {
    const cid = await mkClient('Erase Partly', '9555555555', 'part@example.com'); const q = await mkQuote(cid, 'Erase Partly'); const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; const total = (await admin.api('GET', `quotes/${q.id}`)).data.quote.total;
    await fetch(`${BASE}/api/public.php?r=respond&t=${tok}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', name: 'Buyer', expected_total: total }) });
    const r = await admin.api('POST', `clients/${cid}/anonymize`, { confirm: true }); eq(r.data.mode, 'partial'); ok(/tax law/.test(r.data.note));
    const qq = (await admin.api('GET', `quotes/${q.id}`)).data.quote; eq(qq.client.name, 'Erase Partly'); eq(qq.client.phone, ''); eq(qq.client.email, ''); eq(qq.client.contact_person, ''); eq(qq.client.address, '1 Test Road');
    const c = (await admin.api('GET', `clients&per=5&q=${encodeURIComponent('Erase Partly')}`)).data.rows[0]; eq(c.phone, ''); eq(c.gstin, '29ABCDE1234F1Z5');
  });
  await test('erasures are recorded in the audit log', async () => { const a = (await admin.api('GET', 'audit')).data; ok(a.some(x => x.action === 'client.anonymize') && a.some(x => x.action === 'client.export')); });

  console.log('\nLink expiry');
  await test('an unaccepted link stops working 60 days after the quote expires; an accepted one stays viewable', async () => {
    const cid = await mkClient('Expiry Co', '9666666666', 'e@example.com'); const q = await mkQuote(cid, 'Expiry Co'); const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token;
    eq((await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`)).status, 200);
    const old = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10); db('UPDATE quotes SET valid_until = ? WHERE id = ?', [old, q.id]); eq((await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`)).status, 410, 'expired link');
    db("UPDATE quotes SET status = 'accepted' WHERE id = ?", [q.id]); eq((await fetch(`${BASE}/api/public.php?r=quote&t=${tok}`)).status, 200, 'accepted stays viewable');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
