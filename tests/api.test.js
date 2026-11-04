'use strict';
/* API / workflow regression tests. No dependencies (Node 18+).
   Usage:  BASE=http://127.0.0.1:8766 node tests/api.test.js   (see tests/run.sh) */

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0; const failures = [];

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, opt = {}) {
    const headers = { ...(opt.noXrw ? {} : { 'X-Requested-With': 'infraura' }) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(`${BASE}/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    let data = null; const text = await res.text(); try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data };
  }
  api(method, route, body, opt) { return this.call(method, `api/index.php?r=${route}`, body, opt); }
  pub(method, act, tok, body) { return this.call(method, `api/public.php?r=${act}&t=${tok}`, body); }
  async login(email, password) { return this.api('POST', 'auth/login', { email, password }); }
}

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  FAIL ' + name + '\n         ' + (e.message || e)); }
}
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, m = '') => { if (Math.abs(a - b) > 0.011) throw new Error(`${m} expected ~${b} got ${a}`); };

const item = (desc, qty, rate, cost = 0) => ({ desc, unit: 'sq ft', qty, rate, cost });
const quoteBody = (over = {}) => ({
  division: 'roofing', client: { name: 'QA Client ' + Math.random().toString(36).slice(2, 7), phone: '9876543210' }, title: 'QA quote', quote_date: new Date().toISOString().slice(0, 10),
  data: { sections: [{ title: 'Roofing', items: [item('Sheet', 10, 100, 60)] }], discount: { type: 'percent', value: 0 }, tax_rate: 18, payment_schedule: [{ label: 'Advance', percent: 50 }, { label: 'Balance', percent: 50 }], terms: [] }, ...over,
});

(async () => {
  const admin = new Client(), anon = new Client(), staff = new Client();
  console.log(`Testing ${BASE}`);

  console.log('\nAuth & access');
  await test('unauthenticated API call returns 401', async () => eq((await anon.api('GET', 'bootstrap')).status, 401));
  await test('admin can sign in', async () => { const r = await admin.login(ADMIN.email, ADMIN.password); eq(r.status, 200); });
  await test('state-changing request without X-Requested-With is refused', async () => eq((await admin.api('POST', 'clients', { name: 'x' }, { noXrw: true })).status, 403));
  const staffEmail = `qa-staff-${Date.now()}@example.com`;
  await test('admin can add a staff user, staff can sign in', async () => {
    eq((await admin.api('POST', 'users', { name: 'QA Staff', email: staffEmail, password: 'staffpass123', role: 'staff' })).status, 201);
    eq((await staff.login(staffEmail, 'staffpass123')).status, 200);
  });
  await test('staff cannot change settings', async () => eq((await staff.api('PUT', 'settings', { company_name: 'Hacked' })).status, 403));
  await test('staff cannot edit rate cards', async () => eq((await staff.api('POST', 'rates', { division: 'roofing', name: 'x', rate: 1 })).status, 403));
  await test('staff cannot download backup or read audit log', async () => { eq((await staff.api('GET', 'backup')).status, 403); eq((await staff.api('GET', 'audit')).status, 403); });
  await test('staff cannot manage users', async () => eq((await staff.api('GET', 'users')).status, 403));
  await test('repeated wrong passwords lock the account temporarily (429)', async () => {
    const c = new Client(); let last = 0;
    for (let i = 0; i < 8; i++) last = (await c.login(`nobody-${staffEmail}`, 'wrong-password')).status;
    eq(last, 429, 'after 8 failures');
  });

  console.log('\nQuotes & totals');
  let q1;
  await test('create quote computes GST total on the server', async () => {
    const r = await admin.api('POST', 'quotes', quoteBody()); eq(r.status, 201); q1 = r.data;
    const g = await admin.api('GET', `quotes/${q1.id}`); near(g.data.quote.total, 1180); near(g.data.quote.tax, 180);
  });
  await test('percentage discount is applied before GST', async () => {
    const b = quoteBody(); b.data.discount = { type: 'percent', value: 10 };
    const r = await admin.api('POST', 'quotes', b); const g = await admin.api('GET', `quotes/${r.data.id}`); near(g.data.quote.total, 1062);
  });
  await test('absurdly large totals are rejected cleanly (not a 500)', async () => {
    const b = quoteBody(); b.data.sections[0].items = [item('Huge', 1e12, 1e12)];
    const r = await admin.api('POST', 'quotes', b); eq(r.status, 400);
  });
  await test('negative quantities are rejected', async () => {
    const b = quoteBody(); b.data.sections[0].items = [item('Neg', -5, 100)];
    eq((await admin.api('POST', 'quotes', b)).status, 400);
  });
  await test('oversized payload is rejected', async () => {
    const b = quoteBody(); b.data.notes = 'x'.repeat(10); b.data.sections[0].items = Array.from({ length: 3000 }, (_, i) => item('Line ' + i, 1, 1));
    eq((await admin.api('POST', 'quotes', b)).status, 400);
  });
  await test('quote numbers are unique under concurrent creation', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => admin.api('POST', 'quotes', quoteBody())));
    ok(rs.every(r => r.status === 201), 'all created: ' + rs.map(r => r.status));
    eq(new Set(rs.map(r => r.data.quote_no)).size, 6, 'distinct quote numbers');
  });
  await test('SQL wildcard / injection characters in search are harmless', async () => {
    const r = await admin.api('GET', `quotes&q=${encodeURIComponent("%' OR 1=1 --")}`); eq(r.status, 200); ok(Array.isArray(r.data));
  });

  console.log('\nSharing & client acceptance');
  let share;
  await test('sharing marks the quote as sent and returns a token', async () => {
    const r = await admin.api('POST', `quotes/${q1.id}/share`); eq(r.status, 200); share = r.data.token; ok(/^[a-f0-9]{32}$/.test(share));
    eq((await admin.api('GET', `quotes/${q1.id}`)).data.quote.status, 'sent');
  });
  await test('public link never exposes internal cost data', async () => {
    const r = await anon.pub('GET', 'quote', share); eq(r.status, 200); ok(!JSON.stringify(r.data).includes('"cost"'), 'cost leaked'); ok(!JSON.stringify(r.data).includes('roofcalc'));
  });
  await test('invalid / unknown token gives 404', async () => { eq((await anon.pub('GET', 'quote', 'a'.repeat(32))).status, 404); eq((await anon.pub('GET', 'quote', 'zz')).status, 404); });
  await test('accept requires the visitor to type a name', async () => eq((await anon.pub('POST', 'respond', share, { action: 'accept', name: '', expected_total: 1180 })).status, 400));
  await test('accept is refused if the quote total changed since the client viewed it', async () => {
    const r = await anon.pub('POST', 'respond', share, { action: 'accept', name: 'Late Buyer', expected_total: 999 }); eq(r.status, 409);
  });
  await test('simultaneous double-accept results in exactly one acceptance', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => new Client().pub('POST', 'respond', share, { action: 'accept', name: 'Racer', expected_total: 1180 })));
    eq(rs.filter(r => r.status === 200).length, 1, 'statuses ' + rs.map(r => r.status));
    const ev = (await admin.api('GET', `quotes/${q1.id}`)).data.events.filter(e => e.type === 'accepted'); eq(ev.length, 1, 'accepted events');
  });
  await test('an accepted quote is locked against edits', async () => {
    const r = await admin.api('PUT', `quotes/${q1.id}`, quoteBody()); eq(r.status, 409);
  });
  await test('accepted quote total cannot be changed through status juggling to draft by staff', async () => {
    const r = await staff.api('POST', `quotes/${q1.id}/status`, { status: 'draft' }); eq(r.status, 403);
  });

  console.log('\nRevisions & draft exposure');
  let q2, tok2;
  await test('a revision that is still a draft is NOT visible/acceptable through the old client link', async () => {
    q2 = (await admin.api('POST', 'quotes', quoteBody())).data;
    tok2 = (await admin.api('POST', `quotes/${q2.id}/share`)).data.token;
    const rev = await admin.api('POST', `quotes/${q2.id}/revise`); eq(rev.status, 201);
    const r = await anon.pub('GET', 'quote', tok2); eq(r.status, 200);
    eq(r.data.quote.status, 'draft'); eq(r.data.available, false, 'available flag');
    ok(!r.data.quote.data.sections.length || r.data.quote.data.sections.every(s => !s.items.length), 'draft line items must not be sent to the client');
    eq((await anon.pub('POST', 'respond', tok2, { action: 'accept', name: 'Sneaky', expected_total: 1180 })).status, 409);
  });
  await test('share link can be revoked', async () => {
    const q = (await admin.api('POST', 'quotes', quoteBody())).data; const t = (await admin.api('POST', `quotes/${q.id}/share`)).data.token;
    eq((await admin.api('DELETE', `quotes/${q.id}/share`)).status, 200); eq((await anon.pub('GET', 'quote', t)).status, 404);
  });
  await test('deleting a draft quote removes its share link and events', async () => {
    const q = (await admin.api('POST', 'quotes', quoteBody())).data; const t = (await admin.api('POST', `quotes/${q.id}/share`)).data.token;
    await admin.api('POST', `quotes/${q.id}/status`, { status: 'draft' });
    eq((await admin.api('DELETE', `quotes/${q.id}`)).status, 200); eq((await anon.pub('GET', 'quote', t)).status, 404);
  });

  console.log('\nProjects, billing & payments');
  let pid, ms;
  await test('accepted quote converts to a project; milestones add up to the exact total', async () => {
    const b = quoteBody(); b.data.sections[0].items = [item('Odd total', 7, 333.33)]; b.data.payment_schedule = [{ label: 'A', percent: 33.33 }, { label: 'B', percent: 33.33 }, { label: 'C', percent: 33.34 }];
    const q = (await admin.api('POST', 'quotes', b)).data; const t = (await admin.api('POST', `quotes/${q.id}/share`)).data.token;
    const total = (await admin.api('GET', `quotes/${q.id}`)).data.quote.total;
    eq((await anon.pub('POST', 'respond', t, { action: 'accept', name: 'Buyer', expected_total: total })).status, 200);
    const p = await admin.api('POST', 'projects', { quote_id: q.id }); eq(p.status, 201); pid = p.data.id;
    const d = (await admin.api('GET', `projects/${pid}`)).data; ms = d.milestones;
    near(ms.reduce((s, m) => s + m.amount, 0), total, 'milestone sum vs quote total');
    eq((await admin.api('POST', 'projects', { quote_id: q.id })).status, 400, 'second conversion');
  });
  await test('a quote with a project cannot be revised (use variation orders)', async () => {
    const q = (await admin.api('GET', 'projects/' + pid)).data.quote; eq((await admin.api('POST', `quotes/${q.id}/revise`)).status, 409);
  });
  await test('receipts above the milestone balance are rejected', async () => {
    const m = ms[0]; eq((await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: m.id, amount: m.amount + 500 })).status, 400);
  });
  await test('a valid part-payment is accepted and shows as part-paid', async () => {
    const m = ms[0]; eq((await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: m.id, amount: 100 })).status, 201);
    eq((await admin.api('GET', `projects/${pid}`)).data.milestones[0].state, 'part');
  });
  await test('an invoiced milestone cannot have its amount edited', async () => {
    const m = ms[1]; eq((await admin.api('POST', `projects/${pid}/milestones/${m.id}/invoice`)).status, 200);
    eq((await admin.api('PUT', `projects/${pid}/milestones/${m.id}`, { label: m.label, amount: 1, due_date: '' })).status, 409);
  });
  await test('invoice numbers are sequential and never reused', async () => {
    await admin.api('POST', `projects/${pid}/milestones/${ms[2].id}/invoice`);
    const nos = (await admin.api('GET', `projects/${pid}`)).data.milestones.map(m => m.invoice_no).filter(Boolean); eq(new Set(nos).size, nos.length, 'unique'); eq(nos.length, 2);
  });
  await test('a client with a project cannot be deleted', async () => {
    const cid = (await admin.api('GET', `projects/${pid}`)).data.project.client_id; eq((await admin.api('DELETE', `clients/${cid}`)).status, 400);
  });
  await test('milestone with receipts cannot be deleted', async () => eq((await admin.api('DELETE', `projects/${pid}/milestones/${ms[0].id}`)).status, 400));

  console.log('\nConcurrency & data safety');
  await test('two people editing: the second save is refused instead of silently overwriting', async () => {
    const q = (await admin.api('POST', 'quotes', quoteBody())).data; const g = (await admin.api('GET', `quotes/${q.id}`)).data.quote;
    await new Promise(r => setTimeout(r, 1100)); // timestamps have 1-second resolution
    const first = await admin.api('PUT', `quotes/${q.id}`, { ...quoteBody(), updated_at: g.updated_at }); eq(first.status, 200); ok(first.data.updated_at, 'returns new timestamp');
    const stale = await admin.api('PUT', `quotes/${q.id}`, { ...quoteBody(), updated_at: g.updated_at }); eq(stale.status, 409);
    const fresh = await admin.api('PUT', `quotes/${q.id}`, { ...quoteBody(), updated_at: first.data.updated_at }); eq(fresh.status, 200);
  });
  await test('emoji and unicode survive a round trip (utf8mb4)', async () => {
    const b = quoteBody({ title: 'Villa 🏠 नमस्ते ₹' }); const q = (await admin.api('POST', 'quotes', b)).data;
    eq((await admin.api('GET', `quotes/${q.id}`)).data.quote.title, 'Villa 🏠 नमस्ते ₹');
  });
  await test('rate-card import skips duplicates and rejects bad rows without importing anything', async () => {
    const good = { division: 'roofing', category: 'QA', name: 'QA item ' + Date.now(), unit: 'nos', rate: 10 };
    const bad = await admin.api('POST', 'rates/import', { items: [good, { division: 'nonsense', name: 'bad', rate: 1 }] }); eq(bad.status, 400);
    const r1 = await admin.api('POST', 'rates/import', { items: [good, good] }); eq(r1.data.imported, 1); eq(r1.data.skipped, 1);
    const r2 = await admin.api('POST', 'rates/import', { items: [good] }); eq(r2.data.imported, 0);
  });
  await test('totals with flat discount, round-off and non-18% GST match across edits', async () => {
    const b = quoteBody(); b.data.sections[0].items = [item('A', 3, 333.33), item('B', 1.5, 99.99)]; b.data.discount = { type: 'flat', value: 77.77 }; b.data.tax_rate = 12; b.data.round_off = true;
    const q = (await admin.api('POST', 'quotes', b)).data; const g = (await admin.api('GET', `quotes/${q.id}`)).data.quote;
    const sub = Math.round((3 * 333.33 + 1.5 * 99.99) * 100) / 100, taxable = sub - 77.77, tax = Math.round(taxable * 12) / 100;
    near(g.subtotal, sub, 'subtotal'); near(g.tax, tax, 'tax'); eq(g.total, Math.round(taxable + tax), 'rounded total');
  });

  console.log('\nSettings validation');
  await test('non-numeric validity days / negative margin are rejected', async () => {
    eq((await admin.api('PUT', 'settings', { validity_days: 'abc' })).status, 400);
    eq((await admin.api('PUT', 'settings', { min_margin: '-5' })).status, 400);
  });

  console.log('\nPublic endpoint abuse');
  await test('public endpoint is rate-limited (429 after heavy polling)', async () => {
    const c = new Client(); let last = 0;
    for (let i = 0; i < 260; i++) { last = (await c.pub('GET', 'quote', 'b'.repeat(32))).status; if (last === 429) break; }
    eq(last, 429);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
