'use strict';
/* Invoices, credit notes, cancellations, receipts, e-invoice references. Usage: BASE=... node tests/billing.test.js */
const { Client } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, m = '') => { if (Math.abs(a - b) > 0.011) throw new Error(`${m} expected ~${b} got ${a}`); };

(async () => {
  console.log(`Billing tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  await admin.api('PUT', 'settings', { auto_project: '0' });   // these tests create projects by hand
  const staffEmail = `bill-staff-${Date.now()}@example.com`; const staff = new Client(BASE);
  await admin.api('POST', 'users', { name: 'Staff', email: staffEmail, password: 'staffpass1', role: 'staff' }); await staff.api('POST', 'auth/login', { email: staffEmail, password: 'staffpass1' });

  // project: total 11,800 (10,000 + 18% GST), three stages 50 / 30 / 20
  const q = (await admin.api('POST', 'quotes', { division: 'construction', client: { name: 'Billing Co', gstin: '29ABCDE1234F1Z5' }, title: 'Billing test', data: { sections: [{ title: 'S', items: [{ desc: 'Work', unit: 'lot', qty: 1, rate: 10000 }] }], tax_rate: 18, payment_schedule: [{ label: 'Advance', percent: 50 }, { label: 'Progress', percent: 30 }, { label: 'Handover', percent: 20 }] } })).data;
  const tok = (await admin.api('POST', `quotes/${q.id}/share`)).data.token;
  eq((await fetch(`${BASE}/api/public.php?r=respond&t=${tok}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', name: 'Buyer', expected_total: 11800 }) })).status, 200);
  const pid = (await admin.api('POST', 'projects', { quote_id: q.id })).data.id;
  const detail = async () => (await admin.api('GET', `projects/${pid}`)).data;
  const ms = (await detail()).milestones; const [A, B, C] = ms;
  const inv = id => admin.api('POST', `projects/${pid}/milestones/${id}/invoice`);

  console.log('\nInvoices');
  await test('invoices are numbered sequentially', async () => {
    await inv(A.id); await inv(B.id); const d = await detail(); const [a, b] = d.milestones;
    ok(/\/INV\/\d\d-\d\d\/0001$/.test(a.invoice_no) && /\/0002$/.test(b.invoice_no), a.invoice_no + ' ' + b.invoice_no);
  });
  await test('e-invoice references are validated and stored; bad IRN refused', async () => {
    eq((await admin.api('POST', `projects/${pid}/milestones/${A.id}/einvoice`, { irn: 'abc123' })).status, 400); eq((await admin.api('POST', `projects/${pid}/milestones/${C.id}/einvoice`, { irn: 'a'.repeat(64) })).status, 409, 'not invoiced yet');
    const irn = 'a1b2c3d4'.repeat(8); eq((await admin.api('POST', `projects/${pid}/milestones/${A.id}/einvoice`, { irn, ack_no: '112010000012345', ack_date: '2026-11-03' })).status, 200);
    const m = (await detail()).milestones[0]; eq(m.irn, irn); eq(m.ack_no, '112010000012345');
  });

  console.log('\nPayment receipts');
  await test('each payment gets a unique sequential receipt number', async () => {
    const r1 = await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: A.id, amount: 1000, mode: 'UPI', reference: 'UTR1' }); const r2 = await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: A.id, amount: 500 });
    eq(r1.status, 201); const rc = (await detail()).receipts; ok(/\/RC\/\d\d-\d\d\/0001$/.test(rc[0].receipt_no) && /\/0002$/.test(rc[1].receipt_no), JSON.stringify(rc.map(r => r.receipt_no)));
  });
  await test('staff cannot delete a recorded payment', async () => { const rid = (await detail()).receipts[1].id; eq((await staff.api('DELETE', `projects/${pid}/receipts/${rid}`)).status, 403); });

  console.log('\nCancelling an invoice');
  await test('only an admin can cancel; a reason is mandatory', async () => {
    eq((await staff.api('POST', `projects/${pid}/milestones/${B.id}/cancel-invoice`, { reason: 'x' })).status, 403); eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/cancel-invoice`, {})).status, 400);
  });
  await test('an invoice with payments cannot be cancelled', async () => eq((await admin.api('POST', `projects/${pid}/milestones/${A.id}/cancel-invoice`, { reason: 'wrong client' })).status, 409));
  await test('cancelling keeps the number on record and a re-issued invoice gets a NEW number (no reuse, no gaps hidden)', async () => {
    const before = (await detail()).milestones[1].invoice_no; eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/cancel-invoice`, { reason: 'Wrong amount' })).status, 200);
    const d = await detail(); eq(d.milestones[1].invoice_no, null); eq(d.invoice_history.length, 1); eq(d.invoice_history[0].invoice_no, before); eq(d.invoice_history[0].status, 'cancelled'); eq(d.invoice_history[0].reason, 'Wrong amount');
    await inv(B.id); const again = (await detail()).milestones[1].invoice_no; ok(again !== before && /\/0003$/.test(again), `re-issued as ${again} (was ${before})`);
  });
  await test('cancelling clears the e-invoice reference so a stale IRN is never printed', async () => {
    await inv(C.id); await admin.api('POST', `projects/${pid}/milestones/${C.id}/einvoice`, { irn: 'f'.repeat(64) }); const r = await admin.api('POST', `projects/${pid}/milestones/${C.id}/cancel-invoice`, { reason: 'Issued early' });
    eq(r.status, 200); ok(/IRN/.test(r.data.note), 'warns to cancel the IRN on the portal'); eq((await detail()).milestones[2].irn, null);
  });

  console.log('\nCredit notes');
  await test('only an admin can issue a credit note, only against an invoiced milestone, with a reason', async () => {
    eq((await staff.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 100, reason: 'x' })).status, 403);
    eq((await admin.api('POST', `projects/${pid}/milestones/${C.id}/credit-note`, { amount: 100, reason: 'x' })).status, 409, 'not invoiced');
    eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 100 })).status, 400, 'no reason'); eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 0, reason: 'x' })).status, 400, 'zero');
  });
  await test('a credit note cannot exceed the invoice value', async () => eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 99999, reason: 'too much' })).status, 400));
  await test('a partial credit note reduces the milestone, the contract and the outstanding amount', async () => {
    const before = await detail(); const r = await admin.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 354, reason: 'Sheeting not executed' }); eq(r.status, 201);
    const d = await detail(); near(d.totals.contract, before.totals.contract - 354, 'contract'); near(d.totals.outstanding, before.totals.outstanding - 354, 'outstanding'); near(d.milestones[1].net, d.milestones[1].amount - 354, 'net'); eq(d.totals.credits, 354);
    ok(/\/CN\/\d\d-\d\d\/0001$/.test(d.credit_notes[0].credit_no), d.credit_notes[0].credit_no);
  });
  await test('payments cannot exceed what is owed after credits', async () => {
    const m = (await detail()).milestones[1]; eq((await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: m.id, amount: m.net + 1 })).status, 400);
    eq((await admin.api('POST', `projects/${pid}/receipts`, { milestone_id: m.id, amount: m.net })).status, 201); eq((await detail()).milestones[1].state, 'paid');
  });
  await test('a credit that would leave the client over-paid is refused', async () => eq((await admin.api('POST', `projects/${pid}/milestones/${B.id}/credit-note`, { amount: 100, reason: 'late' })).status, 409));
  await test('a fully credited unpaid invoice shows as credited and drops out of overdue', async () => {
    await inv(C.id); await admin.api('PUT', `projects/${pid}/milestones/${C.id}`, { label: 'Handover', amount: (await detail()).milestones[2].amount, due_date: '2020-01-01' });
    ok((await detail()).milestones[2].overdue === true, 'overdue before credit'); const full = (await detail()).milestones[2].amount;
    eq((await admin.api('POST', `projects/${pid}/milestones/${C.id}/credit-note`, { amount: full, reason: 'Scope removed' })).status, 201); const m = (await detail()).milestones[2]; eq(m.state, 'credited'); eq(m.overdue, false);
  });
  await test('an invoice that has a credit note cannot be cancelled', async () => eq((await admin.api('POST', `projects/${pid}/milestones/${C.id}/cancel-invoice`, { reason: 'x' })).status, 409));
  await test('credit-note numbers are sequential', async () => { const cn = (await detail()).credit_notes; ok(/\/0001$/.test(cn[0].credit_no) && /\/0002$/.test(cn[1].credit_no), JSON.stringify(cn.map(c => c.credit_no))); });
  await test('dashboard receivables reflect credit notes', async () => {
    const d = (await detail()); const r = (await admin.api('GET', 'projects')).data; const p = r.projects.find(x => x.id === pid); near(p.contract, d.totals.contract, 'list contract'); near(r.summary.contract >= p.contract ? p.contract : -1, d.totals.contract);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
