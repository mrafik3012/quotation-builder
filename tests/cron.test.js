'use strict';
/* Scheduled jobs, backups, health endpoint. Needs APP_DIR (the app folder the server runs from) to age records.
   Usage: APP_DIR=/path/to/app BASE=http://127.0.0.1:8766 node tests/cron.test.js */
const { startSmtp, parseMail, Client } = require('./helpers');
const zlib = require('zlib'), { execFileSync } = require('child_process'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8766', APP_DIR = process.env.APP_DIR;
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const db = (sql, params = []) => JSON.parse(execFileSync('php', [path.join(__dirname, 'dbtool.php'), APP_DIR, sql, JSON.stringify(params)]).toString());
const ago = days => new Date(Date.now() - days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 19).replace('T', ' '); // server time is IST

(async () => {
  if (!APP_DIR) { console.log('APP_DIR not set - skipping cron tests'); process.exit(0); }
  console.log(`Cron / backup / health tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  const smtp = await startSmtp();
  await admin.api('PUT', 'settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_enc: 'none', smtp_user: '', smtp_pass: '', mail_from: 'quotes@example.com', client_reminders: '1', backup_keep: '2' });
  const key = (await admin.api('GET', 'settings')).data.cron_key; ok(/^[a-f0-9]{32}$/.test(key), 'cron key exists for admin');
  const cron = (k, extra = '') => fetch(`${BASE}/api/cron.php?key=${k}${extra}`).then(async r => ({ status: r.status, text: await r.text() }));
  const mkQuote = async (name, email, title) => (await admin.api('POST', 'quotes', { division: 'roofing', client: { name, email }, title, data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 10, rate: 100 }] }], tax_rate: 18, payment_schedule: [{ label: 'Advance', percent: 50 }, { label: 'Balance', percent: 50 }] } })).data;

  console.log('\nAccess control');
  await test('cron refuses requests without the right key', async () => { eq((await cron('')).status, 403); eq((await cron('0'.repeat(32))).status, 403); });
  await test('staff cannot see the cron key', async () => {
    const email = `cron-staff-${Date.now()}@example.com`; await admin.api('POST', 'users', { name: 'S', email, password: 'staffpass1', role: 'staff' }); const s = new Client(BASE); await s.api('POST', 'auth/login', { email, password: 'staffpass1' });
    ok(!('cron_key' in (await s.api('GET', 'settings')).data)); eq((await s.api('GET', 'system')).status, 403);
  });

  console.log('\nBackups');
  await test('forced run writes a compressed backup that contains data but no secrets', async () => {
    const r = await cron(key, '&force=1'); eq(r.status, 200); ok(/backup: wrote backup-\d{8}-\d{6}-[a-f0-9]{16}\.json\.gz/.test(r.text), r.text);
    const sys = (await admin.api('GET', 'system')).data; ok(sys.backups.length >= 1 && sys.cron_last_run, 'listed');
    const dl = await fetch(`${BASE}/api/index.php?r=system/backup/${sys.backups[0].name}`, { headers: { Cookie: admin.cookie } }); eq(dl.status, 200);
    const data = JSON.parse(zlib.gunzipSync(Buffer.from(await dl.arrayBuffer())).toString()); ok(Array.isArray(data.quotes) && Array.isArray(data.clients) && data.users.length >= 1, 'tables present');
    ok(!JSON.stringify(data).includes('password_hash') && data.settings.find(s => s.k === 'cron_key').v === '', 'no secrets in backup'); ok(!('totp_secret' in data.users[0]), 'no 2FA secrets');
  });
  await test('backup file names cannot be used to read other files', async () => {
    for (const bad of ['../config.php', '..%2fconfig.php', 'backup-1.json.gz', 'x']) eq((await fetch(`${BASE}/api/index.php?r=system/backup/${bad}`, { headers: { Cookie: admin.cookie } })).status >= 400, true, bad);
  });
  await test('only the newest N backups are kept (here N = 2)', async () => {
    for (let i = 0; i < 3; i++) { await admin.api('POST', 'system/backup'); await wait(1100); }
    eq((await admin.api('GET', 'system')).data.backups.length, 2);
  });
  await test('backups are not downloadable straight from the web', async () => {
    const name = (await admin.api('GET', 'system')).data.backups[0].name; ok(/-[a-f0-9]{16}\.json\.gz$/.test(name), 'file name carries a random suffix: ' + name);
    const guess = name.replace(/-[a-f0-9]{16}/, ''); eq((await fetch(`${BASE}/api/data/backups/${guess}`)).status === 200, false, 'guessable name must not exist');
  });

  console.log('\nDaily digest');
  let follow, overdueProj;
  await test('digest e-mails admins about stale quotes and overdue payments', async () => {
    follow = await mkQuote('Slow Client', 'slow@example.com', 'Stale quote'); await admin.api('POST', `quotes/${follow.id}/share`);
    db('UPDATE quotes SET updated_at = ? WHERE id = ?', [ago(5), follow.id]);
    const pq = await mkQuote('Overdue Co', 'od@example.com', 'Overdue job'); const tok = (await admin.api('POST', `quotes/${pq.id}/share`)).data.token; const tot = (await admin.api('GET', `quotes/${pq.id}`)).data.quote.total;
    await fetch(`${BASE}/api/public.php?r=respond&t=${tok}`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', name: 'Buyer', expected_total: tot }) });
    overdueProj = (await admin.api('POST', 'projects', { quote_id: pq.id })).data.id; const ms = (await admin.api('GET', `projects/${overdueProj}`)).data.milestones[0];
    eq((await admin.api('PUT', `projects/${overdueProj}/milestones/${ms.id}`, { label: ms.label, amount: ms.amount, due_date: ago(10).slice(0, 10) })).status, 200);
    const before = smtp.messages.length; const r = await cron(key, '&force=1'); ok(/digest: \d+ item/.test(r.text), r.text); await wait(200);
    const mails = smtp.messages.slice(before).filter(m => m.to[0] === ADMIN.email); ok(mails.length === 1, 'one digest to the admin'); const h = parseMail(mails[0].raw);
    ok(/need attention/.test(h.subject), h.subject); ok(h.html.includes(follow.quote_no), 'stale quote listed'); ok(/Overdue job/.test(h.html) && /Overdue payments/.test(h.html), 'overdue payment listed');
  });
  await test('the digest is not repeated within the day unless forced', async () => {
    const before = smtp.messages.length; const r = await cron(key); ok(/digest: not due/.test(r.text), r.text); await wait(100); eq(smtp.messages.length, before);
  });

  console.log('\nClient reminders (opt-in)');
  await test('a polite reminder goes to the client after 3 days, a second after 4 more, never a third', async () => {
    const q = await mkQuote('Remind Me Ltd', 'remind@example.com', 'Reminder quote'); await admin.api('POST', `quotes/${q.id}/email`, { to: 'remind@example.com' }); await wait(100);
    const fresh = () => smtp.messages.filter(m => m.to[0] === 'remind@example.com' && /Reminder:/.test(parseMail(m.raw).subject)).length;
    await cron(key, '&force=1'); await wait(100); eq(fresh(), 0, 'too early for a reminder');
    db('UPDATE quote_events SET created_at = ? WHERE quote_no = ?', [ago(4), q.quote_no]); db('UPDATE quotes SET updated_at = ? WHERE id = ?', [ago(4), q.id]);
    await cron(key, '&force=1'); await wait(150); eq(fresh(), 1, 'first reminder'); await cron(key, '&force=1'); await wait(100); eq(fresh(), 1, 'no duplicate on the same day');
    const m = parseMail(smtp.messages.filter(x => x.to[0] === 'remind@example.com').at(-1).raw); ok(/gentle reminder/i.test(m.text) && /view\.html\?t=[a-f0-9]{32}/.test(m.html), 'reminder content');
    db("UPDATE quote_events SET created_at = ? WHERE quote_no = ? AND type = 'reminder'", [ago(5), q.quote_no]); await cron(key, '&force=1'); await wait(150); eq(fresh(), 2, 'second reminder');
    db("UPDATE quote_events SET created_at = ? WHERE quote_no = ? AND type = 'reminder'", [ago(9), q.quote_no]); await cron(key, '&force=1'); await wait(100); eq(fresh(), 2, 'never a third');
  });
  await test('clients are not reminded when reminders are off', async () => {
    await admin.api('PUT', 'settings', { client_reminders: '0' }); const q = await mkQuote('Quiet Ltd', 'quiet@example.com', 'q'); await admin.api('POST', `quotes/${q.id}/email`, { to: 'quiet@example.com' });
    db('UPDATE quote_events SET created_at = ? WHERE quote_no = ?', [ago(6), q.quote_no]); db('UPDATE quotes SET updated_at = ? WHERE id = ?', [ago(6), q.id]); const n = smtp.messages.length; await cron(key, '&force=1'); await wait(150);
    eq(smtp.messages.slice(n).filter(m => m.to[0] === 'quiet@example.com').length, 0);
  });

  console.log('\nHealth endpoint');
  await test('public health answers ok without exposing details', async () => { const r = await fetch(`${BASE}/api/health.php`); eq(r.status, 200); const j = await r.json(); eq(j.status, 'ok'); ok(!('schema' in j) && !('errors_24h' in j), 'no details without key'); });
  await test('health with the key reports backup age, cron and error counts', async () => {
    const j = await (await fetch(`${BASE}/api/health.php?key=${key}`)).json(); ok(j.last_backup_hours !== null && j.last_backup_hours < 1, 'fresh backup'); ok(j.cron_last_run && j.cron_overdue === false, 'cron ran'); ok(typeof j.errors_24h === 'number' && j.schema >= 7);
  });

  smtp.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
